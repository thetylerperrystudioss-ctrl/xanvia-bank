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
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper for auto notifications
async function sendNotification(userId, message) {
  try {
    await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [userId, message]);
  } catch (err) {
    console.error("Notification Error:", err);
  }
}

// ==========================================
// NODEMAILER SETUP
// ==========================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASS
  }
});

// ==========================================
// MARKET DATA CACHE
// ==========================================
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

// ==========================================
// DATABASE SETUP
// ==========================================
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

// ==========================================
// AUTHENTICATION
// ==========================================
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    
    const accountNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const routingNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
    const safeUsername = email.split('@')[0] + Math.floor(Math.random() * 1000);

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      `INSERT INTO users (name, username, email, password, phone, account_number, routing_number) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [name || 'Member', safeUsername, email.toLowerCase(), hashedPassword, phone || null, accountNumber, routingNumber]
    );

    const newUserId = userResult.rows[0].id;
    await pool.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0), ($1, 'savings', 0), ($1, 'loan', 0), ($1, 'brokerage', 0)`, [newUserId]);

    await sendNotification(newUserId, `Welcome to Xanvia Credit Union, ${name || 'Member'}! Your account has been successfully created.`);
    await sendNotification(newUserId, `Action Required: A minimum deposit of $25 is required to fully activate your checking account and unlock transfers.`);

    res.json({ success: true, message: 'Account created successfully!', userId: newUserId });
  } catch (err) { res.status(500).json({ error: 'Database Error: ' + err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE (email = $1 OR username = $1) AND deleted = false', [identifier.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    
    const isOnboarded = !!(user.age && user.address);
    user.has_bank = isOnboarded;
    user.has_loan = isOnboarded;
    user.has_investment = isOnboarded;

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown IP';
    const device = req.headers['user-agent'] || 'Unknown Device';
    await pool.query(`INSERT INTO login_history (user_id, ip_address, device_info) VALUES ($1, $2, $3)`, [user.id, ip, device]);

    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

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

app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await pool.query(`SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status IN ('Pending', 'Pending Admin Approval') ORDER BY t.created_at DESC`);
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
        const now = new Date();
        const maturity = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        await client.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit, asset_name, asset_category) VALUES ($1, $2, 'Active', $3, $4, $5, $6, $7)`, 
          [tx.user_id, tx.amount, now, maturity, 0, tx.details?.split('|')[0] || 'Portfolio Deposit', tx.details?.split('|')[1] || 'Crypto']);
      }
      await sendNotification(tx.user_id, `Good news! Your ${tx.type.replace(/_/g, ' ')} of $${parseFloat(tx.amount).toFixed(2)} has been approved.`);
    } else {
      await client.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
      await sendNotification(tx.user_id, `Alert: Your ${tx.type.replace(/_/g, ' ')} of $${parseFloat(tx.amount).toFixed(2)} was rejected.`);
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
    await pool.query(`INSERT INTO investment_assets (category, name, description, price, image_url) VALUES ($1, $2, $3, $4, $5)`, 
      [category, name, description, price, image_url]);
    res.json({ success: true, message: 'Asset added successfully!' });
  } catch (err) { res.status(500).json({ error: 'Failed to add asset.' }); }
});

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
        const start = new Date(inv.start_date).getTime();
        const maturity = new Date(inv.maturity_date).getTime();
        const now = new Date().getTime();
        const totalExpectedProfit = parseFloat(inv.amount) * 1.4;
        if (now >= maturity) {
          currentProfit = totalExpectedProfit;
        } else if (now > start) {
          const totalDuration = maturity - start;
          const elapsed = now - start;
          currentProfit = totalExpectedProfit * (elapsed / totalDuration);
        }
      } else if (inv.status === 'Completed') {
         currentProfit = parseFloat(inv.profit) || 0;
      }
      return { ...inv, amount: parseFloat(inv.amount), profit: currentProfit.toFixed(2) };
    });
    res.json(investments);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/investments/deposit', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, reference, assetName, assetCategory } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  const combinedDetails = `${assetName || 'General Portfolio'}|${assetCategory || 'Crypto'}`;
  
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image, details) VALUES ($1, 'INVESTMENT_DEPOSIT', $2, 'Pending', $3, $4, $5)`, 
      [userId, amount, reference, imagePath, combinedDetails]);
    await sendNotification(userId, `Your investment of $${parseFloat(amount).toFixed(2)} into ${assetName || 'Portfolio'} is pending admin approval.`);
    res.json({ success: true, message: 'Investment deposit pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/investments/withdraw', async (req, res) => {
  const { userId, amount, timeline } = req.body;
  try {
    const balCheck = await pool.query(`SELECT COALESCE(SUM(amount), 0) as balance FROM investments WHERE user_id = $1 AND status = 'Active'`, [userId]);
    if (parseFloat(balCheck.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient balance.' });
    const details = `Withdrawal Lock-in: ${timeline} Days`;
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'INVESTMENT_WITHDRAWAL', $2, 'Pending', $3)`, [userId, amount, details]);
    await sendNotification(userId, `Your investment withdrawal request for $${parseFloat(amount).toFixed(2)} is pending. Lock-in: ${timeline} days.`);
    res.json({ success: true, message: `Withdrawal requested for ${timeline} days.` });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/cards/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load cards.' }); }
});

app.get('/api/market', (req, res) => { res.json(marketCache); });

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));