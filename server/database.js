const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Creates a database file called xanvia.db in the server folder
const db = new sqlite3.Database(path.join(__dirname, 'xanvia.db'), (err) => {
  if (err) console.error('Database opening error: ', err);
  console.log('Connected to the Xanvia SQLite database.');
});

// Create users table if it doesn't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);
});

module.exports = db;