const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(express.json());
// Serve your frontend files
app.use(express.static(path.join(__dirname, '../')));

// Connect to Render's PostgreSQL database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create users table automatically on startup
pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    email VARCHAR(100) UNIQUE,
    password VARCHAR(100)
  )
`).catch(err => console.log("Database error:", err));

// REGISTER API
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3)',
      [name, email.toLowerCase(), hashedPassword]
    );
    res.json({ success: true, message: 'Account created.' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists.' });
    res.status(500).json({ error: 'Server error.' });
  }
});

// LOGIN API
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    
    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(401).json({ error: 'Invalid credentials.' });
    
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Catch-all: Send index.html for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));