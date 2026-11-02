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
// 1. DATABASE SETUP (AUTO-FIXES MISSING COLUMNS)
// ==========================================
pool.connect((err, client, release) => {
  if (err) console.error('DB Error:', err.message);
  else {
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, password VARCHAR(100), status VARCHAR(20) DEFAULT 'Active',
        has_bank BOOLEAN DEFAULT false, has_loan BOOLEAN DEFAULT false, has_investment BOOLEAN DEFAULT false
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
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, card_type VARCHAR(50), status VARCHAR(20) DEFAULT 'Pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
// 2. AUTHENTICATION
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

// ==========================================
// 3. ONBOARDING & ACCOUNTS
// ==========================================
app.post('/api/complete-onboarding', async (req, res) => {
  const { userId, type, age, address, ssn_last4 } = req.body;
  try {
    await pool.query('BEGIN');
    await pool.query(`UPDATE users SET age = $1, address = $2, ssn_last4 = $3 WHERE id = $4`, [age, address, ssn_last4, userId]);

    if (type === 'bank') {
      await pool.query(`UPDATE users SET has_bank = true WHERE id = $1`, [userId]);
      await pool.query(`INSERT INTO accounts (user_id, type, balance) SELECT $1, 'checking', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'checking')`, [userId]);
      await pool.query(`INSERT INTO accounts (user_id, type, balance) SELECT $1, 'savings', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'savings')`, [userId]);
    } else if (type === 'investment') {
      await pool.query(`UPDATE users SET has_investment = true WHERE id = $1`, [userId]);
      await pool.query(`INSERT INTO accounts (user_id, type, balance) SELECT $1, 'brokerage', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'brokerage')`, [userId]);
      await pool.query(`INSERT INTO accounts (user_id, type, balance) SELECT $1, 'bitcoin', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'bitcoin')`, [userId]);
    } else if (type === 'loan') {
      await pool.query(`UPDATE users SET has_loan = true WHERE id = $1`, [userId]);
      await pool.query(`INSERT INTO accounts (user_id, type, balance) SELECT $1, 'loan', 0.00 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = $1 AND type = 'loan')`, [userId]);
    }
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to complete application.' });
  }
});

app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE user_id = $1', [req.params.userId]);
    const balances = {};
    result.rows.forEach(acc => balances[acc.type] = parseFloat(acc.balance));
    res.json(balances);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// ==========================================
// 4. CARDS
// ==========================================
app.post('/api/cards/request', async (req, res) => {
  const { userId, cardType } = req.body;
  try {
    await pool.query(`INSERT INTO cards (user_id, card_type) VALUES ($1, $2)`, [userId, cardType]);
    res.json({ success: true, message: 'Card request submitted.' });
  } catch (err) { res.status(500).json({ error: 'Failed to request card.' }); }
});

app.get('/api/cards/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch cards.' }); }
});

// ==========================================
// 5. TRANSACTIONS, DEPOSITS & LOANS
// ==========================================
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.post('/api/deposit/request', upload.single('screenshot'), async (req, res) => {
  const { userId, amount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, proof_image) VALUES ($1, 'DEPOSIT', $2, 'Pending', $3)`, [userId, amount, imagePath]);
    res.json({ success: true, message: 'Deposit sent. Pending Admin verification.' });
  } catch (err) { res.status(500).json({ error: 'Request failed.' }); }
});

app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, details } = req.body;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    if (parseFloat(check.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    await pool.query('BEGIN');
    await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [amount, userId]);
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'WITHDRAWAL', $2, 'Pending', $3)`, [userId, amount, details]);
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Withdrawal pending Admin.' });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Request failed.' }); }
});

app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount, termMonths, rate } = req.body;
  const depositReq = amount * 0.15;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    if (parseFloat(check.rows[0].balance) < depositReq) return res.status(400).json({ error: `Need $${depositReq.toFixed(2)} for 15% deposit.` });
    await pool.query('BEGIN');
    await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [depositReq, userId]);
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending', $3)`, [userId, amount, JSON.stringify({ termMonths, rate, depositPaid: depositReq })]);
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Loan application submitted.' });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/loans/:userId', async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId])).rows); } 
  catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// 6. ADMIN ROUTES
// ==========================================
app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await pool.query(`SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'Pending' ORDER BY t.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.get('/api/admin/card-requests', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.*, u.name FROM cards c JOIN users u ON c.user_id = u.id WHERE c.status = 'Pending'`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/approve-card/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE cards SET status = 'Active' WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/users', async (req, res) => {
  try { res.json((await pool.query('SELECT id, name, email, status FROM users ORDER BY id DESC')).rows); } 
  catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/flag', async (req, res) => {
  const { userId, status } = req.body;
  try { await pool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings');
    const settings = {}; result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/update-settings', async (req, res) => {
  const { btc_address, bank_name, bank_account, bank_routing } = req.body;
  try {
    await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'btc_address'`, [btc_address]);
    await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'bank_name'`, [bank_name]);
    await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'bank_account'`, [bank_account]);
    await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'bank_routing'`, [bank_routing]);
    res.json({ success: true });
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
      if (tx.type === 'DEPOSIT') await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
      if (tx.type === 'LOAN_APPLICATION') {
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
      }
    } else {
      await pool.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
      if (tx.type === 'WITHDRAWAL') await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
      if (tx.type === 'LOAN_APPLICATION') {
        const details = JSON.parse(tx.details);
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [details.depositPaid, tx.user_id]);
      }
    }
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Failed.' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));