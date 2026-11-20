const config = require('../config');
const { timingSafeEqualString } = require('../utils/crypto');
const { unauthorized, internal } = require('../utils/httpErrors');

function extractApiKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return '';
}

function requireBopApiKey(req, _res, next) {
  const expected = config.bop.apiKey;
  if (!expected) return next(internal('BOP API key is not configured on the gateway'));
  const provided = extractApiKey(req);
  if (!provided || !timingSafeEqualString(provided, expected)) {
    return next(unauthorized('Invalid API credentials'));
  }
  return next();
}

module.exports = { requireBopApiKey, extractApiKey };
