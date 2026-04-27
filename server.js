/* ==========================================================
   CAMPUS CHALLENGE — Express + SQLite Backend
   ========================================================== */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
require('dotenv').config();
const db       = require('./database');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ---------- CORS ---------- */
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

/* ---------- Uploads dir ---------- */
const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
app.use('/uploads', express.static(UPLOADS));

/* ---------- Multer ---------- */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename:    (_req,  file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

/* ---------- DB helpers ---------- */
const dbGet = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r)  => e ? rej(e) : res(r)));
const dbAll = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,rr) => e ? rej(e) : res(rr)));
const dbRun = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e ? rej(e) : res(this); }));
const uid   = ()           => crypto.randomUUID();

/* ---------- AI Moderation ---------- */
const UNSAFE_KEYWORDS = [
  'sex','porn','nude','naked','rape','kill','murder','suicide',
  'bomb','terrorist','drug','cocaine','heroin','meth',
  'fuck','shit','bitch','ass','dick','pussy'
];

async function checkTextToxicity(text) {
  const lower = text.toLowerCase();
  if (UNSAFE_KEYWORDS.some(kw => lower.includes(kw))) return true;

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return false;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [
          { role: 'system', content: 'You are a content moderator for a campus game. Classify if the task text is SAFE or UNSAFE. Unsafe = sexual, violent, illegal, or harmful content. Reply with ONE word: SAFE or UNSAFE.' },
          { role: 'user', content: text }
        ],
        max_tokens: 5,
        temperature: 0,
      })
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim().toUpperCase() === 'UNSAFE';
  } catch (e) {
    console.error('Groq error:', e.message);
    return false;
  }
}

