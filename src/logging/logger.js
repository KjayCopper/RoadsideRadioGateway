const pino = require('pino');
const config = require('../config');

const redactPaths = [
  'password',
  'newPassword',
  'generatedPassword',
  'req.body.password',
  'req.body.newPassword',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  'apiKey',
  'BOP_API_KEY',
  'SESSION_SECRET',
  'sessionSecret',
  'secret',
  'passwordHash',
  'hash',
  'token',
  'sessionID',
  'sessionId',
  'encryptionKey',
];

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  base: {
    service: 'roadsideradiogateway',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
