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

// Gmail Fix
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASS
  }
});

async function sendNotification(userId, message) {
  try {
    await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [userId, message]);
  } catch (err) { }
}

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Xanvia Bank" <${process.env.GMAIL_USER}>`,
      to: to,
      subject: subject,
      html: html
    });
  } catch (error) { console.error('Email Error:', error); }
}

let marketCache = {
  crypto: [
    { name: 'Bitcoin', ticker: 'BTC', price: 64230.50, change: 2.4, icon: '₿' },
    { name: 'Ethereum', ticker: 'ETH', price: 3120.10, change: 1.8, icon: 'Ξ' },
    { name: 'Solana', ticker: 'SOL', price: 145.20, change: -0.5, icon: 'S' },
    { name: 'XRP', ticker: 'XRP', price: 0.52, change: 1.1, icon: 'X' }
  ],
  stocks: [
    { name: 'Apple Inc.', ticker: 'AAPL', price: 172.50, change: 0.5, icon: 'A' },
    { name: 'NVIDIA Corp', ticker: 'NVDA', price: 890.20, change: 4.2, icon: 'N' },
    { name: 'Tesla Inc.', ticker: 'TSLA', price: 175.30, change: -1.2, icon: 'T' }
  ],
  lastUpdated: new Date()
};
let isFetching = false;

async function updateMarketData() {
  if (isFetching) return;
  isFetching = true;
  try {
    const cryptoRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=usd&include_24hr_change=true');
    if (!cryptoRes.ok) throw new Error("API Error");
    const cryptoData = await cryptoRes.json();
    if (cryptoData.bitcoin) {
      marketCache.crypto = [
        { name: 'Bitcoin', ticker: 'BTC', price: cryptoData.bitcoin.usd, change: cryptoData.bitcoin.usd_24h_change, icon: '₿' },
        { name: 'Ethereum', ticker: 'ETH', price: cryptoData.ethereum.usd, change: cryptoData.ethereum.usd_24h_change, icon: 'Ξ' },
        { name: 'Solana', ticker: 'SOL', price: cryptoData.solana.usd, change: cryptoData.solana.usd_24h_change, icon: 'S' },
        { name: 'XRP', ticker: 'XRP', price: cryptoData.ripple.usd, change: cryptoData.ripple.usd_24h_change, icon: 'X' }
      ];
      marketCache.lastUpdated = new Date();
    }
  } catch (err) { } finally { isFetching = false; }
}
updateMarketData();
setInterval(updateMarketData, 60000);

