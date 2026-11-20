const { randomId } = require('../utils/crypto');
const { getDb } = require('./database');

function logEvent({ type, level = 'info', message, presenterId = null, username = null, details = null }) {
  const row = {
    id: randomId('evt'),
    type,
    level,
    message,
    presenter_id: presenterId,
    username,
    details_json: details ? JSON.stringify(details) : null,
    created_at: new Date().toISOString(),
  };
  getDb().prepare(`
    INSERT INTO events (id, type, level, message, presenter_id, username, details_json, created_at)
    VALUES (@id, @type, @level, @message, @presenter_id, @username, @details_json, @created_at)
  `).run(row);
  return row;
}

function listRecent(limit = 100, types = null) {
  if (Array.isArray(types) && types.length) {
    const placeholders = types.map(() => '?').join(',');
    return getDb().prepare(`SELECT * FROM events WHERE type IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`).all(...types, limit);
  }
  return getDb().prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
  logEvent,
  listRecent,
};
