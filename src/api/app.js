const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const config = require('../config');
const logger = require('../logging/logger');
const routes = require('./routes');
const { HttpError } = require('../utils/httpErrors');

function createApiApp() {
  const app = express();
  if (config.admin.trustProxy) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: false, // API-only; no browser UI served
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(pinoHttp({
    logger,
    autoLogging: { ignore: (req) => req.url === '/healthz' },
    redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
  }));

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, queue: require('../services/queueManager').getStatus().queue });
  });

  app.use('/api/v1', routes);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    req.log?.error({ err }, 'unhandled_api_error');
    return res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}

module.exports = { createApiApp };
