const { z } = require('zod');
const config = require('../config');
const { randomId } = require('../utils/crypto');
const { badRequest, conflict, notFound } = require('../utils/httpErrors');
const presentersRepo = require('../db/presentersRepo');
const { hashPassword, verifyPassword, createGeneratedPassword } = require('./passwordService');
const { emit } = require('./eventService');
const queueManager = require('./queueManager');

const usernameSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Username may contain letters, numbers, dot, underscore and hyphen');
const displayNameSchema = z.string().trim().min(1).max(120);
const externalRefSchema = z.string().trim().max(255).optional().nullable();
const statusSchema = z.enum(['active', 'suspended']);

function toPublicPresenter(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username,
    status: row.status,
    externalUserRef: row.external_user_ref || null,
    createdAt: row.created_at,
    lastConnectionAt: row.last_connection_at || null,
    lastPasswordChangeAt: row.last_password_change_at,
  };
}

async function createPresenter(input, { actor = 'api' } = {}) {
  const parsed = z.object({
    username: usernameSchema,
    displayName: displayNameSchema,
    externalUserRef: externalRefSchema,
  }).safeParse(input);
  if (!parsed.success) throw badRequest('Invalid presenter data', parsed.error.flatten());

  const { username, displayName } = parsed.data;
  const externalUserRef = parsed.data.externalUserRef || null;
  const existing = presentersRepo.getByUsername(username);
  if (existing) throw conflict('Username already exists', { field: 'username' });

  const now = new Date().toISOString();
  const password = createGeneratedPassword();
  const passwordHash = await hashPassword(password);
  const presenter = {
    id: randomId('prs'),
    display_name: displayName,
    username,
    password_hash: passwordHash,
    status: 'active',
    external_user_ref: externalUserRef,
    created_at: now,
    last_connection_at: null,
    last_password_change_at: now,
  };

  const created = presentersRepo.createPresenter(presenter);
  emit('account_created', { message: 'Presenter account created', presenterId: created.id, username: created.username, details: { actor, externalUserRef } });
  return { presenter: toPublicPresenter(created), password };
}

function listPresenters() {
  return presentersRepo.listPresenters().map(toPublicPresenter);
}

function getPresenter(id) {
  const row = presentersRepo.getById(id);
  if (!row) throw notFound('Presenter not found');
  return toPublicPresenter(row);
}

async function setPresenterStatus(id, status, { actor = 'api' } = {}) {
  const parsed = statusSchema.safeParse(status);
  if (!parsed.success) throw badRequest('Invalid status');
  const existing = presentersRepo.getById(id);
  if (!existing) throw notFound('Presenter not found');
  const updated = presentersRepo.updateStatus(id, parsed.data);
  if (parsed.data === 'suspended') {
    queueManager.disconnectPresenter(id, 'account_suspended');
    emit('account_suspended', { message: 'Presenter account suspended', presenterId: updated.id, username: updated.username, details: { actor } });
  } else {
    emit('account_reactivated', { message: 'Presenter account reactivated', presenterId: updated.id, username: updated.username, details: { actor } });
  }
  return toPublicPresenter(updated);
}

async function regeneratePassword(id, { actor = 'api' } = {}) {
  const existing = presentersRepo.getById(id);
  if (!existing) throw notFound('Presenter not found');
  const now = new Date().toISOString();
  const password = createGeneratedPassword();
  const passwordHash = await hashPassword(password);
  const updated = presentersRepo.updatePasswordHash(id, passwordHash, now);
  queueManager.disconnectPresenter(id, 'password_regenerated');
  emit('password_regenerated', { message: 'Presenter password regenerated', presenterId: updated.id, username: updated.username, details: { actor } });
  return { presenter: toPublicPresenter(updated), password };
}

async function revokePresenter(id, { actor = 'api' } = {}) {
  const existing = presentersRepo.getById(id);
  if (!existing) throw notFound('Presenter not found');
  queueManager.disconnectPresenter(id, 'account_revoked');
  presentersRepo.deletePresenter(id);
  emit('account_revoked', { message: 'Presenter account revoked and deleted', presenterId: existing.id, username: existing.username, details: { actor } });
  return { revoked: true, id: existing.id };
}

async function authenticatePresenter(username, password) {
  const row = presentersRepo.getByUsername(username);
  if (!row) {
    emit('authentication_failed', { level: 'warn', message: 'Presenter authentication failed', username, details: { reason: 'unknown_user' } });
    return { ok: false, reason: 'invalid_credentials' };
  }
  const valid = await verifyPassword(row.password_hash, password);
  if (!valid) {
    emit('authentication_failed', { level: 'warn', message: 'Presenter authentication failed', presenterId: row.id, username: row.username, details: { reason: 'invalid_password' } });
    return { ok: false, reason: 'invalid_credentials', presenter: row };
  }
  if (row.status !== 'active') {
    emit('authentication_failed', { level: 'warn', message: 'Presenter authentication rejected for inactive account', presenterId: row.id, username: row.username, details: { reason: 'account_not_active', status: row.status } });
    return { ok: false, reason: 'account_not_active', presenter: row };
  }
  emit('authentication_succeeded', { message: 'Presenter authenticated', presenterId: row.id, username: row.username });
  return { ok: true, presenter: row };
}

function recordConnection(presenterId) {
  presentersRepo.updateLastConnection(presenterId, new Date().toISOString());
}

module.exports = {
  createPresenter,
  listPresenters,
  getPresenter,
  setPresenterStatus,
  regeneratePassword,
  revokePresenter,
  authenticatePresenter,
  recordConnection,
  toPublicPresenter,
};
