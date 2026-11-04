const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const fetch = require('node-fetch');

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

// MARKET DATA CACHE
let marketCache = { crypto: [], stocks: [], lastUpdated: null };
let isFetching = false;

async function updateMarketData() {
  if (isFetching) return;
  isFetching = true;
  try {
    const cryptoRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple&vs_currencies=usd&include_24hr_change=true');
    const cryptoData = await cryptoRes.json();
    const cryptoList = [
      { name: 'Bitcoin', ticker: 'BTC', price: cryptoData.bitcoin?.usd || 0, change: cryptoData.bitcoin?.usd_24h_change || 0, icon: '₿' },
      { name: 'Ethereum', ticker: 'ETH', price: cryptoData.ethereum?.usd || 0, change: cryptoData.ethereum?.usd_24h_change || 0, icon: 'Ξ' },
      { name: 'Solana', ticker: 'SOL', price: cryptoData.solana?.usd || 0, change: cryptoData.solana?.usd_24h_change || 0, icon: 'S' },
      { name: 'XRP', ticker: 'XRP', price: cryptoData.ripple?.usd || 0, change: cryptoData.ripple?.usd_24h_change || 0, icon: 'X' }
    ];
    const stockList = [
      { name: 'Apple Inc.', ticker: 'AAPL', price: 172.50, change: 0.5, icon: 'A' },
      { name: 'NVIDIA Corp', ticker: 'NVDA', price: 890.20, change: 4.2, icon: 'N' },
      { name: 'Tesla Inc.', ticker: 'TSLA', price: 175.30, change: -1.2, icon: 'T' }
    ];
    marketCache = { crypto: cryptoList, stocks: stockList, lastUpdated: new Date() };
  } catch (err) { console.error('Market Data Error:', err.message); } finally { isFetching = false; }
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
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(50)", "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Pending'", "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS details TEXT", "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS proof_image TEXT",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS ref_number VARCHAR(20) UNIQUE", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS category VARCHAR(50)",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS subject VARCHAR(100)", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS message TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Pending'", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS admin_response TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS attachment TEXT", "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value TEXT"
      ];
      for (let q of alterQueries) { try { await client.query(q); } catch (e) { } }

      try {
        const usersNeedingNumbers = await client.query(`SELECT id FROM users WHERE account_number IS NULL OR routing_number IS NULL`);
        for (let row of usersNeedingNumbers.rows) {
          const accNum = Math.floor(1000000000 + Math.random() * 9000000000).toString();
          const routNum = Math.floor(100000000 + Math.random() * 900000000).toString();
          await client.query(`UPDATE users SET account_number = $1, routing_number = $2 WHERE id = $3`, [accNum, routNum, row.id]);
        }
      } catch(e) { }

      await client.query(`INSERT INTO system_settings (key, value) VALUES 
        ('btc_address', 'bc1q...xanvia'), ('bank_name', 'Chase Bank'), 
        ('bank_account', '123456789'), ('bank_routing', '021000021') 
        ON CONFLICT (key) DO NOTHING`);
      
      release();
      console.log('✅ Database fully upgraded and ready.');
    });
  }
});

// AUTHENTICATION & PROFILE
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (!email.toLowerCase().endsWith('@gmail.com')) return res.status(400).json({ error: 'Please enter a valid Gmail address.' });

    const accountNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const routingNumber = Math.floor(100000000 + Math.random() * 900000000).toString();
    const safeUsername = email.split('@')[0] + Math.floor(Math.random() * 1000);

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      `INSERT INTO users (name, username, email, password, phone, account_number, routing_number) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, 
      [name || 'Member', safeUsername, email.toLowerCase(), hashedPassword, phone || null, accountNumber, routingNumber]
    );
    
    await pool.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0), ($1, 'savings', 0), ($1, 'loan', 0), ($1, 'brokerage', 0)`, [userResult.rows[0].id]);

    res.json({ success: true, message: 'Account created successfully!', userId: userResult.rows[0].id });
  } catch (err) { res.status(500).json({ error: 'Database Error: ' + err.message }); }
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body; 
  try {
    const result = await pool.query('SELECT * FROM users WHERE (email = $1 OR username = $1) AND deleted = false', [identifier.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'Frozen') return res.status(403).json({ error: 'Account frozen.' });
    
    const feeCheck = await pool.query(`SELECT id, status FROM transactions WHERE user_id = $1 AND type = 'FEE' ORDER BY created_at DESC LIMIT 1`, [user.id]);
    const hasPaidFee = feeCheck.rows.length > 0 && feeCheck.rows[0].status === 'Approved';
    const hasPendingFee = feeCheck.rows.length > 0 && feeCheck.rows[0].status !== 'Approved';

    const txRes = await pool.query('SELECT type FROM transactions WHERE user_id = $1', [user.id]);
    const types = txRes.rows.map(r => r.type);
    const isOnboarded = !!(user.age && user.address);

    user.has_bank = types.includes('BANK_ACCOUNT') && hasPaidFee;
    user.has_loan = isOnboarded;
    user.has_investment = isOnboarded;
    user.needs_fee = hasPendingFee;

    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.get('/api/user/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT name, username, email, phone, account_number, routing_number, profile_pic FROM users WHERE id = $1', [req.params.userId]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/user/update', upload.single('profile_pic'), async (req, res) => {
  const { userId, name, username, phone } = req.body;
  const profilePicPath = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    if (profilePicPath) {
      await pool.query(`UPDATE users SET name = $1, username = $2, phone = $3, profile_pic = $4 WHERE id = $5`, [name, username.toLowerCase(), phone, profilePicPath, userId]);
    } else {
      await pool.query(`UPDATE users SET name = $1, username = $2, phone = $3 WHERE id = $4`, [name, username.toLowerCase(), phone, userId]);
    }
    res.json({ success: true, message: 'Profile updated!' });
  } catch (err) { res.status(500).json({ error: 'Failed to update profile.' }); }
});

