require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./database");

const app = express();
app.use(cors());
app.use(express.json());

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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Add endpoints for appointments
app.get("/appointments", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM appointments
      ORDER BY appointment_date ASC, time_slot ASC
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    res.status(500).json({ error: err.message });
  }
});
// Add login endpoint
app.post("/login", async (req, res) => {
    res.send("Login endpoint is working");
  try {
    const { username, password } = req.body;

    const rawUsername = String(username).trim();
    const formattedHN = rawUsername.startsWith("HN") ? rawUsername : `HN${rawUsername}`;

    const user = await pool.query(
      "SELECT * FROM patients WHERE (hn = $1 OR hn = $2) AND password = $3",
      [rawUsername, formattedHN, password]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid login"
      });
    }

    res.json({
      message: "login success",
      user: user.rows[0]
    });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: err.message });
  }
});

//add endpoints for services
app.get("/services", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id,
        service_id,
        service_name,
        department,
        location,
        status
      FROM services
      ORDER BY service_id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching services:", error);
    res.status(500).json({ error: "Failed to fetch services" });
    }
});



const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