// DATABASE SETUP
pool.connect((err, client, release) => {
  if (err) console.error('DB Error:', err.message);
  else {
    client.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS investments (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS complaints (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE, sender VARCHAR(20), message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS notifications (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, message TEXT, is_read BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS system_settings (id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE);
      CREATE TABLE IF NOT EXISTS cards (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS login_history (id SERIAL PRIMARY KEY, user_id INTEGER, ip_address TEXT, device_info TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS investment_assets (id SERIAL PRIMARY KEY, category VARCHAR(50), name VARCHAR(100), description TEXT, price DECIMAL(12,2), image_url TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `, async (err) => {
      if (err) console.error('Create Table Error:', err.message);

      const alterQueries = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)", "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(100)", "ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)", "ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number VARCHAR(20) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS routing_number VARCHAR(20)", "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active'", "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP", "ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER", "ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT", "ALTER TABLE users ADD COLUMN IF NOT EXISTS ssn_last4 VARCHAR(4)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS id_front TEXT", "ALTER TABLE users ADD COLUMN IF NOT EXISTS id_back TEXT", "ALTER TABLE users ADD COLUMN IF NOT EXISTS proof_of_address TEXT",
        "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS type VARCHAR(50)", "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance DECIMAL(12,2) DEFAULT 0.00",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)", "ALTER TABLE investments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Active'",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS start_date TIMESTAMP", "ALTER TABLE investments ADD COLUMN IF NOT EXISTS maturity_date TIMESTAMP",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS profit DECIMAL(12,2)", "ALTER TABLE investments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS asset_name VARCHAR(100)", "ALTER TABLE investments ADD COLUMN IF NOT EXISTS asset_category VARCHAR(50)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(50)", "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Pending'", "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS details TEXT", "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS proof_image TEXT",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS ref_number VARCHAR(20) UNIQUE", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS category VARCHAR(50)",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS subject VARCHAR(100)", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS message TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Pending'", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS admin_response TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS attachment TEXT", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value TEXT", "ALTER TABLE cards ADD COLUMN IF NOT EXISTS card_type VARCHAR(50)",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active'", "ALTER TABLE cards ADD COLUMN IF NOT EXISTS last4 VARCHAR(4)",
        "ALTER TABLE cards ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
      ];
      for (let q of alterQueries) { try { await client.query(q); } catch (e) { } }

      await client.query(`INSERT INTO system_settings (key, value) VALUES ('btc_address', 'bc1q...xanvia'), ('bank_name', 'Chase Bank'), ('bank_account', '123456789'), ('bank_routing', '021000021') ON CONFLICT (key) DO NOTHING`);
      release();
      console.log('✅ Database fully upgraded and ready.');
    });
  }
});

// REGISTRATION (KYC & FILE UPLOADS)
app.post('/api/register', kycUpload, async (req, res) => {
  try {
    const { name, email, password, phone, age, address, ssn_last4 } = req.body;
    if (!email || !password || !name || !address || !ssn_last4 || !age) {
      return res.status(400).json({ error: 'All fields (Name, Email, Password, Phone, Age, Address, SSN) are required.' });
    }
    if (!req.files || !req.files['id_front'] || !req.files['id_back']) {
      return res.status(400).json({ error: 'Government ID (Front and Back) are required.' });
    }
    if (!email.toLowerCase().endsWith('@gmail.com')) {
      return res.status(400).json({ error: 'Please enter a valid Gmail address.' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

    const idFrontPath = `/uploads/${req.files['id_front'][0].filename}`;
    const idBackPath = `/uploads/${req.files['id_back'][0].filename}`;
    const proofAddressPath = req.files['proof_of_address'] ? `/uploads/${req.files['proof_of_address'][0].filename}` : null;

    const accountNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const routingNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
    const safeUsername = email.split('@')[0] + Math.floor(Math.random() * 1000);

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const userResult = await pool.query(
      `INSERT INTO users (name, username, email, password, phone, account_number, routing_number, age, address, ssn_last4, id_front, id_back, proof_of_address) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [name, safeUsername, email.toLowerCase(), hashedPassword, phone, accountNumber, routingNumber, age, address, ssn_last4, idFrontPath, idBackPath, proofAddressPath]
    );

    const newUserId = userResult.rows[0].id;
    await pool.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0), ($1, 'savings', 0), ($1, 'loan', 0), ($1, 'brokerage', 0)`, [newUserId]);

    await sendNotification(newUserId, `Welcome to Xanvia Credit Union, ${name}! Your account is under review.`);
    await sendNotification(newUserId, `Action Required: A minimum deposit of $25 is required to fully activate your checking account.`);

    await sendEmail(email, "Welcome to Xanvia Bank!", `
      <h2>Welcome, ${name}!</h2>
      <p>Your account has been successfully created and your documents are under review.</p>
      <p>To activate your account, please log in and make a minimum opening deposit of $25.</p>
    `);

    res.json({ success: true, message: 'Account created successfully! Redirecting to login...', userId: newUserId });
  } catch (err) { res.status(500).json({ error: 'Database Error: ' + err.message }); }
});

// AUTHENTICATION
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE (email = $1 OR username = $1) AND deleted = false', [identifier.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'Frozen') return res.status(403).json({ error: 'Account frozen.' });
    
    user.has_bank = true; user.has_loan = true; user.has_investment = true;

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
    const device = req.headers['user-agent'] || 'Unknown Device';
    await pool.query(`INSERT INTO login_history (user_id, ip_address, device_info) VALUES ($1, $2, $3)`, [user.id, ip, device]);
    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT id, name FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Email not found.' });
    const user = result.rows[0];
    const tempPassword = "Reset" + Math.floor(1000 + Math.random() * 9000);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE email = $2', [hashedPassword, email.toLowerCase()]);

    await sendEmail(email, 'Xanvia Password Reset', `<h2>Hello ${user.name},</h2><p>Your temp password is: <b>${tempPassword}</b></p>`);
    res.json({ success: true, message: `Check your email for the new password.` });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.post('/api/user/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    const user = result.rows[0];
    if (!(await bcrypt.compare(currentPassword, user.password))) return res.status(400).json({ error: 'Incorrect current password.' });
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 10), userId]);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update password.' }); }
});

// ADMIN USER VIEW (FULL KYC)
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, username, email, phone, status, created_at, 
             age, address, ssn_last4, id_front, id_back, proof_of_address 
      FROM users WHERE deleted = false ORDER BY created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Database error: ' + err.message }); }
});

// CORE BANKING
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows.map(row => ({ ...row, amount: parseFloat(row.amount) || 0 })));
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const query = `
      SELECT
        COALESCE(SUM(CASE WHEN type IN ('DEPOSIT') THEN amount WHEN type IN ('WITHDRAWAL', 'FEE', 'INTERNAL_TRANSFER') THEN -amount ELSE 0 END), 0) AS checking_balance,
        COALESCE(SUM(CASE WHEN type = 'LOAN_APPLICATION' THEN amount WHEN type IN ('LOAN_REPAYMENT', 'LOAN_TRANSFER') THEN -amount ELSE 0 END), 0) AS loan_balance
      FROM transactions WHERE user_id = $1 AND status = 'Approved';
    `;
    const result = await pool.query(query, [req.params.userId]);
    res.json({ checking: parseFloat(result.rows[0].checking_balance) || 0, loan: parseFloat(result.rows[0].loan_balance) || 0 });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
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
    await pool.query(`
      INSERT INTO system_settings (key, value) VALUES ('bank_name', $1), ('bank_account', $2), ('bank_routing', $3), ('btc_address', $4)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [bank_name, bank_account, bank_routing, btc_address]);
    res.json({ success: true, message: 'Settings updated successfully.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update settings.' }); }
});

app.get('/api/user/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT name, username, email, phone, account_number, routing_number, profile_pic FROM users WHERE id = $1', [req.params.userId]);
    res.json(result.rows[0] || {});
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/user/update', upload.single('profile_pic'), async (req, res) => {
  const { userId, name, username, phone } = req.body;
  const profilePicPath = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    if (profilePicPath) await pool.query(`UPDATE users SET name = $1, username = $2, phone = $3, profile_pic = $4 WHERE id = $5`, [name, username.toLowerCase(), phone, profilePicPath, userId]);
    else await pool.query(`UPDATE users SET name = $1, username = $2, phone = $3 WHERE id = $4`, [name, username.toLowerCase(), phone, userId]);
    res.json({ success: true, message: 'Profile updated!' });
  } catch (err) { res.status(500).json({ error: 'Failed to update profile.' }); }
});