// ONBOARDING & STATUS (STRICT ERROR HANDLING)
app.post('/api/complete-onboarding', async (req, res) => {
  const { userId, type, age, address, ssn_last4 } = req.body;
  try {
    await pool.query(`UPDATE users SET age = $1, address = $2, ssn_last4 = $3 WHERE id = $4`, [age, address, ssn_last4, userId]);
    
    const txType = type === 'bank' ? 'BANK_ACCOUNT' : type === 'loan' ? 'LOAN_ACCOUNT' : type === 'investment' ? 'INVESTMENT_ACCOUNT' : 'KYC_COMPLETED';
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, $2, 0, 'Approved', 'Onboarding completed')`, [userId, txType]);

    if (type === 'bank') {
      const existingFee = await pool.query(`SELECT * FROM transactions WHERE user_id = $1 AND type = 'FEE' AND status != 'Approved'`, [userId]);
      if (existingFee.rows.length === 0) {
        await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'FEE', 25.00, 'Pending', 'Account Activation Fee')`, [userId]);
      }
    }

    res.json({ success: true, message: 'Application approved!' });
  } catch (err) { res.status(500).json({ error: 'Failed: ' + err.message }); }
});

app.get('/api/user-status/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Safely check for onboarding
    const userRes = await pool.query('SELECT age, address FROM users WHERE id = $1', [userId]);
    const isOnboarded = !!(userRes.rows[0]?.age && userRes.rows[0]?.address);

    // Safely check for fee
    const feeCheck = await pool.query(`SELECT id, status FROM transactions WHERE user_id = $1 AND type = 'FEE' ORDER BY created_at DESC LIMIT 1`, [userId]);
    const hasPaidFee = feeCheck.rows.length > 0 && feeCheck.rows[0].status === 'Approved';
    const hasPendingFee = feeCheck.rows.length > 0 && feeCheck.rows[0].status !== 'Approved';

    // Safely check for account types
    const txRes = await pool.query('SELECT type FROM transactions WHERE user_id = $1', [userId]);
    const types = txRes.rows.map(r => r.type);

    res.json({
      has_bank: types.includes('BANK_ACCOUNT') && hasPaidFee,
      has_loan: isOnboarded, 
      has_investment: isOnboarded,
      needs_fee: hasPendingFee
    });
  } catch (err) { 
    console.error("STATUS ERROR:", err.message);
    // Fallback so it never crashes the frontend
    res.json({ has_bank: false, has_loan: false, has_investment: false, needs_fee: false }); 
  }
});