/* ==========================================================
   AUTH
   ========================================================== */

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const id = uid();
    // Using simple plain password as requested by the original server.js fallback
    // (If the user needs bcrypt, we can use it, but plain was in their previous server.js)
    await dbRun('INSERT INTO users (id, email, password, name, score) VALUES (?, ?, ?, ?, 0)',
      [id, email, password, email.split('@')[0]]);
    res.json({ id, email, name: email.split('@')[0], score: 0 });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await dbGet('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    res.json({ id: user.id, email: user.email, name: user.name, score: user.score });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/me?id=
app.get('/api/me', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    const user = await dbGet(
      'SELECT id, email, name, course, department, section, score, settings FROM users WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.settings = user.settings ? JSON.parse(user.settings) : {};
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/user-info?id=
app.get('/api/user-info', async (req, res) => {
  try {
    const { id } = req.query;
    const user = await dbGet(
      'SELECT id, name, course, department, section, score FROM users WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/profile
app.post('/api/profile', async (req, res) => {
  try {
    const { id, name, course, department, section } = req.body;
    await dbRun('UPDATE users SET name=?, course=?, department=?, section=? WHERE id=?',
      [name, course, department, section, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/settings
app.post('/api/settings', async (req, res) => {
  try {
    const { id, settings } = req.body;
    const row = await dbGet('SELECT settings FROM users WHERE id = ?', [id]);
    const prev = row?.settings ? JSON.parse(row.settings) : {};
    const updated = { ...prev, ...settings };
    await dbRun('UPDATE users SET settings=? WHERE id=?', [JSON.stringify(updated), id]);
    res.json({ success: true, settings: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================
   MATCHMAKING
   ========================================================== */

// POST /api/queue/join
app.post('/api/queue/join', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Already matched?
    const me = await dbGet('SELECT * FROM match_queue WHERE userId = ?', [userId]);
    if (me?.status === 'matched') return res.json({ status: 'matched', matchId: me.matchId });

    // Find another waiting user
    const waiting = await dbGet(
      "SELECT * FROM match_queue WHERE status='waiting' AND userId != ? LIMIT 1", [userId]);

    const now = new Date().toISOString();

    if (waiting) {
      const matchId = uid();
      const [giverId, completerId] = Math.random() > 0.5
        ? [userId, waiting.userId] : [waiting.userId, userId];

      const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
      await dbRun(
        `INSERT INTO matches (id, giverId, completerId, status, taskCreatedAt, expiresAt, createdAt)
         VALUES (?, ?, ?, 'PENDING_TASK', ?, ?, ?)`,
        [matchId, giverId, completerId, now, expiresAt, now]);

      await dbRun("UPDATE match_queue SET status='matched', matchId=? WHERE userId=?",
        [matchId, waiting.userId]);
      await dbRun(
        `INSERT INTO match_queue (userId, status, matchId, joinedAt) VALUES (?, 'matched', ?, ?)
         ON CONFLICT(userId) DO UPDATE SET status='matched', matchId=?`,
        [userId, matchId, now, matchId]);

      return res.json({ status: 'matched', matchId });
    }

    // No one waiting — enter queue
    await dbRun(
      `INSERT INTO match_queue (userId, status, joinedAt) VALUES (?, 'waiting', ?)
       ON CONFLICT(userId) DO UPDATE SET status='waiting', matchId=NULL, joinedAt=?`,
      [userId, now, now]);
    res.json({ status: 'waiting' });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// GET /api/queue/poll?userId=
app.get('/api/queue/poll', async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM match_queue WHERE userId = ?', [req.query.userId]);
    if (!row) return res.json({ status: 'not_in_queue' });
    res.json({ status: row.status, matchId: row.matchId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/queue/leave
app.post('/api/queue/leave', async (req, res) => {
  try {
    await dbRun('DELETE FROM match_queue WHERE userId = ?', [req.body.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/match?matchId=
app.get('/api/match', async (req, res) => {
  try {
    const match = await dbGet('SELECT * FROM matches WHERE id = ?', [req.query.matchId]);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    res.json(match);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================
   TASK
   ========================================================== */

// POST /api/match/task
app.post('/api/match/task', async (req, res) => {
  try {
    const { matchId, taskText } = req.body;
    if (!matchId || !taskText) return res.status(400).json({ error: 'matchId and taskText required' });

    const unsafe = await checkTextToxicity(taskText);
    if (unsafe) return res.status(422).json({ error: 'Task blocked by moderation', blocked: true });

    const now      = new Date().toISOString();
    const expires  = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
    await dbRun(
      "UPDATE matches SET taskText=?, status='ACTIVE', taskCreatedAt=?, expiresAt=? WHERE id=?",
      [taskText, now, expires, matchId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/moderate
app.post('/api/moderate', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const abnormal = await checkTextToxicity(text);
    res.json({ abnormal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================
   PROOF & REVIEW
   ========================================================== */

// POST /api/match/proof
app.post('/api/match/proof', async (req, res) => {
  try {
    const { matchId, proofType, proofText, proofMediaUrl } = req.body;
    const now = new Date().toISOString();
    await dbRun(
      "UPDATE matches SET proofType=?, proofText=?, proofMediaUrl=?, status='PENDING_REVIEW', submissionCreatedAt=? WHERE id=?",
      [proofType, proofText || null, proofMediaUrl || null, now, matchId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/match/expire
app.post('/api/match/expire', async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ error: 'matchId required' });
    await dbRun(
      "UPDATE matches SET status='EXPIRED' WHERE id=? AND status IN ('PENDING_TASK','ACTIVE')",
      [matchId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/match/review
app.post('/api/match/review', async (req, res) => {
  try {
    const { matchId, action, completerId, taskText, proofType } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ error: 'action must be approve or reject' });

    const status     = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const scoreDelta = action === 'approve' ? 10 : -5;

    await dbRun("UPDATE matches SET status=? WHERE id=?", [status, matchId]);

    if (completerId) {
      await dbRun('UPDATE users SET score = MAX(0, score + ?) WHERE id=?', [scoreDelta, completerId]);
    }

    if (action === 'approve' && completerId && taskText) {
      const user = await dbGet('SELECT name, score FROM users WHERE id=?', [completerId]);
      await dbRun(
        'INSERT INTO feed (userId, userName, taskText, proofType, scoreAtPost, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        [completerId, user?.name || 'Unknown', taskText, proofType || 'text', user?.score || 0, new Date().toISOString()]);
    }

    res.json({ success: true, scoreDelta });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================
   FEED & LEADERBOARD
   ========================================================== */

app.get('/api/feed', async (_req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM feed ORDER BY createdAt DESC LIMIT 50'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/feed/user', async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM feed WHERE userId=? ORDER BY createdAt DESC', [req.query.id]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    res.json(await dbAll(
      'SELECT id, name, score, course, department FROM users ORDER BY score DESC LIMIT 20'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ==========================================================
   UPLOADS
   ========================================================== */

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;
  const url = `${host}/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, originalName: req.file.originalname });
});

/* ==========================================================
   MUSIC
   ========================================================== */

app.get('/api/music', async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM music WHERE userId=? ORDER BY createdAt DESC', [req.query.userId]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/music', async (req, res) => {
  try {
    const { userId, fileName, downloadURL } = req.body;
    const id = uid();
    await dbRun('INSERT INTO music (id, userId, fileName, downloadURL, createdAt) VALUES (?, ?, ?, ?, ?)',
      [id, userId, fileName, downloadURL, new Date().toISOString()]);
    res.json({ success: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/music/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM music WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- Health ---------- */
app.get('/api/health', (_req, res) => res.json({ success: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`✅ Campus Challenge backend running on port ${PORT}`));
