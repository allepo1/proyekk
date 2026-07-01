const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    cb(null, `${Date.now()}-${base}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB safety cap for audio notes
});

app.use('/', express.static(path.join(__dirname, '..', 'client')));

app.get('/api/ping', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- Auth ----------

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Email valid dan password (min. 6 karakter) wajib diisi' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();
    db.run('INSERT INTO users (email, passwordHash, createdAt) VALUES (?,?,?)', [email, hash, createdAt], function (err) {
      if (err) {
        if (String(err.message || '').includes('UNIQUE')) {
          return res.status(409).json({ error: 'Email sudah terdaftar' });
        }
        return res.status(500).json({ error: 'Gagal mendaftar' });
      }
      const userId = this.lastID;
      const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, userId, email });
    });
  } catch (e) {
    res.status(500).json({ error: 'Gagal mendaftar' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email dan password wajib diisi' });
  db.get('SELECT id, email, passwordHash FROM users WHERE email = ?', [email], async (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'Email atau password salah' });
    try {
      const ok = await bcrypt.compare(password, row.passwordHash);
      if (!ok) return res.status(401).json({ error: 'Email atau password salah' });
      const token = jwt.sign({ userId: row.id }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, userId: row.id, email: row.email });
    } catch (e) {
      res.status(500).json({ error: 'Gagal login' });
    }
  });
});

function verifyTokenHeader(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return null;
  try {
    return jwt.verify(m[1], JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const payload = verifyTokenHeader(req);
  if (!payload) return res.status(401).json({ error: 'Sesi tidak valid, silakan login kembali' });
  req.userId = payload.userId;
  next();
}

// ---------- Audio upload ----------

app.post('/api/upload-audio', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file audio' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url });
});

// ---------- Notes ----------

function rowToNote(row) {
  return {
    id: row.id,
    title: row.title || '',
    text: row.text || '',
    canvas: safeParse(row.canvasJson, {}),
    audio: row.audioUrl || null,
    tags: safeParse(row.tags, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch (e) {
    return fallback;
  }
}

// List / search notes for the authenticated user
app.get('/api/notes', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const sql = `SELECT id, title, text, canvasJson, audioUrl, tags, createdAt, updatedAt
               FROM notes
               WHERE userId = ? AND (title LIKE ? OR text LIKE ? OR tags LIKE ?)
               ORDER BY updatedAt DESC`;
  db.all(sql, [req.userId, like, like, like], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Gagal memuat catatan' });
    res.json({ notes: rows.map(rowToNote) });
  });
});

// Get a single note (with full canvas/audio payload)
app.get('/api/notes/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID tidak valid' });
  db.get(
    `SELECT id, title, text, canvasJson, audioUrl, tags, createdAt, updatedAt FROM notes WHERE id = ? AND userId = ?`,
    [id, req.userId],
    (err, row) => {
      if (err) return res.status(500).json({ error: 'Gagal memuat catatan' });
      if (!row) return res.status(404).json({ error: 'Catatan tidak ditemukan' });
      res.json({ note: rowToNote(row) });
    }
  );
});

// Create or update (upsert) a note. Pass `id` in the body to update.
app.post('/api/save-note', requireAuth, (req, res) => {
  const note = req.body || {};
  const now = new Date().toISOString();
  const title = typeof note.title === 'string' ? note.title.slice(0, 300) : '';
  const text = typeof note.text === 'string' ? note.text : '';
  const canvasJson = JSON.stringify(note.canvas || {});
  const audioUrl = note.audio || null;
  const tagsJson = JSON.stringify(Array.isArray(note.tags) ? note.tags : []);

  const id = Number(note.id);
  const isUpdate = Number.isInteger(id) && id > 0;

  if (isUpdate) {
    db.run(
      `UPDATE notes SET title = ?, text = ?, canvasJson = ?, audioUrl = ?, tags = ?, updatedAt = ?
       WHERE id = ? AND userId = ?`,
      [title, text, canvasJson, audioUrl, tagsJson, now, id, req.userId],
      function (err) {
        if (err) return res.status(500).json({ error: 'Gagal menyimpan catatan' });
        if (this.changes === 0) return res.status(404).json({ error: 'Catatan tidak ditemukan' });
        io.to('user_' + req.userId).emit('note:updated', { id, userId: req.userId });
        res.json({ ok: true, id, updatedAt: now });
      }
    );
    return;
  }

  const createdAt = now;
  db.run(
    `INSERT INTO notes (userId, title, text, canvasJson, audioUrl, tags, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)`,
    [req.userId, title, text, canvasJson, audioUrl, tagsJson, createdAt, now],
    function (err) {
      if (err) return res.status(500).json({ error: 'Gagal menyimpan catatan' });
      const newId = this.lastID;
      io.to('user_' + req.userId).emit('note:created', { id: newId, userId: req.userId });
      res.json({ ok: true, id: newId, createdAt, updatedAt: now });
    }
  );
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID tidak valid' });
  db.run(`DELETE FROM notes WHERE id = ? AND userId = ?`, [id, req.userId], function (err) {
    if (err) return res.status(500).json({ error: 'Gagal menghapus catatan' });
    if (this.changes === 0) return res.status(404).json({ error: 'Catatan tidak ditemukan' });
    io.to('user_' + req.userId).emit('note:deleted', { id, userId: req.userId });
    res.json({ ok: true });
  });
});

app.use('/uploads', express.static(UPLOADS_DIR));

// 404 handler for unknown /api routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan' }));

const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  const token = socket.handshake.query && socket.handshake.query.token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.join('user_' + payload.userId);
    } catch (e) {
      /* invalid token: socket stays unauthenticated, no rooms joined */
    }
  }

  socket.on('join_note', (data) => {
    if (data && data.noteId) socket.join('note_' + data.noteId);
  });

  socket.on('note:update', (data) => {
    if (data && data.noteId) socket.to('note_' + data.noteId).emit('note:update', data);
  });

  socket.on('play', (data) => {
    if (data && data.userId) io.to('user_' + data.userId).emit('play', data);
    if (data && data.noteId) io.to('note_' + data.noteId).emit('play', data);
  });
});

server.listen(port, () => console.log('Server running on http://localhost:' + port));
