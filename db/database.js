const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/cafe.db'
  : path.join(__dirname, 'cafe.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      machine_type TEXT NOT NULL,
      customer_name TEXT DEFAULT '',
      players INTEGER DEFAULT 1,
      start_time DATETIME NOT NULL,
      planned_hours REAL NOT NULL DEFAULT 1,
      end_time DATETIME,
      status TEXT DEFAULT 'active',
      rate_per_hour REAL NOT NULL,
      created_by INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      item_type TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      unit_price REAL NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS otp_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      otp TEXT NOT NULL,
      requested_role TEXT NOT NULL DEFAULT 'employee',
      expires_at DATETIME NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
  `);

  // Add players column to existing DB if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN players INTEGER DEFAULT 1`);
    console.log('[DB] Added players column to sessions');
  } catch { /* column already exists */ }

  // Add customer_phone column to existing DB if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN customer_phone TEXT DEFAULT ''`);
    console.log('[DB] Added customer_phone column to sessions');
  } catch { /* column already exists */ }

  // Add free_half_hour column to existing DB if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN free_half_hour INTEGER DEFAULT 0`);
    console.log('[DB] Added free_half_hour column to sessions');
  } catch { /* column already exists */ }

  // Add payment tracking columns to existing DB if missing
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN cash_amount REAL DEFAULT NULL`);
    console.log('[DB] Added cash_amount column to sessions');
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN online_amount REAL DEFAULT NULL`);
    console.log('[DB] Added online_amount column to sessions');
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN custom_amount REAL DEFAULT NULL`);
    console.log('[DB] Added custom_amount column to sessions');
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN custom_comment TEXT DEFAULT NULL`);
    console.log('[DB] Added custom_comment column to sessions');
  } catch { /* column already exists */ }

  // Seed default owner account on first run
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const hash = bcrypt.hashSync('001@Focus', 10);
    db.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('STARK', ?, 'owner')`).run(hash);
    console.log('\n======================================');
    console.log('  The Site – Default owner account:');
    console.log('  Username: STARK');
    console.log('  Password: 001@Focus');
    console.log('======================================\n');
  }

  // Update existing default admin credentials if still using old values
  const oldAdmin = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
  if (oldAdmin) {
    const hash = bcrypt.hashSync('001@Focus', 10);
    db.prepare(`UPDATE users SET username = 'STARK', password_hash = ? WHERE username = 'admin'`).run(hash);
    console.log('[DB] Admin credentials updated → STARK / 001@Focus');
  }
}

module.exports = { db, initDB };
