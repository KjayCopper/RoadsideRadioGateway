const fs = require('fs');
const os = require('os');
const path = require('path');

function setupTestEnv(overrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rrg-test-'));
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'error';
  process.env.DATA_DIR = tmp;
  process.env.DATABASE_PATH = path.join(tmp, 'test.sqlite');
  process.env.GATEWAY_HOST = '127.0.0.1';
  process.env.GATEWAY_PORT = '0';
  process.env.ADMIN_HOST = '127.0.0.1';
  process.env.ADMIN_PORT = '0';
  process.env.BOP_API_KEY = overrides.BOP_API_KEY || 'test-bop-api-key-0123456789abcdef';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.LIQUIDSOAP_HOST = '127.0.0.1';
  process.env.LIQUIDSOAP_PORT = String(overrides.LIQUIDSOAP_PORT || 0);
  process.env.LIQUIDSOAP_MOUNT = '/presenter';
  process.env.LIQUIDSOAP_USER = 'source';
  process.env.LIQUIDSOAP_PASSWORD = 'test-harbor-pass';
  process.env.SOURCE_READ_TIMEOUT_MS = '5000';
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
  process.env.API_RATE_LIMIT_MAX = '1000';
  for (const [k, v] of Object.entries(overrides)) process.env[k] = String(v);
  return tmp;
}

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  }
  // also config/logger cached
  for (const key of Object.keys(require.cache)) {
    if (key.includes('RoadsideRadioGateway')) delete require.cache[key];
  }
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { setupTestEnv, resetModules, cleanupDir };
