const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { randomUUID: uuidv4 } = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure uploads directory exists (important for Railway)
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log('Created uploads directory');
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage });

// --- AUTH ENDPOINTS ---
app.post('/api/signup', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const id = uuidv4();
  const name = email.split('@')[0];
  db.run(`INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)`, [id, email, password, name], function (err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already exists' });
      return res.status(500).json({ error: err.message });
    }
    res.json({ id, email, name, score: 0 });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });
    res.json(user);
  });
});

app.get('/api/me', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'User ID required' });
  db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

app.post('/api/profile', (req, res) => {
  const { id, name, course, department, section } = req.body;
  db.run(`UPDATE users SET name = ?, course = ?, department = ?, section = ? WHERE id = ?`,
    [name, course, department, section, id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/settings', (req, res) => {
  const { id, settings } = req.body;
  db.get(`SELECT settings FROM users WHERE id = ?`, [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const current = row.settings ? JSON.parse(row.settings) : {};
    const updated = { ...current, ...settings };
    db.run(`UPDATE users SET settings = ? WHERE id = ?`, [JSON.stringify(updated), id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, settings: updated });
    });
  });
});

// --- FEED & LEADERBOARD ---
app.get('/api/feed', (req, res) => {
  db.all(`SELECT * FROM feed ORDER BY createdAt DESC LIMIT 30`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/feed/user', (req, res) => {
  const { id } = req.query;
  db.all(`SELECT * FROM feed WHERE userId = ? ORDER BY createdAt DESC LIMIT 20`, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/leaderboard', (req, res) => {
  db.all(`SELECT id, name, score FROM users ORDER BY score DESC LIMIT 20`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// --- MATCHMAKING ---
app.post('/api/queue/join', (req, res) => {
  const { userId } = req.body;
  db.run(`INSERT OR REPLACE INTO match_queue (userId, status, matchId) VALUES (?, 'waiting', NULL)`, [userId], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    // Try to find a match right away
    db.get(`SELECT userId FROM match_queue WHERE status = 'waiting' AND userId != ? LIMIT 1`, [userId], (err, other) => {
      if (other) {
        const matchId = uuidv4();
        const isGiver = Math.random() > 0.5;
        const giverId = isGiver ? userId : other.userId;
        const completerId = isGiver ? other.userId : userId;

        db.run(`INSERT INTO matches (id, giverId, completerId, status) VALUES (?, ?, ?, 'PENDING_TASK')`,
          [matchId, giverId, completerId], function (err) {
            if (err) return console.error(err);
            db.run(`UPDATE match_queue SET status = 'matched', matchId = ? WHERE userId IN (?, ?)`,
              [matchId, userId, other.userId]);
          });
      }
      res.json({ success: true });
    });
  });
});

app.get('/api/queue/poll', (req, res) => {
  const { userId } = req.query;
  db.get(`SELECT * FROM match_queue WHERE userId = ?`, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || { status: 'none' });
  });
});

app.post('/api/queue/leave', (req, res) => {
  const { userId } = req.body;
  db.run(`DELETE FROM match_queue WHERE userId = ?`, [userId], () => res.json({ success: true }));
});

app.get('/api/match', (req, res) => {
  const { matchId } = req.query;
  db.get(`SELECT * FROM matches WHERE id = ?`, [matchId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

app.post('/api/match/task', async (req, res) => {
  const { matchId, taskText } = req.body;
  
  // Check if task is appropriate using AI moderation
  const moderation = await checkTextToxicity(taskText);
  
  if (moderation.isToxic) {
    return res.status(400).json({ 
      error: "Task contains inappropriate content. Please write a clean task.",
      moderated: true,
      score: moderation.score
    });
  }

  db.run(`UPDATE matches SET status = 'ACTIVE', taskText = ?, taskCreatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
    [taskText, matchId], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, moderated: true, score: moderation.score });
    });
});

app.post('/api/match/proof', (req, res) => {
  const { matchId, proofType, proofText, proofMediaUrl } = req.body;
  db.run(`UPDATE matches SET status = 'PENDING_REVIEW', proofType = ?, proofText = ?, proofMediaUrl = ?, submissionCreatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
    [proofType, proofText, proofMediaUrl, matchId], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

app.post('/api/match/review', (req, res) => {
  const { matchId, action, completerId, taskText, proofType } = req.body;
  const approved = action === 'approve';
  const scoreDelta = approved ? 10 : -5;

  db.run(`UPDATE matches SET status = ? WHERE id = ?`, [approved ? 'APPROVED' : 'REJECTED', matchId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.run(`UPDATE users SET score = score + ? WHERE id = ?`, [scoreDelta, completerId], function (err) {
      if (approved) {
        db.get(`SELECT name, score FROM users WHERE id = ?`, [completerId], (err, user) => {
          db.run(`INSERT INTO feed (userId, userName, taskText, proofType, scoreAtPost) VALUES (?, ?, ?, ?, ?)`,
            [completerId, user.name, taskText, proofType, user.score]);
        });
      }
      res.json({ success: true, scoreDelta });
    });
  });
});

app.post('/api/match/expire', (req, res) => {
  const { matchId } = req.body;
  db.run(`UPDATE matches SET status = 'EXPIRED' WHERE id = ?`, [matchId], () => res.json({ success: true }));
});

// --- MEDIA & MUSIC ---
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `${req.protocol}://${req.get('host')}`;
  const url = `${host}/uploads/${req.file.filename}`;
  res.json({ url, filename: req.file.filename, originalName: req.file.originalname });
});

app.post('/api/music', (req, res) => {
  const { userId, fileName, downloadURL } = req.body;
  const id = uuidv4();
  db.run(`INSERT INTO music (id, userId, fileName, downloadURL) VALUES (?, ?, ?, ?)`,
    [id, userId, fileName, downloadURL], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id });
    });
});

app.get('/api/music', (req, res) => {
  const { userId } = req.query;
  db.all(`SELECT * FROM music WHERE userId = ? ORDER BY createdAt DESC`, [userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.delete('/api/music/:id', (req, res) => {
  db.run(`DELETE FROM music WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// --- PUBLIC USER INFO (for opponent reveal) ---
app.get('/api/user-info', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'User ID required' });
  db.get(`SELECT id, name, course, department, section, score FROM users WHERE id = ?`, [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

// --- MODERATION ---
// AI Moderation using Groq API
const GROQ_API_KEY = process.env.GROQ_API_KEY;

async function checkTextToxicity(text) {
  // Fallback: basic keyword blocking if API key not set
  const BLOCKED = ["kill", "suicide", "self harm", "rape", "sex", "nude", "bomb", "gun", "knife", "drugs", "cocaine", "heroin", "steal", "rob", "hack", "terror"];
  const t = text.toLowerCase();
  if (BLOCKED.some((w) => t.includes(w))) {
    return { isToxic: true, score: 1.0, source: "keyword-filter" };
  }

  // If API key is set, use Groq API
  if (GROQ_API_KEY) {
    try {
      const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'mixtral-8x7b-32768',
            messages: [
              {
                role: 'system',
                content: 'You are a content moderation assistant. Analyze the following text and respond with ONLY "SAFE" or "UNSAFE". Do not explain, just respond with one word.'
              },
              {
                role: 'user',
                content: `Check if this text is appropriate for a campus game. Reject if it contains: violence, sexual content, harassment, discrimination, or illegal activities.\n\nText: "${text}"`
              }
            ],
            max_tokens: 10,
            temperature: 0
          })
        }
      );
      
      if (!response.ok) {
        console.warn("Groq API error:", response.status);
        return { isToxic: false, score: 0, source: "fallback-http-error" };
      }
      
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim().toUpperCase() || "SAFE";
      const isToxic = content === "UNSAFE";
      
      return { isToxic, score: isToxic ? 0.9 : 0.1, source: "groq-api" };
    } catch (err) {
      console.error("Groq API error:", err);
    }
  }

  return { isToxic: false, score: 0, source: "fallback" };
}

app.post("/api/moderate", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });

  const result = await checkTextToxicity(text);
  res.json({ 
    abnormal: result.isToxic, 
    result: result.isToxic ? "abnormal" : "normal",
    score: result.score,
    source: result.source
  });
});

// --- ADMIN ---
app.get('/api/admin/wipe', (req, res) => {
  // Wipe all data from all tables to reset the game
  db.serialize(() => {
    db.run("DELETE FROM matches");
    db.run("DELETE FROM match_queue");
    db.run("DELETE FROM feed");
    db.run("DELETE FROM music");
    db.run("DELETE FROM users", (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, message: "Database fully wiped!" });
    });
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
