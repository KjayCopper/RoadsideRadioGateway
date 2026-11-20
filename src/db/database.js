const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../logging/logger');

let db;

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function initDatabase() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  logger.info({ databasePath: config.databasePath }, 'database_initialized');
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS presenters (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
      external_user_ref TEXT,
      created_at TEXT NOT NULL,
      last_connection_at TEXT,
      last_password_change_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_presenters_status ON presenters(status);
    CREATE INDEX IF NOT EXISTS idx_presenters_external_user_ref ON presenters(external_user_ref);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT NOT NULL,
      scope TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
      response_code INTEGER,
      response_body TEXT,
      resource_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (key, scope)
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      presenter_id TEXT,
      username TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  `);
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDatabase,
  getDb,
  closeDatabase,
};
