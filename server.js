require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./database");

const app = express();
app.use(cors());
app.use(express.json());

function timeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function generateSubSlots(sessionStart, sessionEnd, durationMinutes) {
  const slots = [];
  let current = timeToMinutes(sessionStart);
  const end = timeToMinutes(sessionEnd);

  while (current + durationMinutes <= end) {
    slots.push({
      slot_start: minutesToTime(current),
      slot_end: minutesToTime(current + durationMinutes),
    });
    current += durationMinutes;
  }

  return slots;
}

function getBangkokNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" })
  );
}

// Test endpoint
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// Test database connection
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("test-db error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Login endpoint
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const rawUsername = String(username).trim();
    const formattedHN = rawUsername.startsWith("HN")
      ? rawUsername
      : `HN${rawUsername}`;

    const user = await pool.query(
      "SELECT * FROM patients WHERE (hn = $1 OR hn = $2) AND password = $3",
      [rawUsername, formattedHN, password]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid login",
      });
    }

    res.json({
      message: "login success",
      user: user.rows[0],
    });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Services endpoint
app.get("/services", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        service_id,
        service_name,
        department,
        location,
        status,
        duration_minutes
      FROM services
      ORDER BY service_id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching services:", error);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

// Appointments list
app.get("/appointments", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM appointments
      ORDER BY appointment_date ASC, COALESCE(slot_start, '00:00'::time) ASC, created_at ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("appointments list error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Old create appointment endpoint (kept for compatibility)
app.post("/appointments", async (req, res) => {
  try {
    const { patient_name, service_name, appointment_date, time_slot } = req.body;

    const result = await pool.query(
      `INSERT INTO appointments
       (patient_name, service_name, appointment_date, time_slot)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [patient_name, service_name, appointment_date, time_slot]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("old appointments create error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get available slots by service, room, date
app.get("/available-slots", async (req, res) => {
  const { service_id, room_id, date } = req.query;

  if (!service_id || !room_id || !date) {
    return res.status(400).json({
      message: "service_id, room_id, and date are required",
    });
  }

  try {
    const serviceResult = await pool.query(
      `
      SELECT service_id, service_name, duration_minutes
      FROM services
      WHERE service_id = $1
      `,
      [service_id]
    );

    if (serviceResult.rows.length === 0) {
      return res.status(404).json({ message: "Service not found" });
    }

    const service = serviceResult.rows[0];

    if (!service.duration_minutes) {
      return res.status(400).json({
        message: "Service duration_minutes is missing",
      });
    }

    const sessionResult = await pool.query(
      `
      SELECT id, room_id, start_time::text, end_time::text
      FROM room_sessions
      WHERE room_id = $1
      ORDER BY start_time ASC
      `,
      [room_id]
    );

    const sessions = sessionResult.rows;

    if (sessions.length === 0) {
      return res.status(404).json({ message: "No sessions found for this room" });
    }

    const bookingResult = await pool.query(
      `
      SELECT slot_start::text, slot_end::text
      FROM appointments
      WHERE room_id = $1
        AND service_id = $2
        AND appointment_date = $3
        AND status = 'booked'
      `,
      [room_id, service_id, date]
    );

    const bookings = bookingResult.rows;
    const now = getBangkokNow();

    const result = sessions.map((session) => {
      const start = session.start_time.slice(0, 5);
      const end = session.end_time.slice(0, 5);

      const totalMinutes = timeToMinutes(end) - timeToMinutes(start);
      const capacity = Math.floor(totalMinutes / service.duration_minutes);

      const reservedCount = bookings.filter((booking) => {
        const bookingStart = booking.slot_start.slice(0, 5);
        return bookingStart >= start && bookingStart < end;
      }).length;

      const availableCount = capacity - reservedCount;
      const sessionStartDateTime = new Date(`${date}T${start}:00`);

      let status = "available";

      // ถ้าถึงเวลาเริ่ม session แล้ว -> กดไม่ได้
      if (now >= sessionStartDateTime) {
        status = "expired";
      } else if (availableCount <= 0) {
        status = "reserved";
      } else {
        status = "available";
      }

      return {
        room_id: Number(room_id),
        service_id: service.service_id,
        service_name: service.service_name,
        duration_minutes: service.duration_minutes,
        session_start: start,
        session_end: end,
        capacity,
        reserved_count: reservedCount,
        available_count: availableCount,
        status,
      };
    });

    res.json(result);
  } catch (error) {
    console.error("Error fetching available slots:", error);
    res.status(500).json({
      message: "Server error",
      detail: error.message,
    });
  }
});

// Book first available sub-slot inside a selected session
app.post("/appointments/book", async (req, res) => {
  const {
    patient_id,
    patient_name,
    service_id,
    room_id,
    appointment_date,
    session_start,
    session_end,
  } = req.body;

  if (
    !service_id ||
    !room_id ||
    !appointment_date ||
    !session_start ||
    !session_end
  ) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const serviceResult = await client.query(
      `
      SELECT service_id, service_name, duration_minutes
      FROM services
      WHERE service_id = $1
      `,
      [service_id]
    );

    if (serviceResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Service not found" });
    }

    const service = serviceResult.rows[0];

    if (!service.duration_minutes) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Service duration_minutes is missing",
      });
    }

    const sessionStartDateTime = new Date(`${appointment_date}T${session_start}:00`);
    const now = getBangkokNow();

    if (now >= sessionStartDateTime) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "This time slot has already started or expired",
      });
    }

    const existingResult = await client.query(
      `
      SELECT slot_start::text, slot_end::text
      FROM appointments
      WHERE room_id = $1
        AND service_id = $2
        AND appointment_date = $3
        AND status = 'booked'
        AND slot_start >= $4
        AND slot_end <= $5
      ORDER BY slot_start ASC
      `,
      [room_id, service_id, appointment_date, session_start, session_end]
    );

    const existingBookings = existingResult.rows.map((row) => ({
      slot_start: row.slot_start.slice(0, 5),
      slot_end: row.slot_end.slice(0, 5),
    }));

    const allSubSlots = generateSubSlots(
      session_start,
      session_end,
      service.duration_minutes
    );

    const freeSlot = allSubSlots.find((slot) => {
      return !existingBookings.some(
        (booking) =>
          booking.slot_start === slot.slot_start &&
          booking.slot_end === slot.slot_end
      );
    });

    if (!freeSlot) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "This session is full" });
    }

    const insertResult = await client.query(
      `
      INSERT INTO appointments
      (
        patient_id,
        patient_name,
        service_id,
        service_name,
        room_id,
        appointment_date,
        time_slot,
        slot_start,
        slot_end,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        patient_id || null,
        patient_name || null,
        service_id,
        service.service_name,
        room_id,
        appointment_date,
        `${freeSlot.slot_start}-${freeSlot.slot_end}`,
        freeSlot.slot_start,
        freeSlot.slot_end,
        "booked",
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "Booking successful",
      appointment: insertResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Booking error full:", error);
    console.error("Booking error message:", error.message);
    console.error("Booking error stack:", error.stack);

    res.status(500).json({
      message: "Server error",
      detail: error.message,
    });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


