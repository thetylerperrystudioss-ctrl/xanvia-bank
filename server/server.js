require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.fieldname + path.extname(file.originalname))
});
const upload = multer({ storage });
const kycUpload = upload.fields([
  { name: 'id_front', maxCount: 1 },
  { name: 'id_back', maxCount: 1 },
  { name: 'proof_of_address', maxCount: 1 }
]);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS }
});

async function sendNotification(userId, message) {
  try { await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [userId, message]); } catch (err) { }
}
async function sendEmail(to, subject, html) {
  try { await transporter.sendMail({ from: `"Xanvia Bank" <${process.env.GMAIL_USER}>`, to, subject, html }); } catch (error) { }
}

let marketCache = {
  crypto: [{ name: 'Bitcoin', ticker: 'BTC', price: 64230.50, change: 2.4, icon: '₿' }],
  stocks: [{ name: 'Apple Inc.', ticker: 'AAPL', price: 172.50, change: 0.5, icon: 'A' }],
  lastUpdated: new Date()
};

// ==========================================
// BULLETPROOF DATABASE SETUP
// ==========================================
pool.connect(async (err, client, release) => {
  if (err) {
    console.error('Database Connection Error:', err.message);
    return;
  }
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS system_settings (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS cards (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS investments (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS investment_assets (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS complaints (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS login_history (id SERIAL PRIMARY KEY);
    `);

    // Forcefully add all missing columns safely
    const queries = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100) UNIQUE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(100)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number VARCHAR(20) UNIQUE",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS routing_number VARCHAR(20)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ssn_last4 VARCHAR(4)",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS id_front TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS id_back TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS proof_of_address TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
      "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_id INTEGER",
      "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS type VARCHAR(50)",
      "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance DECIMAL(12,2) DEFAULT 0.00",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS user_id INTEGER",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(50)",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Pending'",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100)",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS details TEXT",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS proof_image TEXT",
      "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
      "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_id INTEGER",
      "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT",
      "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false",
      "ALTER TABLE notifications ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
      "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS key VARCHAR(50) UNIQUE",
      "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value TEXT",
      "ALTER TABLE cards ADD COLUMN IF NOT EXISTS user_id INTEGER",
      "ALTER TABLE cards ADD COLUMN IF NOT EXISTS card_type VARCHAR(50)",
      "ALTER TABLE cards ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active'",
      "ALTER TABLE cards ADD COLUMN IF NOT EXISTS last4 VARCHAR(4)",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS user_id INTEGER",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS status VARCHAR(50)",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS start_date TIMESTAMP",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS maturity_date TIMESTAMP",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS profit DECIMAL(12,2)",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS asset_name VARCHAR(100)",
      "ALTER TABLE investments ADD COLUMN IF NOT EXISTS asset_category VARCHAR(50)",
      "ALTER TABLE investment_assets ADD COLUMN IF NOT EXISTS category VARCHAR(50)",
      "ALTER TABLE investment_assets ADD COLUMN IF NOT EXISTS name VARCHAR(100)",
      "ALTER TABLE investment_assets ADD COLUMN IF NOT EXISTS description TEXT",
      "ALTER TABLE investment_assets ADD COLUMN IF NOT EXISTS price DECIMAL(12,2)",
      "ALTER TABLE investment_assets ADD COLUMN IF NOT EXISTS image_url TEXT"
    ];

    for (let q of queries) {
      try { await client.query(q); } catch (e) { console.log('Column update skipped:', e.message); }
    }

    await client.query(`
      INSERT INTO system_settings (key, value) VALUES 
      ('btc_address', 'bc1q...xanvia'), ('bank_name', 'Chase Bank'), 
      ('bank_account', '123456789'), ('bank_routing', '021000021') 
      ON CONFLICT (key) DO NOTHING
    `);
    
    console.log('✅ Database fully verified and updated.');
  } catch (dbErr) {
    console.error('DB Setup Error:', dbErr.message);
  } finally {
    release();
  }
});

// ==========================================
// AUTHENTICATION
// ==========================================
app.post('/api/register', kycUpload, async (req, res) => {
  try {
    const { name, email, password, phone, age, address, ssn_last4 } = req.body;
    if (!email || !password || !name || !address || !ssn_last4 || !age) return res.status(400).json({ error: 'All fields are required.' });
    if (!req.files || !req.files['id_front'] || !req.files['id_back']) return res.status(400).json({ error: 'ID Front and Back required.' });
    
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Email registered.' });

    const idFrontPath = `/uploads/${req.files['id_front'][0].filename}`;
    const idBackPath = `/uploads/${req.files['id_back'][0].filename}`;
    const proofAddressPath = req.files['proof_of_address'] ? `/uploads/${req.files['proof_of_address'][0].filename}` : null;
    
    const accountNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const routingNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
    const safeUsername = email.split('@')[0] + Math.floor(Math.random() * 1000);
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const userResult = await pool.query(
      `INSERT INTO users (name, username, email, password, phone, account_number, routing_number, age, address, ssn_last4, id_front, id_back, proof_of_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [name, safeUsername, email.toLowerCase(), hashedPassword, phone, accountNumber, routingNumber, age, address, ssn_last4, idFrontPath, idBackPath, proofAddressPath]
    );
    const newUser = userResult.rows[0];
    
    await pool.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0), ($1, 'savings', 0)`, [newUser.id]);
    await sendNotification(newUser.id, `Welcome to Xanvia, ${name}!`);
    
    res.json({ success: true, message: 'Account created!', user: newUser });
  } catch (err) { 
    console.error("Register Error:", err);
    res.status(500).json({ error: 'Server Error: ' + err.message }); 
  }
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE (email = $1 OR username = $1) AND deleted = false', [identifier.toLowerCase()]);
    const user = result.rows[0];
    
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (user.status === 'Frozen') {
      return res.status(403).json({ error: 'Account frozen.' });
    }
    
    user.has_bank = true; user.has_loan = true; user.has_investment = true;
    res.json({ success: true, user });
  } catch (err) { 
    res.status(500).json({ error: 'Server error during login.' }); 
  }
});

// ==========================================
// USER ROUTES
// ==========================================
app.get('/api/user/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT name, username, email, phone, account_number, routing_number, profile_pic FROM users WHERE id = $1', [req.params.userId]);
    res.json(result.rows[0] || {});
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows.map(row => ({ ...row, amount: parseFloat(row.amount) || 0 })));
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const query = `SELECT COALESCE(SUM(CASE WHEN type IN ('DEPOSIT') THEN amount WHEN type IN ('WITHDRAWAL', 'FEE', 'INTERNAL_TRANSFER') THEN -amount ELSE 0 END), 0) AS checking_balance FROM transactions WHERE user_id = $1 AND status = 'Approved'`;
    const result = await pool.query(query, [req.params.userId]);
    res.json({ checking: parseFloat(result.rows[0].checking_balance) || 0, loan: 0 });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/notifications/:userId', async (req, res) => {
  try { const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]); res.json(result.rows); } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/cards/:userId', async (req, res) => {
  try { const result = await pool.query('SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]); res.json(result.rows); } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/assets', async (req, res) => {
  try { const result = await pool.query('SELECT * FROM investment_assets ORDER BY created_at DESC'); res.json(result.rows); } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/investments/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investments WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// ADMIN ROUTES
// ==========================================
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM users WHERE deleted = false ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings');
    const settings = {}; result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/settings/update', async (req, res) => {
  const { bank_name, bank_account, bank_routing, btc_address } = req.body;
  try {
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('bank_name', $1), ('bank_account', $2), ('bank_routing', $3), ('btc_address', $4) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [bank_name, bank_account, bank_routing, btc_address]);
    res.json({ success: true, message: 'Settings updated.' });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/requests', async (req, res) => {
  try { 
    const result = await pool.query(`SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'Pending'`); 
    res.json(result.rows); 
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/approve', async (req, res) => {
  const { txId, action } = req.body;
  try {
    const tx = (await pool.query('SELECT * FROM transactions WHERE id = $1', [txId])).rows[0];
    await pool.query(`UPDATE transactions SET status = $1 WHERE id = $2`, [action === 'approve' ? 'Approved' : 'Rejected', txId]);
    
    if (action === 'approve' && tx.type === 'INVESTMENT_DEPOSIT') {
      const parts = tx.details.split('|');
      const maturity = new Date(new Date().getTime() + parseInt(parts[2]) * 24 * 60 * 60 * 1000);
      await pool.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit, asset_name, asset_category) VALUES ($1, $2, 'Active', $3, $4, 0, $5, $6)`, [tx.user_id, tx.amount, new Date(), maturity, parts[0], parts[1]]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// MISC ROUTES
// ==========================================
app.post('/api/deposit/request', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, targetAccount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image) VALUES ($1, 'DEPOSIT', $2, 'Pending', $3, $4)`, [userId, amount, targetAccount, imagePath]);
    res.json({ success: true, message: 'Deposit submitted.' });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/transfer/internal', async (req, res) => {
  const { userId, recipientAccount, amount } = req.body;
  try {
    const balCheck = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE', 'INTERNAL_TRANSFER') THEN -amount ELSE 0 END), 0) as balance FROM transactions WHERE user_id = $1 AND status = 'Approved'`, [userId]);
    if (parseFloat(balCheck.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, details) VALUES ($1, 'INTERNAL_TRANSFER', $2, 'Pending', $3, 'Transfer')`, [userId, amount, recipientAccount]);
    res.json({ success: true, message: 'Transfer pending approval.' });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/lookup-account/:accountNumber', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM users WHERE account_number = $1', [req.params.accountNumber]);
    if (result.rows.length > 0) res.json({ success: true, name: result.rows[0].name });
    else res.status(404).json({ error: 'Account not found' });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/market', (req, res) => { res.json(marketCache); });

// Catch-all
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));