const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- DATABASE SETUP ---
pool.connect((err, client, release) => {
  if (err) console.error('DB Error:', err.message);
  else {
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, password VARCHAR(100), status VARCHAR(20) DEFAULT 'Active',
        has_bank BOOLEAN DEFAULT false, has_loan BOOLEAN DEFAULT false, has_investment BOOLEAN DEFAULT false,
        age INTEGER, address TEXT, ssn_last4 VARCHAR(4)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50), balance DECIMAL(12,2) DEFAULT 0.00
      );
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, amount DECIMAL(12,2), term_months INTEGER, interest_rate DECIMAL(5,2), status VARCHAR(50) DEFAULT 'Under Review', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, symbol VARCHAR(10), shares DECIMAL(10,4), purchase_price DECIMAL(12,2), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50), amount DECIMAL(12,2), status VARCHAR(20) DEFAULT 'Pending', reference VARCHAR(100), details TEXT, proof_image TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE, value TEXT
      );
    `, (err) => {
      release();
      if (err) console.error('Table Error:', err.message);
      else {
        pool.query(`INSERT INTO system_settings (key, value) VALUES 
          ('btc_address', 'bc1q...xanvia'), ('bank_name', 'Chase Bank'), ('bank_account', '123456789'), ('bank_routing', '021000021') 
          ON CONFLICT DO NOTHING`);
        console.log('✅ Database & Settings ready.');
      }
    });
  }
});

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id', [name, email.toLowerCase(), hashedPassword]);
    res.json({ success: true, userId: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: 'Email may already exist.' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    if (user.status === 'Flagged') {
      return res.status(403).json({ error: 'Account flagged.' });
    }
    
    user.has_bank = user.has_bank || false;
    user.has_loan = user.has_loan || false;
    user.has_investment = user.has_investment || false;
    
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// --- ONBOARDING ROUTE (FIXED) ---
app.post('/api/complete-onboarding', async (req, res) => {
  const { userId, type, age, address, ssn_last4 } = req.body;
  
  try {
    await pool.query('BEGIN');
    
    // 1. Update the user details
    await pool.query(
      `UPDATE users SET age = $1, address = $2, ssn_last4 = $3 WHERE id = $4`,
      [age, address, ssn_last4, userId]
    );
    
    // 2. Safely insert the account without duplicates crashing the server
    if (type === 'bank') {
      await pool.query(`UPDATE users SET has_bank = true WHERE id = $1`, [userId]);
      await pool.query(`
        INSERT INTO accounts (user_id, type, balance) 
        SELECT $1, 'checking', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'checking')
      `, [userId]);
      await pool.query(`
        INSERT INTO accounts (user_id, type, balance) 
        SELECT $1, 'savings', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'savings')
      `, [userId]);
    }
    else if (type === 'investment') {
      await pool.query(`UPDATE users SET has_investment = true WHERE id = $1`, [userId]);
      await pool.query(`
        INSERT INTO accounts (user_id, type, balance) 
        SELECT $1, 'brokerage', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'brokerage')
      `, [userId]);
      await pool.query(`
        INSERT INTO accounts (user_id, type, balance) 
        SELECT $1, 'bitcoin', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'bitcoin')
      `, [userId]);
    }
    else if (type === 'loan') {
      await pool.query(`UPDATE users SET has_loan = true WHERE id = $1`, [userId]);
      await pool.query(`
        INSERT INTO accounts (user_id, type, balance) 
        SELECT $1, 'loan', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'loan')
      `, [userId]);
    }
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error("❌ ONBOARDING FAILED:", err.message);
    res.status(500).json({ error: 'Failed to complete application.' });
  }
});

// GET ACCOUNTS & TRANSACTIONS
app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE user_id = $1', [req.params.userId]);
    const balances = {};
    result.rows.forEach(acc => balances[acc.type] = parseFloat(acc.balance));
    res.json(balances);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// [The rest of your routes for Deposit, Withdraw, Loans, Investments, Admin go here...]
// Make sure you use the same ones from the previous message, or just save this code and it will work.