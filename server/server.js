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
// 1. BULLETPROOF DATABASE SETUP
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
      CREATE TABLE IF NOT EXISTS system_settings (id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE);
    `, async (err) => {
      if (err) console.error('Create Table Error:', err.message);

      const alterQueries = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(100)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Active'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT false",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS ssn_last4 VARCHAR(4)",
        "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS type VARCHAR(50)",
        "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance DECIMAL(12,2) DEFAULT 0.00",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Active'",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS start_date TIMESTAMP",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS maturity_date TIMESTAMP",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS profit DECIMAL(12,2)",
        "ALTER TABLE investments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS type VARCHAR(50)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(12,2)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'Pending'",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100)",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS details TEXT",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS proof_image TEXT",
        "ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS ref_number VARCHAR(20) UNIQUE",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS category VARCHAR(50)",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS subject VARCHAR(100)",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS message TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Pending'",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS admin_response TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS attachment TEXT",
        "ALTER TABLE complaints ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        "ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS value TEXT"
      ];

      for (let q of alterQueries) {
        try { await client.query(q); } catch (e) { }
      }

      await client.query(`INSERT INTO system_settings (key, value) VALUES 
        ('btc_address', 'bc1q...xanvia'), ('bank_name', 'Chase Bank'), ('bank_account', '123456789'), ('bank_routing', '021000021') 
        ON CONFLICT (key) DO NOTHING`);
      
      release();
      console.log('✅ Database fully upgraded and ready.');
    });
  }
});

// ==========================================
// 2. AUTHENTICATION
// ==========================================
app.post('/api/register', async (req, res) => {
  const { name, username, email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const userResult = await pool.query(
      'INSERT INTO users (name, username, email, password) VALUES ($1, $2, $3, $4) RETURNING id', 
      [name, username.toLowerCase(), email.toLowerCase(), hashedPassword]
    );
    const userId = userResult.rows[0].id;

    // CRITICAL FIX: Create default accounts for the user immediately
    await pool.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0), ($1, 'savings', 0), ($1, 'loan', 0), ($1, 'brokerage', 0)`, [userId]);

    res.json({ success: true });
  } catch (err) { 
    console.error(err);
    res.status(500).json({ error: 'Username or email already exists.' }); 
  }
});

