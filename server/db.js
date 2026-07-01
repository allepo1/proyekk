const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_FILE = path.join(__dirname, 'data', 'app.db');
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    passwordHash TEXT,
    createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    title TEXT,
    text TEXT,
    canvasJson TEXT,
    audioUrl TEXT,
    tags TEXT,
    createdAt TEXT,
    updatedAt TEXT,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  // Migration safety net: older app.db files created before the `title`
  // column existed won't have it. Add it if missing so upgrades don't crash.
  db.all(`PRAGMA table_info(notes)`, (err, cols) => {
    if (err) return;
    const hasTitle = Array.isArray(cols) && cols.some((c) => c.name === 'title');
    if (!hasTitle) {
      db.run(`ALTER TABLE notes ADD COLUMN title TEXT`);
    }
  });

  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_userId ON notes(userId)`);
});

module.exports = db;
