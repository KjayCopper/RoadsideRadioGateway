const path = require('path');

function env(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

function envInt(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

const dataDir = path.resolve(env('DATA_DIR', path.join(process.cwd(), 'data')));
const config = {
  env: env('NODE_ENV', 'development'),
  logLevel: env('LOG_LEVEL', 'info'),
  dataDir,
  databasePath: path.resolve(env('DATABASE_PATH', path.join(dataDir, 'gateway.sqlite'))),
  gateway: {
    host: env('GATEWAY_HOST', '0.0.0.0'),
    port: envInt('GATEWAY_PORT', 8005),
    publicUrl: env('GATEWAY_PUBLIC_URL', 'https://broadcast.roadsideradio.co.uk:8005'),
    allowDuplicatePresenterConnections: envBool('ALLOW_DUPLICATE_PRESENTER_CONNECTIONS', false),
    sourceReadTimeoutMs: envInt('SOURCE_READ_TIMEOUT_MS', 30000),
  },
  admin: {
    host: env('ADMIN_HOST', '0.0.0.0'),
    port: envInt('ADMIN_PORT', 3000),
    baseUrl: env('ADMIN_BASE_URL', 'http://localhost:3000'),
    trustProxy: envBool('TRUST_PROXY', false),
  },
  session: {
    secret: env('SESSION_SECRET', ''),
    cookieName: env('SESSION_COOKIE_NAME', 'rrg_admin_session'),
    maxAgeHours: envInt('SESSION_MAX_AGE_HOURS', 12),
    secureCookies: envBool('SECURE_COOKIES', true),
  },
  bootstrap: {
    initialAdminUsername: env('INITIAL_ADMIN_USERNAME', ''),
    initialAdminPassword: env('INITIAL_ADMIN_PASSWORD', ''),
  },
  bop: {
    apiKey: env('BOP_API_KEY', ''),
  },
  liquidsoap: {
    host: env('LIQUIDSOAP_HOST', '127.0.0.1'),
    port: envInt('LIQUIDSOAP_PORT', 9001),
    mount: env('LIQUIDSOAP_MOUNT', '/presenter'),
    user: env('LIQUIDSOAP_USER', 'source'),
    password: env('LIQUIDSOAP_PASSWORD', ''),
    protocol: env('LIQUIDSOAP_PROTOCOL', 'put').toLowerCase(),
    connectTimeoutMs: envInt('FORWARD_CONNECT_TIMEOUT_MS', 5000),
  },
  rateLimit: {
    authWindowMs: envInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    authMax: envInt('AUTH_RATE_LIMIT_MAX', 20),
    apiWindowMs: envInt('API_RATE_LIMIT_WINDOW_MS', 60 * 1000),
    apiMax: envInt('API_RATE_LIMIT_MAX', 120),
  },
};

module.exports = config;
