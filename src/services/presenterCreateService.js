const crypto = require('crypto');
const { z } = require('zod');
const { getDb } = require('../db/database');
const presentersRepo = require('../db/presentersRepo');
const idempotencyRepo = require('../db/idempotencyRepo');
const { randomId } = require('../utils/crypto');
const { badRequest, conflict } = require('../utils/httpErrors');
const { hashPassword, createGeneratedPassword } = require('./passwordService');
const { emit } = require('./eventService');

const schema = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Username may contain letters, numbers, dot, underscore and hyphen'),
  displayName: z.string().trim().min(1).max(120),
  externalUserRef: z.string().trim().max(255).optional().nullable(),
});

function requestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function publicPresenter(row) {
  return {
    presenterId: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    externalUserRef: row.external_user_ref || null,
    createdAt: row.created_at,
    lastConnectionAt: row.last_connection_at || null,
    lastPasswordChangeAt: row.last_password_change_at,
  };
}

async function createPresenterIdempotent(input, idempotencyKey, { actor = 'bop_api' } = {}) {
  const parsed = schema.safeParse(input || {});
  if (!parsed.success) throw badRequest('Invalid presenter data', parsed.error.flatten());
  const payload = {
    username: parsed.data.username,
    displayName: parsed.data.displayName,
    externalUserRef: parsed.data.externalUserRef || null,
  };
  const scope = 'POST:/api/v1/presenters';
  const hash = requestHash(payload);
  const db = getDb();

  if (idempotencyKey) {
    const existing = idempotencyRepo.get(idempotencyKey, scope);
    if (existing) {
      if (existing.request_hash !== hash) throw conflict('Idempotency key reuse with different request payload');
      if (existing.status === 'completed' && existing.response_body) {
        const body = JSON.parse(existing.response_body);
        body.password = null;
        body.idempotentReplay = true;
        return { statusCode: existing.response_code || 200, body, replay: true };
      }
      throw conflict('A request with this idempotency key is still in progress');
    }
  }

  // Expensive hash outside transaction
  const password = createGeneratedPassword();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const presenter = {
    id: randomId('prs'),
    display_name: payload.displayName,
    username: payload.username,
    password_hash: passwordHash,
    status: 'active',
    external_user_ref: payload.externalUserRef,
    created_at: now,
    last_connection_at: null,
    last_password_change_at: now,
  };

  const result = db.transaction(() => {
    if (idempotencyKey) {
      const existing = idempotencyRepo.get(idempotencyKey, scope);
      if (existing) {
        if (existing.request_hash !== hash) return { error: conflict('Idempotency key reuse with different request payload') };
        if (existing.status === 'completed' && existing.response_body) {
          const body = JSON.parse(existing.response_body);
          body.password = null;
          body.idempotentReplay = true;
          return { replay: { statusCode: existing.response_code || 200, body } };
        }
        return { error: conflict('A request with this idempotency key is still in progress') };
      }
    }

    const byUsername = presentersRepo.getByUsername(payload.username);
    if (byUsername) return { error: conflict('Username already exists', { field: 'username' }) };

    presentersRepo.createPresenter(presenter);
    const full = publicPresenter(presenter);
    const responseBody = { ...full, password }; // returned once to caller
    const storedBody = { ...full }; // no password persisted for replay safety

    if (idempotencyKey) {
      idempotencyRepo.createInProgress({
        key: idempotencyKey,
        scope,
        request_hash: hash,
        status: 'completed',
        response_code: 201,
        response_body: JSON.stringify(storedBody),
        resource_id: presenter.id,
        created_at: now,
        updated_at: now,
      });
    }

    return { created: { statusCode: 201, body: responseBody } };
  })();

  if (result.error) throw result.error;
  if (result.replay) return { ...result.replay, replay: true };

  emit('account_created', { message: 'Presenter account created', presenterId: presenter.id, username: presenter.username, details: { actor, externalUserRef: payload.externalUserRef } });
  return { ...result.created, replay: false };
}

module.exports = { createPresenterIdempotent };