// ACCOUNTS & INVESTMENTS
app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const query = `
      SELECT 
        COALESCE(SUM(CASE 
          WHEN type IN ('DEPOSIT') THEN amount 
          WHEN type IN ('WITHDRAWAL', 'FEE', 'INTERNAL_TRANSFER') THEN -amount
          WHEN type = 'LOAN_TRANSFER' AND details = 'checking' THEN amount
          ELSE 0 
        END), 0) AS checking_balance,
        
        COALESCE(SUM(CASE 
          WHEN type = 'LOAN_APPLICATION' THEN amount 
          WHEN type IN ('LOAN_REPAYMENT', 'LOAN_TRANSFER') THEN -amount
          ELSE 0 
        END), 0) AS loan_balance
      FROM transactions WHERE user_id = $1 AND status = 'Approved';
    `;
    const result = await pool.query(query, [req.params.userId]);
    res.json({ 
      checking: parseFloat(result.rows[0].checking_balance) || 0,
      loan: parseFloat(result.rows[0].loan_balance) || 0 
    });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
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
        if (now >= maturity) currentProfit = totalExpectedProfit;
        else if (now > start) {
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

// LOANS, DEPOSITS & TRANSFERS
app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Application received.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/transfer', async (req, res) => {
  const { userId, amount, destination, bankDetails } = req.body;
  try {
    const detailsToStore = destination === 'external' ? JSON.stringify(bankDetails) : destination;
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'LOAN_TRANSFER', $2, 'Pending', $3)`, [userId, amount, detailsToStore]);
    res.json({ success: true, message: 'Transfer pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/repay', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_REPAYMENT', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Repayment pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/transfer/internal', async (req, res) => {
  const { userId, recipientAccount, amount } = req.body;
  try {
    const balCheck = await pool.query(`SELECT COALESCE(SUM(CASE WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE', 'INTERNAL_TRANSFER') THEN -amount ELSE 0 END), 0) as balance FROM transactions WHERE user_id = $1 AND status = 'Approved'`, [userId]);
    if (parseFloat(balCheck.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, details) VALUES ($1, 'INTERNAL_TRANSFER', $2, 'Pending', $3, 'Transfer')`, [userId, amount, recipientAccount]);
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
    res.json({ success: true, message: 'Deposit submitted.' });
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/investments/deposit', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, reference } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image) VALUES ($1, 'INVESTMENT_DEPOSIT', $2, 'Pending', $3, $4)`, [userId, amount, reference, imagePath]);
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
    res.json({ success: true, message: `Withdrawal requested for ${timeline} days.` });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// NOTIFICATIONS & CHAT
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

app.post('/api/complaints', upload.single('attachment'), async (req, res) => {
  const { userId, category, subject, message } = req.body;
  const refNum = `CMP-${Math.floor(100000 + Math.random() * 900000)}`;
  try {
    const result = await pool.query(`INSERT INTO complaints (user_id, ref_number, category, subject, message) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [userId, refNum, category, subject, message]);
    const complaintId = result.rows[0].id;
    await pool.query(`INSERT INTO chat_messages (complaint_id, sender, message) VALUES ($1, 'user', $2)`, [complaintId, message]);
    const autoReply = `Welcome to Xanvia Credit Union Support. We have received your inquiry regarding "${subject}". A secure support agent will review your message shortly. Your reference number is ${refNum}.`;
    await pool.query(`INSERT INTO chat_messages (complaint_id, sender, message) VALUES ($1, 'admin', $2)`, [complaintId, autoReply]);
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

// ADMIN ROUTES
app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings');
    const settings = {}; result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/settings/update', async (req, res) => {
  const { btc_address, bank_name, bank_account, bank_routing } = req.body;
  try {
    await pool.query(`
      INSERT INTO system_settings (key, value) VALUES 
      ('btc_address', $1), ('bank_name', $2), ('bank_account', $3), ('bank_routing', $4)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [btc_address, bank_name, bank_account, bank_routing]);
    res.json({ success: true, message: 'Settings updated successfully.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update settings.' }); }
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
      if (tx.type === 'INTERNAL_TRANSFER') {
        const recipient = await client.query('SELECT id FROM users WHERE account_number = $1', [tx.reference]);
        if (recipient.rows.length > 0) {
           await client.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'DEPOSIT', $2, 'Approved')`, [recipient.rows[0].id, tx.amount]);
        }
      }
      if (tx.type === 'INVESTMENT_DEPOSIT') {
        const now = new Date();
        const maturity = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); 
        await client.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit) VALUES ($1, $2, 'Active', $3, $4, $5)`, [tx.user_id, tx.amount, now, maturity, 0]);
      }
    } else {
      await client.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Failed.' }); } finally { client.release(); }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, COALESCE(username, 'N/A') as username, email, status, created_at FROM users WHERE deleted = false ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Database error: ' + err.message }); }
});

app.post('/api/admin/freeze', async (req, res) => {
  const { userId, status } = req.body;
  try {
    await pool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);
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
      for (let u of users.rows) {
        await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [u.id, message]);
      }
    } else {
      await pool.query(`INSERT INTO notifications (user_id, message) VALUES ($1, $2)`, [target, message]);
    }
    res.json({ success: true, message: 'Notification(s) sent!' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/admin/complaints', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.*, u.name, u.email FROM complaints c JOIN users u ON c.user_id = u.id ORDER BY c.created_at DESC`);
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
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));