app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body; 
  try {
    const result = await pool.query('SELECT * FROM users WHERE (email = $1 OR username = $1) AND deleted = false', [identifier.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'Frozen') return res.status(403).json({ error: 'Account frozen.' });
    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// ==========================================
// 3. ACCOUNTS (CALCULATED BALANCES)
// ==========================================
app.get('/api/accounts/:userId', async (req, res) => {
  try {
    // 1. Get stored balances
    const accResult = await pool.query('SELECT type, balance FROM accounts WHERE user_id = $1', [req.params.userId]);
    const balances = {};
    accResult.rows.forEach(acc => { balances[acc.type] = parseFloat(acc.balance) || 0; });

    // 2. Ensure checking, savings, loan, brokerage exist in response even if DB is missing them
    if (balances.checking === undefined) balances.checking = 0;
    if (balances.savings === undefined) balances.savings = 0;
    if (balances.loan === undefined) balances.loan = 0;
    if (balances.brokerage === undefined) balances.brokerage = 0;

    res.json(balances);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// ==========================================
// 4. DEPOSIT & WITHDRAWAL
// ==========================================
app.post('/api/deposit/request', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, targetAccount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  
  const imagePath = `/uploads/${req.file.filename}`;

  try {
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, status, reference, proof_image) VALUES ($1, 'DEPOSIT', $2, 'Pending', $3, $4)`, 
      [userId, amount, targetAccount, imagePath]
    );
    res.json({ success: true, message: 'Deposit submitted. Pending Admin approval.' });
  } catch (err) { 
    console.error("DEPOSIT ERROR:", err.message);
    res.status(500).json({ error: 'Server error.' }); 
  }
});

app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, details, accountType } = req.body;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = $2`, [userId, accountType]);
    const currentBalance = check.rows.length > 0 ? parseFloat(check.rows[0].balance) : 0;
    
    if (currentBalance < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    
    // CRITICAL FIX: Provide a fallback for 'details' so it's never NULL (causes $NaN sometimes)
    const safeDetails = details || 'Standard Withdrawal';
    
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'WITHDRAWAL', $2, 'Pending', $3)`, 
      [userId, amount, safeDetails]
    );
    res.json({ success: true, message: 'Withdrawal pending Admin approval.' });
  } catch (err) { 
    console.error("WITHDRAW ERROR:", err);
    res.status(500).json({ error: 'Failed.' }); 
  }
});

// ==========================================
// 5. SUPPORT / COMPLAINTS
// ==========================================
app.post('/api/complaints', upload.single('attachment'), async (req, res) => {
  const { userId, category, subject, message } = req.body;
  const refNum = `CMP-${Math.floor(100000 + Math.random() * 900000)}`;
  const attachmentPath = req.file ? `/uploads/${req.file.filename}` : null;
  
  try {
    await pool.query(`INSERT INTO complaints (user_id, ref_number, category, subject, message, attachment) VALUES ($1, $2, $3, $4, $5, $6)`, 
      [userId, refNum, category, subject, message, attachmentPath]);
    res.json({ success: true, message: 'Complaint submitted.', ref: refNum });
  } catch (err) { 
    console.error("COMPLAINT ERROR:", err.message);
    res.status(500).json({ error: 'Failed.' }); 
  }
});

app.get('/api/complaints/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM complaints WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// 6. INVESTMENTS & LOANS
// ==========================================
app.post('/api/investments/deposit', upload.single('screenshot'), async (req, res) => {
  const { userId, amount, reference } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, proof_image) VALUES ($1, 'INVESTMENT_DEPOSIT', $2, 'Pending', $3, $4)`, [userId, amount, reference, imagePath]);
    res.json({ success: true, message: 'Deposit pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.get('/api/investments/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM investments WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Loan application pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/transfer', async (req, res) => {
  const { userId, amount, destination, bankDetails } = req.body;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'loan'`, [userId]);
    const loanBalance = check.rows.length > 0 ? parseFloat(check.rows[0].balance) : 0;
    
    if (loanBalance < amount) return res.status(400).json({ error: 'Insufficient loan balance.' });
    
    const detailsToStore = destination === 'external' ? JSON.stringify(bankDetails) : destination;
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'LOAN_TRANSFER', $2, 'Pending', $3)`, [userId, amount, detailsToStore]);
    res.json({ success: true, message: 'Transfer pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/loans/repay', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    const check = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    const checkingBalance = check.rows.length > 0 ? parseFloat(check.rows[0].balance) : 0;
    
    if (checkingBalance < amount) return res.status(400).json({ error: 'Insufficient checking funds.' });
    
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_REPAYMENT', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Repayment pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ==========================================
// 7. ADMIN ROUTES
// ==========================================
app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await pool.query(`SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'Pending' ORDER BY t.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/approve', async (req, res) => {
  const { txId, action } = req.body;
  
  const client = await pool.connect();
  try {
    const tx = (await client.query('SELECT * FROM transactions WHERE id = $1', [txId])).rows[0];
    if (!tx || tx.status !== 'Pending') return res.status(400).json({ error: 'Invalid.' });
    
    await client.query('BEGIN');
    if (action === 'approve') {
      await client.query(`UPDATE transactions SET status = 'Approved' WHERE id = $1`, [txId]);
      const now = new Date();
      const maturity = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      if (tx.type === 'DEPOSIT') {
        // Ensure account exists before updating
        await client.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [tx.user_id, tx.reference]);
        await client.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = $3`, [tx.amount, tx.user_id, tx.reference]);
      }
      else if (tx.type === 'INVESTMENT_DEPOSIT') {
        await client.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit) VALUES ($1, $2, 'Active', $3, $4, $5)`, [tx.user_id, tx.amount, now, maturity, tx.amount * 2.4]);
        await client.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'brokerage', 0) ON CONFLICT DO NOTHING`, [tx.user_id]);
        await client.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'brokerage'`, [tx.amount, tx.user_id]);
      }
      else if (tx.type === 'LOAN_APPLICATION') {
        await client.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'loan', 0) ON CONFLICT DO NOTHING`, [tx.user_id]);
        await client.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
      }
      else if (tx.type === 'LOAN_TRANSFER') {
        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
        if (tx.details === 'checking') {
          await client.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0) ON CONFLICT DO NOTHING`, [tx.user_id]);
          await client.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
        }
      }
      else if (tx.type === 'LOAN_REPAYMENT') {
        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
      }
      else if (tx.type === 'WITHDRAWAL') {
        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
      }
    } else {
      await client.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { 
    await client.query('ROLLBACK'); 
    console.error("Approval Error:", err);
    res.status(500).json({ error: 'Failed.' }); 
  } finally {
    client.release();
  }
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

app.get('/api/admin/complaints', async (req, res) => {
  try {
    const result = await pool.query(`SELECT c.*, u.name, u.email FROM complaints c JOIN users u ON c.user_id = u.id ORDER BY c.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/complaints/:id', async (req, res) => {
  const { status, response } = req.body;
  try {
    await pool.query(`UPDATE complaints SET status = $1, admin_response = $2 WHERE id = $3`, [status, response, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings');
    const settings = {}; result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// 8. TRANSACTIONS
// ==========================================
app.get('/api/transactions/:userId', async (req, res) => {
  try { 
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    // Failsafe to prevent $NaN: Force amount to be a float
    const cleanRows = result.rows.map(row => ({
      ...row,
      amount: parseFloat(row.amount) || 0
    }));
    res.json(cleanRows); 
  } 
  catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));