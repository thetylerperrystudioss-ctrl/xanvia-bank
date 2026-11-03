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
// 2. AUTHENTICATION (ANTI-CRASH REGISTRATION)
// ==========================================
app.post('/api/register', async (req, res) => {
  try {
    // 1. Log exactly what the frontend is sending so you can see it in Render logs
    console.log("INCOMING REGISTRATION DATA:", req.body);

    // 2. Safely extract data with fallbacks
    const email = req.body.email;
    if (!email) {
      return res.status(400).json({ error: 'Email address is required to open an account.' });
    }

    const name = req.body.name || req.body.fullName || 'Xanvia Member';
    const username = req.body.username || email.split('@')[0] + Math.floor(Math.random() * 1000);
    const password = req.body.password || 'XanviaDefault123!'; 
    const age = req.body.age || req.body.dob || null;
    const address = req.body.address || null;
    const ssn = req.body.ssn || req.body.ssn_last4 || null;

    // 3. Check if user already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'This email is already registered. Please log in.' });
    }

    // 4. Hash password and insert user
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const userResult = await pool.query(
      `INSERT INTO users (name, username, email, password, age, address, ssn_last4) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, 
      [name, username.toLowerCase(), email.toLowerCase(), hashedPassword, age, address, ssn]
    );
    
    const newUserId = userResult.rows[0].id;

    // 5. Create default accounts immediately so the dashboard works
    await pool.query(
      `INSERT INTO accounts (user_id, type, balance) VALUES 
       ($1, 'checking', 0), ($1, 'savings', 0), ($1, 'loan', 0), ($1, 'brokerage', 0)`, 
      [newUserId]
    );

    res.json({ success: true, message: 'Account created successfully.' });

  } catch (err) { 
    console.error("CRITICAL REGISTRATION ERROR:", err.message); 
    // Send the exact database error to the frontend so it's not a mystery
    res.status(500).json({ error: 'Database Error: ' + err.message }); 
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
// 3. ACCOUNTS (LIVE BALANCE)
// ==========================================
app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const query = `
      SELECT 
        COALESCE(SUM(
          CASE 
            WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount 
            WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE') THEN -amount
            WHEN type = 'LOAN_TRANSFER' AND details = 'checking' THEN amount
            ELSE 0 
          END
        ), 0) AS checking_balance
      FROM transactions 
      WHERE user_id = $1 AND status = 'Approved';
    `;
    
    const result = await pool.query(query, [req.params.userId]);
    const checkingBalance = parseFloat(result.rows[0].checking_balance) || 0;

    res.json({ 
      checking: checkingBalance,
      savings: 0,
      loan: 0,
      brokerage: 0
    });
  } catch (err) { 
    res.status(500).json({ error: 'Database error.' }); 
  }
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
  } catch (err) { res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, details, accountType } = req.body;
  try {
    const balCheck = await pool.query(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount 
          WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE') THEN -amount
          ELSE 0 
        END
      ), 0) as balance 
      FROM transactions 
      WHERE user_id = $1 AND status = 'Approved'
    `, [userId]);
    
    const currentBalance = parseFloat(balCheck.rows[0].balance);
    if (currentBalance < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'WITHDRAWAL', $2, 'Pending', $3)`, [userId, amount, details]);
    res.json({ success: true, message: 'Withdrawal pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ==========================================
// 5. LOANS (WITH $25 DEPOSIT FEE)
// ==========================================
app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount, age, address, ssn } = req.body;
  
  try {
    if (age || address || ssn) {
      await pool.query(
        `UPDATE users SET age = COALESCE($1, age), address = COALESCE($2, address), ssn_last4 = COALESCE($3, ssn_last4) WHERE id = $4`,
        [age || null, address || null, ssn || null, userId]
      );
    }

    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending')`, [userId, amount]);

    const existingFee = await pool.query(`SELECT * FROM transactions WHERE user_id = $1 AND type = 'FEE' AND status = 'Pending'`, [userId]);
    if (existingFee.rows.length === 0) {
      await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'FEE', 25.00, 'Pending', 'Deposit Fee for Loan Processing')`, [userId]);
    }

    res.json({ success: true, message: 'Application received. A $25 deposit fee is required to process your loan.' });
  } catch (err) { 
    res.status(500).json({ error: 'Failed.' }); 
  }
});

app.post('/api/fee/pay', upload.single('screenshot'), async (req, res) => {
  const { userId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Payment screenshot required.' });
  
  const imagePath = `/uploads/${req.file.filename}`;
  try {
    await pool.query(`
      UPDATE transactions 
      SET proof_image = $1, status = 'Pending Admin Approval' 
      WHERE user_id = $2 AND type = 'FEE' AND status = 'Pending'
    `, [imagePath, userId]);
    res.json({ success: true, message: 'Fee payment submitted. Awaiting Admin confirmation.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ==========================================
// 6. INVESTMENTS & SUPPORT
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

app.post('/api/complaints', upload.single('attachment'), async (req, res) => {
  const { userId, category, subject, message } = req.body;
  const refNum = `CMP-${Math.floor(100000 + Math.random() * 900000)}`;
  const attachmentPath = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    await pool.query(`INSERT INTO complaints (user_id, ref_number, category, subject, message, attachment) VALUES ($1, $2, $3, $4, $5, $6)`, [userId, refNum, category, subject, message, attachmentPath]);
    res.json({ success: true, message: 'Complaint submitted.', ref: refNum });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

// ==========================================
// 7. ADMIN ROUTES
// ==========================================
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
    if (!tx) return res.status(400).json({ error: 'Invalid.' });
    
    await client.query('BEGIN');
    if (action === 'approve') {
      await client.query(`UPDATE transactions SET status = 'Approved' WHERE id = $1`, [txId]);
      
      if (tx.type === 'FEE') {
        await client.query(`UPDATE transactions SET status = 'Approved' WHERE user_id = $1 AND type = 'LOAN_APPLICATION' AND status = 'Pending'`, [tx.user_id]);
      }
      if (tx.type === 'INVESTMENT_DEPOSIT') {
        const now = new Date();
        const maturity = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        await client.query(`INSERT INTO investments (user_id, amount, status, start_date, maturity_date, profit) VALUES ($1, $2, 'Active', $3, $4, $5)`, [tx.user_id, tx.amount, now, maturity, tx.amount * 2.4]);
      }
    } else {
      await client.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) { 
    await client.query('ROLLBACK'); 
    res.status(500).json({ error: 'Failed.' }); 
  } finally {
    client.release();
  }
});

// ==========================================
// 8. TRANSACTIONS FETCH
// ==========================================
app.get('/api/transactions/:userId', async (req, res) => {
  try { 
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    const cleanRows = result.rows.map(row => ({
      ...row,
      amount: parseFloat(row.amount) || 0
    }));
    res.json(cleanRows); 
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));