// LOANS & TRANSFERS
app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending')`, [userId, amount]);
    await sendNotification(userId, `Your loan application for $${parseFloat(amount).toFixed(2)} has been submitted.`);
    res.json({ success: true, message: 'Application received.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/transfer', async (req, res) => {
  const { userId, amount, destination, bankDetails } = req.body;
  try {
    const detailsToStore = destination === 'external' ? JSON.stringify(bankDetails) : destination;
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'LOAN_TRANSFER', $2, 'Pending', $3)`, [userId, amount, detailsToStore]);
    await sendNotification(userId, `Your loan transfer request is pending approval.`);
    res.json({ success: true, message: 'Transfer pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/repay', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_REPAYMENT', $2, 'Pending')`, [userId, amount]);
    await sendNotification(userId, `Your loan repayment is pending approval.`);
    res.json({ success: true, message: 'Repayment pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/transfer/internal', async (req, res) => {
  const { userId, recipientAccount, amount } = req.body;
  try {
    const balCheck = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE', 'INTERNAL_TRANSFER') THEN -amount ELSE 0 END), 0) as balance FROM transactions WHERE user_id = $1 AND status = 'Approved'`, [userId]);
    if (parseFloat(balCheck.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, details) VALUES ($1, 'INTERNAL_TRANSFER', $2, 'Pending', $3, 'Transfer')`, [userId, amount, recipientAccount]);
    await sendNotification(userId, `Your transfer to ${recipientAccount} is pending.`);
    res.json({ success: true, message: 'Transfer submitted. Pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/lookup-account/:accountNumber', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM users WHERE account_number = $1', [req.params.accountNumber]);
    if (result.rows.length > 0) res.json({ success: true, name: result.rows[0].name });
    else res.status(404).json({ error: 'Account not found' });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/deposit/request', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, targetAccount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image) VALUES ($1, 'DEPOSIT', $2, 'Pending', $3, $4)`, [userId, amount, targetAccount, imagePath]);
    await sendNotification(userId, `Your deposit of $${parseFloat(amount).toFixed(2)} is pending.`);
    res.json({ success: true, message: 'Deposit submitted.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

// NOTIFICATIONS
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/notifications/:userId/read', async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read = true WHERE user_id = $1`, [req.params.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// CARDS
app.get('/api/cards/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load cards.' }); }
});

app.post('/api/cards/request', async (req, res) => {
  const { userId, cardType } = req.body;
  try {
    const last4 = Math.floor(1000 + Math.random() * 9000).toString();
    await pool.query(`INSERT INTO cards (user_id, card_type, status, last4) VALUES ($1, $2, 'Active', $3)`, [userId, cardType, last4]);
    await sendNotification(userId, `Your new ${cardType} ending in ${last4} is active.`);
    res.json({ success: true, message: 'Card created successfully!' });
  } catch (err) { res.status(500).json({ error: 'Failed to request card.' }); }
});

app.post('/api/cards/:cardId/toggle', async (req, res) => {
  const { cardId } = req.params;
  const { status, userId } = req.body;
  try {
    await pool.query('UPDATE cards SET status = $1 WHERE id = $2', [status, cardId]);
    await sendNotification(userId, `Your card status is now: ${status}.`);
    res.json({ success: true, status });
  } catch (err) { res.status(500).json({ error: 'Failed to update card.' }); }
});

// INVESTMENTS
app.get('/api/assets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investment_assets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/investments/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investments WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    const investments = result.rows.map(inv => {
      let currentProfit = 0;
      if (inv.status === 'Active' && inv.start_date && inv.maturity_date) {
        const totalExpectedProfit = parseFloat(inv.amount) * 1.4;
        if (new Date() >= new Date(inv.maturity_date)) currentProfit = totalExpectedProfit;
        else if (new Date() > new Date(inv.start_date)) {
          const totalDuration = new Date(inv.maturity_date) - new Date(inv.start_date);
          const elapsed = new Date() - new Date(inv.start_date);
          currentProfit = totalExpectedProfit * (elapsed / totalDuration);
        }
      } else if (inv.status === 'Completed') currentProfit = parseFloat(inv.profit) || 0;
      return { ...inv, amount: parseFloat(inv.amount), profit: currentProfit.toFixed(2) };
    });
    res.json(investments);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/investments/deposit', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, reference, assetName, assetCategory, term } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  const combinedDetails = `${assetName || 'General Portfolio'}|${assetCategory || 'Crypto'}|${term || '7'}`;
  
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image, details) VALUES ($1, 'INVESTMENT_DEPOSIT', $2, 'Pending', $3, $4, $5)`, [userId, amount, reference, imagePath, combinedDetails]);
    await sendNotification(userId, `Your investment into ${assetName} is pending approval.`);
    res.json({ success: true, message: 'Investment pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// SUPPORT
app.post('/api/complaints', upload.single('attachment'), async (req, res) => {
  const { userId, category, subject, message } = req.body;
  const refNum = `CMP-${Math.floor(100000 + Math.random() * 900000)}`;
  try {
    const result = await pool.query(`INSERT INTO complaints (user_id, ref_number, category, subject, message) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [userId, refNum, category, subject, message]);
    const complaintId = result.rows[0].id;
    await pool.query(`INSERT INTO chat_messages (complaint_id, sender, message) VALUES ($1, 'user', $2)`, [complaintId, message]);
    await pool.query(`INSERT INTO chat_messages (complaint_id, sender, message) VALUES ($1, 'admin', $2)`, [complaintId, `Welcome to Support. Your reference is ${refNum}.`]);
    res.json({ success: true, message: 'Complaint submitted.', ref: refNum });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/complaints/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM complaints WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/chat/:complaintId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM chat_messages WHERE complaint_id = $1 ORDER BY created_at ASC', [req.params.complaintId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/chat/:complaintId', async (req, res) => {
  const { sender, message } = req.body;
  try {
    await pool.query(`INSERT INTO chat_messages (complaint_id, sender, message) VALUES ($1, $2, $3)`, [req.params.complaintId, sender, message]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/chat/:complaintId/resolve', async (req, res) => {
  try {
    await pool.query(`UPDATE complaints SET status = 'Resolved' WHERE id = $1`, [req.params.complaintId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ADMIN ACTIONS
app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await pool.query(`SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status IN ('Pending') ORDER BY t.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/approve', async (req, res) => {
  const { txId, action } = req.body;
  const client = await pool.connect();
  try {
    const tx = (await client.query('SELECT * FROM transactions WHERE id = $1', [txId])).rows[0];
    await client.query('BEGIN');
    if (action === 'approve') {
      await client.query(`UPDATE transactions SET status = 'Approved' WHERE id = $1`, [txId]);
      
      if (tx.type === 'INVESTMENT_DEPOSIT') {
        const parts = tx.details.split('|');
        const assetName = parts[0];
        const assetCategory = parts[1];
        const term = parseInt(parts[2]) || 7;

        const now = new Date();
        const maturity = new Date(now.getTime() + term * 24 * 60 * 60 * 1000);
        await client.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit, asset_name, asset_category) VALUES ($1, $2, 'Active', $3, $4, $5, $6, $7)`, 
          [tx.user_id, tx.amount, now, maturity, 0, assetName, assetCategory]);
      }
      await sendNotification(tx.user_id, `Your ${tx.type.replace(/_/g, ' ')} of $${parseFloat(tx.amount).toFixed(2)} has been approved.`);
    } else {
      await client.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
      await sendNotification(tx.user_id, `Your ${tx.type.replace(/_/g, ' ')} was rejected.`);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Failed.' }); } finally { client.release(); }
});

app.get('/api/admin/assets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investment_assets ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/assets/add', async (req, res) => {
  const { category, name, description, price, image_url } = req.body;
  try {
    await pool.query(`INSERT INTO investment_assets (category, name, description, price, image_url) VALUES ($1, $2, $3, $4, $5)`, [category, name, description, price, image_url]);
    res.json({ success: true, message: 'Asset added successfully!' });
  } catch (err) { res.status(500).json({ error: 'Failed to add asset.' }); }
});

app.post('/api/admin/freeze', async (req, res) => {
  const { userId, status } = req.body;
  try {
    await pool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);
    await sendNotification(userId, `Your account status is now: ${status}.`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await pool.query(`UPDATE users SET deleted = true WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/notify', async (req, res) => {
  const { target, message } = req.body;
  try {
    if (target === 'all') {
      const users = await pool.query('SELECT id FROM users WHERE deleted = false');
      for (let u of users.rows) await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [u.id, message]);
    } else {
      await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [target, message]);
    }
    res.json({ success: true, message: 'Notification(s) sent!' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/admin/complaints', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.*, u.name FROM complaints c JOIN users u ON c.user_id = u.id ORDER BY c.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/chat/:complaintId', async (req, res) => {
  const { message } = req.body;
  try {
    await pool.query(`INSERT INTO chat_messages (complaint_id, sender, message) VALUES ($1, 'admin', $2)`, [req.params.complaintId, message]);
    await pool.query(`UPDATE complaints SET status = 'In Progress' WHERE id = $1`, [req.params.complaintId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));