const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) console.error('DB Error:', err.message);
  else {
    console.log('✅ Connected to PostgreSQL');
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        password VARCHAR(100)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50),
        balance DECIMAL(12,2) DEFAULT 0.00
      );
    `, (err) => {
      release();
      if (err) console.error('Table Error:', err.message);
      else console.log('✅ Tables ready.');
    });
  }
});

// REGISTER
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
      [name, email.toLowerCase(), hashedPassword]
    );
    const userId = result.rows[0].id;
    
    await pool.query(
      `INSERT INTO accounts (user_id, type, balance) VALUES 
       ($1, 'checking', 6248.10), 
       ($1, 'savings', 18420.55), 
       ($1, 'brokerage', 9840.72), 
       ($1, 'loan', 5000.00)`,
      [userId]
    );
    res.json({ success: true, message: 'Account created.' });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already exists.' });
    res.status(500).json({ error: 'Database error.' });
  }
});

// LOGIN
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
    res.status(500).json({ error: 'Database error.' });
  }
});

// GET DASHBOARD DATA
app.get('/api/dashboard/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE user_id = $1', [req.params.id]);
    const balances = { checking: 0, savings: 0, brokerage: 0, loan: 0 };
    result.rows.forEach(acc => { balances[acc.type] = parseFloat(acc.balance); });
    res.json({ balances });
  } catch (err) {
    res.status(500).json({ error: 'Database error.' });
  }
});

// TRANSFER FUNDS
app.post('/api/transfer', async (req, res) => {
  const { userId, from, to, amount } = req.body;
  try {
    await pool.query('BEGIN');
    await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = $3`, [amount, userId, from]);
    await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = $3`, [amount, userId, to]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Transfer failed.' });
  }
});

// ADMIN USERS
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email FROM users ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error.' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));