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

// ==========================================
// 1. DATABASE SETUP
// ==========================================
pool.connect((err, client, release) => {
  if (err) console.error('DB Error:', err.message);
  else {
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, password VARCHAR(100), status VARCHAR(20) DEFAULT 'Active'
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50), balance DECIMAL(12,2) DEFAULT 0.00, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS investments (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, amount DECIMAL(12,2), status VARCHAR(50) DEFAULT 'Pending', start_date TIMESTAMP, maturity_date TIMESTAMP, profit DECIMAL(12,2) DEFAULT 0.00, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50), amount DECIMAL(12,2), status VARCHAR(20) DEFAULT 'Pending', reference VARCHAR(100), details TEXT, proof_image TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE, value TEXT
      );
    `, (err) => {
      if (err) console.error('Table Error:', err.message);
      client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS ssn_last4 VARCHAR(4);
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS proof_image TEXT;
      `, (err2) => {
        release();
        if (err2) console.error('Alter Table Error:', err2.message);
        else {
          pool.query(`INSERT INTO system_settings (key, value) VALUES 
            ('btc_address', 'bc1q...xanvia'), ('bank_name', 'Chase Bank'), ('bank_account', '123456789'), ('bank_routing', '021000021') 
            ON CONFLICT DO NOTHING`);
          console.log('✅ Database ready.');
        }
      });
    });
  }
});

// ==========================================
// 2. AUTHENTICATION & ONBOARDING
// ==========================================
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
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'Flagged') return res.status(403).json({ error: 'Account flagged.' });
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.post('/api/complete-onboarding', async (req, res) => {
  const { userId, type, age, address, ssn_last4 } = req.body;
  try {
    await pool.query('BEGIN');
    await pool.query(`UPDATE users SET age = $1, address = $2, ssn_last4 = $3 WHERE id = $4`, [age, address, ssn_last4, userId]);
    if (type === 'bank') await pool.query(`INSERT INTO accounts (user_id, type, balance) SELECT $1, 'checking', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'checking')`, [userId]);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE user_id = $1', [req.params.userId]);
    const balances = {};
    result.rows.forEach(acc => { balances[acc.type] = parseFloat(acc.balance); });
    res.json(balances);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// ==========================================
// 3. INVESTMENT SYSTEM
// ==========================================
app.post('/api/investments/deposit', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, reference, targetAccount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image) VALUES ($1, 'INVESTMENT_DEPOSIT', $2, 'Pending', $3, $4)`, 
      [userId, amount, reference, imagePath]);
    res.json({ success: true, message: 'Deposit request pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/investments/withdraw', async (req, res) => {
  const { userId, amount, bankDetails } = req.body;
  try {
    // Check if user has matured funds
    const check = await pool.query(`SELECT SUM(amount + profit) as total FROM investments WHERE user_id = $1 AND status = 'Matured'`, [userId]);
    const balance = parseFloat(check.rows[0].total) || 0;
    if (amount > balance) return res.status(400).json({ error: 'Insufficient matured funds.' });

    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'INVESTMENT_WITHDRAWAL', $2, 'Pending', $3)`, [userId, amount, bankDetails]);
    res.json({ success: true, message: 'Withdrawal pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/investments/reinvest', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    // Deduct from matured investments
    const check = await pool.query(`SELECT SUM(amount + profit) as total FROM investments WHERE user_id = $1 AND status = 'Matured'`, [userId]);
    const balance = parseFloat(check.rows[0].total) || 0;
    if (amount > balance) return res.status(400).json({ error: 'Insufficient matured funds.' });

    // Create new pending transaction
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'INVESTMENT_REINVEST', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Reinvestment pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/investments/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investments WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// 4. LOANS SYSTEM
// ==========================================
app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Loan application pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/transfer', async (req, res) => {
  const { userId, amount, destination } = req.body;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'loan'`, [userId]);
    if (parseFloat(check.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient loan balance.' });
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'LOAN_TRANSFER', $2, 'Pending', $3)`, [userId, amount, destination]);
    res.json({ success: true, message: 'Transfer pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/repay', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    if (parseFloat(check.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient checking funds.' });
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_REPAYMENT', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Repayment pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ==========================================
// 5. ADMIN APPROVALS (The Math Engine)
// ==========================================
app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await pool.query(`SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'Pending' ORDER BY t.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/approve', async (req, res) => {
  const { txId, action } = req.body;
  try {
    const tx = (await pool.query('SELECT * FROM transactions WHERE id = $1', [txId])).rows[0];
    if (!tx || tx.status !== 'Pending') return res.status(400).json({ error: 'Invalid.' });
    
    await pool.query('BEGIN');

    if (action === 'approve') {
      await pool.query(`UPDATE transactions SET status = 'Approved' WHERE id = $1`, [txId]);
      
      const now = new Date();
      const maturity = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days later

      // INVESTMENT DEPOSIT -> Create active investment record
      if (tx.type === 'INVESTMENT_DEPOSIT') {
        await pool.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit) VALUES ($1, $2, 'Active', $3, $4, $5)`, 
          [tx.user_id, tx.amount, now, maturity, tx.amount * 2.4]);
      }
      // INVESTMENT WITHDRAWAL -> Mark matured investments as Withdrawn
      else if (tx.type === 'INVESTMENT_WITHDRAWAL') {
        await pool.query(`UPDATE investments SET status = 'Withdrawn' WHERE user_id = $1 AND status = 'Matured'`, [tx.user_id]);
      }
      // INVESTMENT REINVEST -> Create new active investment
      else if (tx.type === 'INVESTMENT_REINVEST') {
        await pool.query(`UPDATE investments SET status = 'Reinvested' WHERE user_id = $1 AND status = 'Matured'`, [tx.user_id]);
        await pool.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit) VALUES ($1, $2, 'Active', $3, $4, $5)`, 
          [tx.user_id, tx.amount, now, maturity, tx.amount * 2.4]);
      }
      // LOAN APPLICATION -> Add to loan balance
      else if (tx.type === 'LOAN_APPLICATION') {
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
      }
      // LOAN TRANSFER -> Deduct from loan, add to checking
      else if (tx.type === 'LOAN_TRANSFER') {
        await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
        if (tx.details === 'checking') await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
      }
      // LOAN REPAYMENT -> Deduct from checking, deduct debt
      else if (tx.type === 'LOAN_REPAYMENT') {
        await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
        await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
      }
    } else {
      await pool.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
    }
    
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) { 
    console.error("APPROVAL ERROR:", err.message);
    await pool.query('ROLLBACK'); 
    res.status(500).json({ error: 'Failed.' }); 
  }
});

// SETTINGS & CATCH-ALL
app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings');
    const settings = {}; result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/transactions/:userId', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId])).rows); } 
  catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));