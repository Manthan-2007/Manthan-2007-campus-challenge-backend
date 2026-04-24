const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    
    // Create Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password TEXT,
      name TEXT,
      course TEXT,
      department TEXT,
      section TEXT,
      score INTEGER DEFAULT 0,
      settings TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create Matches table
    db.run(`CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      giverId TEXT,
      completerId TEXT,
      status TEXT,
      taskText TEXT,
      taskCreatedAt DATETIME,
      proofType TEXT,
      proofText TEXT,
      proofMediaUrl TEXT,
      submissionCreatedAt DATETIME,
      expiresAt DATETIME,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(giverId) REFERENCES users(id),
      FOREIGN KEY(completerId) REFERENCES users(id)
    )`);

    // Create MatchQueue table
    db.run(`CREATE TABLE IF NOT EXISTS match_queue (
      userId TEXT PRIMARY KEY,
      status TEXT,
      matchId TEXT,
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(userId) REFERENCES users(id)
    )`);

    // Create Feed table
    db.run(`CREATE TABLE IF NOT EXISTS feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT,
      userName TEXT,
      taskText TEXT,
      proofType TEXT,
      scoreAtPost INTEGER,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(userId) REFERENCES users(id)
    )`);

    // Create Music table
    db.run(`CREATE TABLE IF NOT EXISTS music (
      id TEXT PRIMARY KEY,
      userId TEXT,
      fileName TEXT,
      downloadURL TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(userId) REFERENCES users(id)
    )`);
  }
});

module.exports = db;
