const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { badRequest } = require('../utils/httpErrors');
const presenterService = require('../services/presenterService');
const queueManager = require('../services/queueManager');
const eventsRepo = require('../db/eventsRepo');
const { createPresenterIdempotent } = require('../services/presenterCreateService');
const { requireBopApiKey } = require('./authMiddleware');

const router = express.Router();

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(apiLimiter);
router.use(requireBopApiKey);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const createPresenterSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1),
  externalUserRef: z.string().optional().nullable(),
  idempotencyKey: z.string().optional(),
});

router.post('/presenters', asyncHandler(async (req, res, next) => {
  const parsed = createPresenterSchema.safeParse(req.body || {});
  if (!parsed.success) return next(badRequest('Invalid request body', parsed.error.flatten()));
  const idemKey = req.header('Idempotency-Key') || parsed.data.idempotencyKey || null;
  const { username, displayName, externalUserRef } = parsed.data;
  const result = await createPresenterIdempotent({ username, displayName, externalUserRef }, idemKey, { actor: 'bop_api' });
  return res.status(result.statusCode || 201).json(result.body);
}));

router.get('/presenters', asyncHandler(async (_req, res) => {
  res.json({ presenters: presenterService.listPresenters() });
}));

router.get('/presenters/:id', asyncHandler(async (req, res, next) => {
  try {
    const presenter = presenterService.getPresenter(req.params.id);
    res.json({ presenter });
  } catch (err) {
    next(err);
  }
}));

const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });
router.patch('/presenters/:id/status', asyncHandler(async (req, res, next) => {
  const parsed = statusSchema.safeParse(req.body || {});
  if (!parsed.success) return next(badRequest('Invalid status payload', parsed.error.flatten()));
  const presenter = await presenterService.setPresenterStatus(req.params.id, parsed.data.status, { actor: 'bop_api' });
  res.json({ presenter });
}));

router.delete('/presenters/:id', asyncHandler(async (req, res) => {
  const result = await presenterService.revokePresenter(req.params.id, { actor: 'bop_api' });
  res.json(result);
}));

router.post('/presenters/:id/regenerate-password', asyncHandler(async (req, res) => {
  const result = await presenterService.regeneratePassword(req.params.id, { actor: 'bop_api' });
  res.json({
    presenterId: result.presenter.id,
    username: result.presenter.username,
    status: result.presenter.status,
    lastPasswordChangeAt: result.presenter.lastPasswordChangeAt,
    password: result.password,
  });
}));

router.get('/queue', asyncHandler(async (_req, res) => {
  const status = queueManager.getStatus();
  res.json({
    live: status.queue.live,
    next: status.queue.next,
    occupancy: status.queue.occupancy,
    capacity: status.queue.capacity,
  });
}));

router.get('/status', asyncHandler(async (_req, res) => {
  const status = queueManager.getStatus();
  res.json({
    gateway: {
      online: status.online,
      name: 'RoadsideRadioGateway',
      version: require('../../package.json').version,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    queue: status.queue,
    source: {
      host: config.gateway.host,
      port: config.gateway.port,
      publicUrl: config.gateway.publicUrl,
    },
  });
}));

router.get('/events', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  const types = typeof req.query.types === 'string' && req.query.types.trim()
    ? req.query.types.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const events = eventsRepo.listRecent(limit, types).map(e => ({
    id: e.id,
    type: e.type,
    level: e.level,
    message: e.message,
    presenterId: e.presenter_id,
    username: e.username,
    details: e.details_json ? JSON.parse(e.details_json) : null,
    createdAt: e.created_at,
  }));
  res.json({ events });
}));

module.exports = router;
