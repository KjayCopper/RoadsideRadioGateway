const { getDb } = require('./database');

function countAdmins() {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM admins').get();
  return row.count;
}

function getByUsername(username) {
  return getDb().prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(username);
}

function getById(id) {
  return getDb().prepare('SELECT * FROM admins WHERE id = ?').get(id);
}

function createAdmin(admin) {
  getDb().prepare(`
    INSERT INTO admins (id, username, password_hash, created_at, last_login_at)
    VALUES (@id, @username, @password_hash, @created_at, @last_login_at)
  `).run(admin);
  return getById(admin.id);
}

function updateLastLogin(id, at) {
  getDb().prepare('UPDATE admins SET last_login_at = ? WHERE id = ?').run(at, id);
}

module.exports = {
  countAdmins,
  getByUsername,
  getById,
  createAdmin,
  updateLastLogin,
};
