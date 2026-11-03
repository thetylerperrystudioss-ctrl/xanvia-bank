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
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS accounts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS investments (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS complaints (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS chat_messages (id SERIAL PRIMARY KEY, complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE, sender VARCHAR(20), message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS system_settings (id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE);
    `, async (err) => {
      if (err) console.error('Create Table Error:', err.message);

      const alterQueries = [
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(100) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(100)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS account_number VARCHAR(20) UNIQUE",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS routing_number VARCHAR(20)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic TEXT",
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

      // Auto-generate account numbers for existing users missing them
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

// ==========================================
// 2. AUTHENTICATION & PROFILE
// ==========================================
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, phone, username } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (!email.toLowerCase().endsWith('@gmail.com')) return res.status(400).json({ error: 'Please enter a valid Gmail address.' });

    const safeName = name || 'Xanvia Member';
    const safeUsername = username || email.split('@')[0] + Math.floor(Math.random() * 1000);
    const accountNumber = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const routingNumber = Math.floor(100000000 + Math.random() * 900000000).toString();

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) return res.status(400).json({ error: 'Email already registered.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      `INSERT INTO users (name, username, email, password, phone, account_number, routing_number) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, 
      [safeName, safeUsername.toLowerCase(), email.toLowerCase(), hashedPassword, phone || null, accountNumber, routingNumber]
    );
    
    const newUserId = userResult.rows[0].id;
    await pool.query(`INSERT INTO accounts (user_id, type, balance) VALUES ($1, 'checking', 0), ($1, 'savings', 0), ($1, 'loan', 0), ($1, 'brokerage', 0)`, [newUserId]);

    res.json({ success: true, message: 'Account created successfully!', userId: newUserId });
  } catch (err) { res.status(500).json({ error: 'Database Error: ' + err.message }); }
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

app.get('/api/lookup-account/:accountNumber', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM users WHERE account_number = $1', [req.params.accountNumber]);
    if (result.rows.length > 0) res.json({ success: true, name: result.rows[0].name });
    else res.status(404).json({ error: 'Account not found' });
  } catch (err) { res.status(500).json({ error: 'Error' }); }
});

// ==========================================
// 3. ONBOARDING & STATUS
// ==========================================
app.post('/api/complete-onboarding', async (req, res) => {
  const { userId, type, age, address, ssn_last4 } = req.body;
  try {
    const userCheck = await pool.query('SELECT age, address, ssn_last4 FROM users WHERE id = $1', [userId]);
    const user = userCheck.rows[0];

    if (user.age && user.address && user.ssn_last4) {
      if (user.age.toString() !== age.toString() || user.address !== address || user.ssn_last4 !== ssn_last4) {
        return res.status(400).json({ error: 'Verification failed. The Date of Birth, Address, or SSN does not match your main account.' });
      }
    } else {
      await pool.query(`UPDATE users SET age = $1, address = $2, ssn_last4 = $3 WHERE id = $4`, [age, address, ssn_last4, userId]);
    }

    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, $2, 0, 'Approved', 'Onboarding completed')`, [userId, type === 'bank' ? 'BANK_ACCOUNT' : type === 'loan' ? 'LOAN_ACCOUNT' : 'INVESTMENT_ACCOUNT']);

    res.json({ success: true, message: 'Application approved!' });
  } catch (err) { res.status(500).json({ error: 'Failed to update profile: ' + err.message }); }
});

app.get('/api/user-status/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    // Check if they have the specific account types
    const txRes = await pool.query('SELECT type FROM transactions WHERE user_id = $1', [userId]);
    const types = txRes.rows.map(r => r.type);

    const has_bank = types.includes('BANK_ACCOUNT');
    const has_loan = types.includes('LOAN_ACCOUNT');
    const has_investment = types.includes('INVESTMENT_ACCOUNT');

    res.json({
      has_bank: has_bank,
      has_loan: has_loan, 
      has_investment: has_investment,
      needs_fee: false 
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch status' }); }
});

// ==========================================
// 4. ACCOUNTS & INVESTMENTS
// ==========================================
app.get('/api/accounts/:userId', async (req, res) => {
  try {
    const query = `
      SELECT COALESCE(SUM(
        CASE 
          WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount 
          WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE', 'INTERNAL_TRANSFER') THEN -amount
          WHEN type = 'LOAN_TRANSFER' AND details = 'checking' THEN amount
          ELSE 0 
        END
      ), 0) AS checking_balance
      FROM transactions WHERE user_id = $1 AND status = 'Approved';
    `;
    const result = await pool.query(query, [req.params.userId]);
    res.json({ checking: parseFloat(result.rows[0].checking_balance) || 0 });
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

// ==========================================
// 5. TRANSFERS & DEPOSITS
// ==========================================
app.post('/api/transfer/internal', async (req, res) => {
  const { userId, recipientAccount, amount } = req.body;
  try {
    const senderAcc = await pool.query('SELECT account_number FROM users WHERE id = $1', [userId]);
    if (senderAcc.rows[0].account_number === recipientAccount) {
      return res.status(400).json({ error: 'You cannot transfer to yourself.' });
    }

    const balCheck = await pool.query(`
      SELECT COALESCE(SUM(
        CASE 
          WHEN type IN ('DEPOSIT', 'LOAN_APPLICATION') THEN amount 
          WHEN type IN ('WITHDRAWAL', 'LOAN_REPAYMENT', 'FEE', 'INTERNAL_TRANSFER') THEN -amount
          ELSE 0 
        END
      ), 0) as balance FROM transactions WHERE user_id = $1 AND status = 'Approved'
    `, [userId]);
    
    if (parseFloat(balCheck.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });
    
    const recipient = await pool.query('SELECT id, name FROM users WHERE account_number = $1', [recipientAccount]);
    if (recipient.rows.length === 0) return res.status(404).json({ error: 'Recipient not found.' });

    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, reference, details) VALUES ($1, 'INTERNAL_TRANSFER', $2, 'Pending', $3, $4)`, 
      [userId, amount, recipientAccount, `Transfer to ${recipient.rows[0].name}`]);

    res.json({ success: true, message: 'Transfer submitted. Pending Admin approval.' });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
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

// ==========================================
// 6. TRANSACTIONS
// ==========================================
app.get('/api/transactions/:userId', async (req, res) => {
  try { 
    const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows.map(row => ({ ...row, amount: parseFloat(row.amount) || 0 }))); 
  } catch (err) { res.status(500).json({ error: 'Error' }); }
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
  } catch (err) { 
    await client.query('ROLLBACK'); 
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));