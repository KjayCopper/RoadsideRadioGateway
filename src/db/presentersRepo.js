const { getDb } = require('./database');

function createPresenter(presenter) {
  const stmt = getDb().prepare(`
    INSERT INTO presenters (id, display_name, username, password_hash, status, external_user_ref, created_at, last_connection_at, last_password_change_at)
    VALUES (@id, @display_name, @username, @password_hash, @status, @external_user_ref, @created_at, @last_connection_at, @last_password_change_at)
  `);
  stmt.run(presenter);
  return getById(presenter.id);
}

function getById(id) {
  return getDb().prepare('SELECT * FROM presenters WHERE id = ?').get(id);
}

function getByUsername(username) {
  return getDb().prepare('SELECT * FROM presenters WHERE username = ? COLLATE NOCASE').get(username);
}

function listPresenters() {
  return getDb().prepare('SELECT * FROM presenters ORDER BY created_at DESC').all();
}

function updateStatus(id, status) {
  const info = getDb().prepare('UPDATE presenters SET status = ? WHERE id = ?').run(status, id);
  return info.changes > 0 ? getById(id) : null;
}

function updatePasswordHash(id, passwordHash, changedAt) {
  const info = getDb().prepare('UPDATE presenters SET password_hash = ?, last_password_change_at = ? WHERE id = ?').run(passwordHash, changedAt, id);
  return info.changes > 0 ? getById(id) : null;
}

function updateLastConnection(id, at) {
  getDb().prepare('UPDATE presenters SET last_connection_at = ? WHERE id = ?').run(at, id);
}

function deletePresenter(id) {
  const info = getDb().prepare('DELETE FROM presenters WHERE id = ?').run(id);
  return info.changes > 0;
}

module.exports = {
  createPresenter,
  getById,
  getByUsername,
  listPresenters,
  updateStatus,
  updatePasswordHash,
  updateLastConnection,
  deletePresenter,
};
