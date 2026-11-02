const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Database Setup
pool.connect((err, client, release) => {
  if (err) console.error('DB Error:', err.message);
  else {
    client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, password VARCHAR(100), role VARCHAR(20) DEFAULT 'user'
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(50), balance DECIMAL(12,2) DEFAULT 0.00
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50), 
        amount DECIMAL(12,2), 
        status VARCHAR(20) DEFAULT 'Pending', 
        reference VARCHAR(100),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE, value TEXT
      );
    `, (err) => {
      release();
      if (err) console.error('Table Error:', err.message);
      else {
        // Insert default settings if they don't exist
        pool.query(`INSERT INTO system_settings (key, value) VALUES ('btc_address', 'bc1q...xanvia'), ('bank_details', 'Xanvia Bank, Acct: 12345678') ON CONFLICT DO NOTHING`);
        console.log('✅ Tables & Settings ready.');
      }
    });
  }
});

// AUTH
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// DASHBOARD DATA
app.get('/api/dashboard/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM accounts WHERE user_id = $1', [req.params.id]);
    const balances = { checking: 0, savings: 0, brokerage: 0, loan: 0 };
    result.rows.forEach(acc => { balances[acc.type] = parseFloat(acc.balance); });
    
    const txRes = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [req.params.id]);
    res.json({ balances, transactions: txRes.rows });
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

// LOAN APPLICATION (15% Deposit Required)
app.post('/api/loans/apply', async (req, res) => {
  const { userId, amount, termMonths, rate } = req.body;
  const depositRequired = amount * 0.15;
  try {
    // Check if user has 15% deposit in checking
    const checkRes = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    if (parseFloat(checkRes.rows[0].balance) < depositRequired) {
      return res.status(400).json({ error: `Insufficient funds for 15% deposit ($${depositRequired.toFixed(2)}).` });
    }

    await pool.query('BEGIN');
    // Deduct the 15% deposit from checking
    await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [depositRequired, userId]);
    // Create a pending loan transaction for Admin
    await pool.query(
      `INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'LOAN_APPLICATION', $2, 'Pending', $3)`,
      [userId, amount, JSON.stringify({ termMonths, rate, depositPaid: depositRequired })]
    );
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Loan application submitted for Admin review. 15% deposit deducted.' });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Loan application failed.' }); }
});

// DEPOSIT REQUEST
app.post('/api/deposit/request', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status) VALUES ($1, 'DEPOSIT', $2, 'Pending')`, [userId, amount]);
    res.json({ success: true, message: 'Deposit request sent to Admin.' });
  } catch (err) { res.status(500).json({ error: 'Request failed.' }); }
});

// WITHDRAWAL REQUEST
app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, details } = req.body;
  try {
    const checkRes = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    if (parseFloat(checkRes.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });

    await pool.query('BEGIN');
    await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [amount, userId]);
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'WITHDRAWAL', $2, 'Pending', $3)`, [userId, amount, details]);
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Withdrawal request pending Admin approval.' });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Request failed.' }); }
});

// EXTERNAL TRANSFER (To other banks)
app.post('/api/transfer/external', async (req, res) => {
  const { userId, amount, bankDetails } = req.body;
  try {
    const checkRes = await pool.query(`SELECT balance FROM accounts WHERE user_id = $1 AND type = 'checking'`, [userId]);
    if (parseFloat(checkRes.rows[0].balance) < amount) return res.status(400).json({ error: 'Insufficient funds.' });

    await pool.query('BEGIN');
    // Hold the funds
    await pool.query(`UPDATE accounts SET balance = balance - $1 WHERE user_id = $2 AND type = 'checking'`, [amount, userId]);
    await pool.query(`INSERT INTO transactions (user_id, type, amount, status, details) VALUES ($1, 'EXTERNAL_TRANSFER', $2, 'Pending', $3)`, [userId, amount, bankDetails]);
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Transfer submitted. Awaiting Admin verification.' });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Transfer failed.' }); }
});

// --- ADMIN ROUTES ---
app.get('/api/admin/requests', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, u.name, u.email 
      FROM transactions t 
      JOIN users u ON t.user_id = u.id 
      WHERE t.status = 'Pending' ORDER BY t.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.get('/api/admin/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM system_settings');
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) { res.status(500).json({ error: 'Database error.' }); }
});

app.post('/api/admin/update-settings', async (req, res) => {
  const { btc_address, bank_details } = req.body;
  try {
    await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'btc_address'`, [btc_address]);
    await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'bank_details'`, [bank_details]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Update failed.' }); }
});

// ADMIN APPROVE/REJECT
app.post('/api/admin/approve', async (req, res) => {
  const { txId, action } = req.body; // action = 'approve' or 'reject'
  try {
    const txRes = await pool.query('SELECT * FROM transactions WHERE id = $1', [txId]);
    const tx = txRes.rows[0];
    if (!tx || tx.status !== 'Pending') return res.status(400).json({ error: 'Invalid transaction.' });

    await pool.query('BEGIN');

    if (action === 'approve') {
      await pool.query(`UPDATE transactions SET status = 'Approved' WHERE id = $1`, [txId]);
      
      // Logic based on transaction type
      if (tx.type === 'DEPOSIT') {
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
      } else if (tx.type === 'LOAN_APPLICATION') {
        // On Loan approval, credit the user's checking and add to their loan liability
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'loan'`, [tx.amount, tx.user_id]);
      } 
      // External transfer/withdrawal funds are already deducted. Approval just marks it complete.
      
    } else if (action === 'reject') {
      await pool.query(`UPDATE transactions SET status = 'Rejected' WHERE id = $1`, [txId]);
      
      // Refund funds if they were held
      if (tx.type === 'WITHDRAWAL' || tx.type === 'EXTERNAL_TRANSFER') {
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [tx.amount, tx.user_id]);
      } else if (tx.type === 'LOAN_APPLICATION') {
        // Refund the 15% deposit
        const details = JSON.parse(tx.details);
        await pool.query(`UPDATE accounts SET balance = balance + $1 WHERE user_id = $2 AND type = 'checking'`, [details.depositPaid, tx.user_id]);
      }
    }

    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: 'Approval failed.' }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../index.html')));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));