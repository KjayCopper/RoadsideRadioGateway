const { getDb } = require('./database');

function get(key, scope) {
  return getDb().prepare('SELECT * FROM idempotency_keys WHERE key = ? AND scope = ?').get(key, scope);
}

function createInProgress(record) {
  getDb().prepare(`
    INSERT INTO idempotency_keys (key, scope, request_hash, status, response_code, response_body, resource_id, created_at, updated_at)
    VALUES (@key, @scope, @request_hash, @status, @response_code, @response_body, @resource_id, @created_at, @updated_at)
  `).run(record);
}

function complete(key, scope, fields) {
  getDb().prepare(`
    UPDATE idempotency_keys
    SET status = 'completed', response_code = @response_code, response_body = @response_body, resource_id = @resource_id, updated_at = @updated_at
    WHERE key = @key AND scope = @scope
  `).run({ key, scope, ...fields });
}

function deleteKey(key, scope) {
  getDb().prepare('DELETE FROM idempotency_keys WHERE key = ? AND scope = ?').run(key, scope);
}

module.exports = {
  get,
  createInProgress,
  complete,
  deleteKey,
};
