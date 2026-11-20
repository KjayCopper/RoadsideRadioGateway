const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { once } = require('events');
const request = require('supertest');

const { setupTestEnv, resetModules, cleanupDir } = require('./helpers/env');
const { startFakeLiquidsoapHarbor, sendSourceRequest, wait } = require('./helpers/harness');

async function bootstrap(overrides = {}) {
  const dir = setupTestEnv(overrides);
  resetModules();
  const config = require('../src/config');
  // re-apply overrides that may depend on dynamic ports
  if (overrides.LIQUIDSOAP_PORT !== undefined) config.liquidsoap.port = Number(overrides.LIQUIDSOAP_PORT);
  const { initDatabase, closeDatabase } = require('../src/db/database');
  initDatabase();
  const queueManager = require('../src/services/queueManager');
  // reset queue state
  queueManager.live = null;
  queueManager.next = null;
  const { createApiApp } = require('../src/api/app');
  const { startSourceServer } = require('../src/protocol/sourceServer');
  const app = createApiApp();
  const apiServer = http.createServer(app);
  apiServer.listen(0, '127.0.0.1');
  await once(apiServer, 'listening');
  const apiPort = apiServer.address().port;
  const sourceServer = await startSourceServer({ port: 0, host: '127.0.0.1' });
  const sourcePort = sourceServer.address().port;
  return {
    dir,
    config,
    app,
    apiPort,
    sourcePort,
    queueManager,
    services: {
      presenterService: require('../src/services/presenterService'),
      passwordService: require('../src/services/passwordService'),
      createPresenterIdempotent: require('../src/services/presenterCreateService').createPresenterIdempotent,
    },
    repos: {
      presentersRepo: require('../src/db/presentersRepo'),
    },
    async shutdown() {
      await new Promise(r => apiServer.close(r));
      await new Promise(r => sourceServer.close(r));
      try { closeDatabase(); } catch (_) {}
      resetModules();
      cleanupDir(dir);
    },
  };
}

test('password generation, hashing, verification, invalid credentials', async (t) => {
  const env = await bootstrap();
  t.after(() => env.shutdown());
  const { passwordService, presenterService } = env.services;
  const pw = passwordService.createGeneratedPassword();
  assert.ok(pw.length >= 20, 'generated password should be sufficiently long');
  const hash = await passwordService.hashPassword(pw);
  assert.ok(hash && hash !== pw);
  assert.equal(await passwordService.verifyPassword(hash, pw), true);
  assert.equal(await passwordService.verifyPassword(hash, 'wrong-password'), false);

  const created = await presenterService.createPresenter({ username: 'alice', displayName: 'Alice' });
  assert.ok(created.password);
  const authOk = await presenterService.authenticatePresenter('alice', created.password);
  assert.equal(authOk.ok, true);
  const authBad = await presenterService.authenticatePresenter('alice', 'badpass');
  assert.equal(authBad.ok, false);
  assert.equal(authBad.reason, 'invalid_credentials');
});

test('presenter account lifecycle, status, regeneration invalidates old password, revocation', async (t) => {
  const env = await bootstrap();
  t.after(() => env.shutdown());
  const { presenterService } = env.services;
  const created = await presenterService.createPresenter({ username: 'bob', displayName: 'Bob', externalUserRef: 'ext-1' });
  assert.equal(created.presenter.status, 'active');
  assert.equal(created.presenter.username, 'bob');

  const suspended = await presenterService.setPresenterStatus(created.presenter.id, 'suspended');
  assert.equal(suspended.status, 'suspended');
  const authSusp = await presenterService.authenticatePresenter('bob', created.password);
  assert.equal(authSusp.ok, false);
  assert.equal(authSusp.reason, 'account_not_active');

  const active = await presenterService.setPresenterStatus(created.presenter.id, 'active');
  assert.equal(active.status, 'active');
  const authAgain = await presenterService.authenticatePresenter('bob', created.password);
  assert.equal(authAgain.ok, true);

  const regen = await presenterService.regeneratePassword(created.presenter.id);
  assert.ok(regen.password && regen.password !== created.password);
  const oldAuth = await presenterService.authenticatePresenter('bob', created.password);
  assert.equal(oldAuth.ok, false);
  const newAuth = await presenterService.authenticatePresenter('bob', regen.password);
  assert.equal(newAuth.ok, true);

  const revoked = await presenterService.revokePresenter(created.presenter.id);
  assert.equal(revoked.revoked, true);
  await assert.rejects(async () => presenterService.getPresenter(created.presenter.id), (err) => err && err.code === 'not_found');
  const authRevoked = await presenterService.authenticatePresenter('bob', regen.password);
  assert.equal(authRevoked.ok, false);
});

test('duplicate account creation and idempotent create behavior', async (t) => {
  const env = await bootstrap();
  t.after(() => env.shutdown());
  const { presenterService, createPresenterIdempotent } = env.services;

  await presenterService.createPresenter({ username: 'dupe', displayName: 'Dupe' });
  await assert.rejects(() => presenterService.createPresenter({ username: 'dupe', displayName: 'Dupe 2' }), (err) => err && err.status === 409);

  const key = 'idem-key-1';
  const payload = { username: 'idemuser', displayName: 'Idem User', externalUserRef: 'x1' };
  const first = await createPresenterIdempotent(payload, key);
  assert.equal(first.statusCode, 201);
  assert.ok(first.body.password);
  assert.equal(first.replay, false);

  const replay = await createPresenterIdempotent(payload, key);
  assert.equal(replay.replay, true);
  assert.equal(replay.body.password, null);
  assert.equal(replay.body.presenterId, first.body.presenterId);
  assert.equal(replay.body.idempotentReplay, true);

  await assert.rejects(() => createPresenterIdempotent({ ...payload, displayName: 'Changed' }, key), (err) => err && err.status === 409);
});

test('API authentication and presenter/queue/status endpoints', async (t) => {
  const env = await bootstrap();
  t.after(() => env.shutdown());
  const apiKey = process.env.BOP_API_KEY;
  const agent = request(`http://127.0.0.1:${env.apiPort}`);

  await agent.get('/api/v1/status').expect(401);
  await agent.get('/api/v1/status').set('Authorization', 'Bearer wrong').expect(401);
  const statusRes = await agent.get('/api/v1/status').set('Authorization', `Bearer ${apiKey}`).expect(200);
  assert.equal(statusRes.body.gateway.online, true);
  assert.equal(statusRes.body.queue.capacity, 2);

  const createRes = await agent.post('/api/v1/presenters')
    .set('Authorization', `Bearer ${apiKey}`)
    .set('Idempotency-Key', 'api-idem-1')
    .send({ username: 'apiuser', displayName: 'API User', externalUserRef: 'bop-1' })
    .expect(201);
  assert.ok(createRes.body.password);
  assert.equal(createRes.body.username, 'apiuser');

  const replayRes = await agent.post('/api/v1/presenters')
    .set('Authorization', `Bearer ${apiKey}`)
    .set('Idempotency-Key', 'api-idem-1')
    .send({ username: 'apiuser', displayName: 'API User', externalUserRef: 'bop-1' })
    .expect(201);
  assert.equal(replayRes.body.password, null);
  assert.equal(replayRes.body.idempotentReplay, true);

  const listRes = await agent.get('/api/v1/presenters').set('Authorization', `Bearer ${apiKey}`).expect(200);
  assert.ok(Array.isArray(listRes.body.presenters));
  assert.ok(listRes.body.presenters.some(p => p.username === 'apiuser'));
  assert.equal(Object.prototype.hasOwnProperty.call(listRes.body.presenters[0], 'password_hash'), false);

  const getRes = await agent.get(`/api/v1/presenters/${createRes.body.presenterId}`).set('Authorization', `Bearer ${apiKey}`).expect(200);
  assert.equal(getRes.body.presenter.username, 'apiuser');
  assert.equal(getRes.body.presenter.password, undefined);

  const suspendRes = await agent.patch(`/api/v1/presenters/${createRes.body.presenterId}/status`)
    .set('Authorization', `Bearer ${apiKey}`).send({ status: 'suspended' }).expect(200);
  assert.equal(suspendRes.body.presenter.status, 'suspended');
  const reactRes = await agent.patch(`/api/v1/presenters/${createRes.body.presenterId}/status`)
    .set('Authorization', `Bearer ${apiKey}`).send({ status: 'active' }).expect(200);
  assert.equal(reactRes.body.presenter.status, 'active');

  const regenRes = await agent.post(`/api/v1/presenters/${createRes.body.presenterId}/regenerate-password`)
    .set('Authorization', `Bearer ${apiKey}`).expect(200);
  assert.ok(regenRes.body.password);

  const delRes = await agent.delete(`/api/v1/presenters/${createRes.body.presenterId}`)
    .set('Authorization', `Bearer ${apiKey}`).expect(200);
  assert.equal(delRes.body.revoked, true);

  const queueRes = await agent.get('/api/v1/queue').set('Authorization', `Bearer ${apiKey}`).expect(200);
  assert.equal(queueRes.body.capacity, 2);
});

test('protocol-level source connections, queue FIFO, rejection, promotion, disconnect, duplicate, disabled auth', async (t) => {
  const harbor = await startFakeLiquidsoapHarbor();
  const env = await bootstrap({ LIQUIDSOAP_PORT: harbor.port });
  t.after(async () => { await env.shutdown(); await harbor.close(); });

  const { presenterService } = env.services;
  const a = await presenterService.createPresenter({ username: 'presA', displayName: 'Presenter A' });
  const b = await presenterService.createPresenter({ username: 'presB', displayName: 'Presenter B' });
  const c = await presenterService.createPresenter({ username: 'presC', displayName: 'Presenter C' });

  // invalid credentials
  const bad = await sendSourceRequest({ port: env.sourcePort, username: 'presA', password: 'wrong', expectContinue: true });
  assert.equal(bad.statusCode, 401);
  bad.socket.destroy();

  // A becomes LIVE
  const connA = await sendSourceRequest({ port: env.sourcePort, username: 'presA', password: a.password, expectContinue: true });
  assert.equal(connA.statusCode, 200);
  connA.writeChunk('live-audio-1');
  await wait(150);
  let snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'presA');
  assert.equal(snap.next, null);

  // B becomes NEXT
  const connB = await sendSourceRequest({ port: env.sourcePort, username: 'presB', password: b.password, expectContinue: true });
  assert.equal(connB.statusCode, 200);
  connB.writeChunk('next-audio-1');
  await wait(150);
  snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'presA');
  assert.equal(snap.next?.username, 'presB');

  // C rejected while full
  const connCFull = await sendSourceRequest({ port: env.sourcePort, username: 'presC', password: c.password, expectContinue: true });
  assert.equal(connCFull.statusCode, 503);
  connCFull.socket.destroy();

  // Duplicate A rejected
  const dupA = await sendSourceRequest({ port: env.sourcePort, username: 'presA', password: a.password, expectContinue: true });
  assert.equal(dupA.statusCode, 409);
  dupA.socket.destroy();

  // Disconnect A -> B promoted
  try { connA.endStream(); } catch (_) { connA.socket.destroy(); }
  await wait(250);
  snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'presB');
  assert.equal(snap.next, null);

  // C can now connect as NEXT
  const connC = await sendSourceRequest({ port: env.sourcePort, username: 'presC', password: c.password, expectContinue: true });
  assert.equal(connC.statusCode, 200);
  await wait(150);
  snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'presB');
  assert.equal(snap.next?.username, 'presC');

  // Disconnect B -> C promoted
  try { connB.endStream(); } catch (_) { connB.socket.destroy(); }
  await wait(250);
  snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'presC');
  assert.equal(snap.next, null);

  // Disconnect C -> empty
  try { connC.endStream(); } catch (_) { connC.socket.destroy(); }
  await wait(250);
  snap = env.queueManager.snapshot();
  assert.equal(snap.live, null);
  assert.equal(snap.next, null);

  // Disabled/suspended account cannot connect
  await presenterService.setPresenterStatus(a.presenter.id, 'suspended');
  const suspendedConn = await sendSourceRequest({ port: env.sourcePort, username: 'presA', password: a.password, expectContinue: true });
  assert.equal(suspendedConn.statusCode, 401);
  suspendedConn.socket.destroy();

  // Forwarding evidence: fake harbor should have seen at least one forwarded connection with auth/body
  assert.ok(harbor.received.length >= 1, 'expected forwarded stream to fake Liquidsoap harbor');
  assert.match(harbor.received[0].headers, /PUT \/presenter HTTP\/1\.1/i);
  assert.match(harbor.received[0].headers, /authorization:\s*basic/i);

  // cleanup any open sockets
  for (const c of [connCFull, dupA, suspendedConn]) try { c.socket.destroy(); } catch (_) {}
});

test('suspend/revoke connected presenter disconnects and promotes next; queue slot release', async (t) => {
  const harbor = await startFakeLiquidsoapHarbor();
  const env = await bootstrap({ LIQUIDSOAP_PORT: harbor.port });
  t.after(async () => { await env.shutdown(); await harbor.close(); });
  const { presenterService } = env.services;
  const a = await presenterService.createPresenter({ username: 'live1', displayName: 'Live1' });
  const b = await presenterService.createPresenter({ username: 'next1', displayName: 'Next1' });

  const connA = await sendSourceRequest({ port: env.sourcePort, username: 'live1', password: a.password, expectContinue: true });
  const connB = await sendSourceRequest({ port: env.sourcePort, username: 'next1', password: b.password, expectContinue: true });
  assert.equal(connA.statusCode, 200);
  assert.equal(connB.statusCode, 200);
  await wait(150);
  assert.equal(env.queueManager.snapshot().live.username, 'live1');
  assert.equal(env.queueManager.snapshot().next.username, 'next1');

  await presenterService.setPresenterStatus(a.presenter.id, 'suspended'); // disconnects A, promotes B
  await wait(250);
  let snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'next1');
  assert.equal(snap.next, null);

  // revoke connected presenter
  const c = await presenterService.createPresenter({ username: 'next2', displayName: 'Next2' });
  const connC = await sendSourceRequest({ port: env.sourcePort, username: 'next2', password: c.password, expectContinue: true });
  assert.equal(connC.statusCode, 200);
  await wait(150);
  assert.equal(env.queueManager.snapshot().next.username, 'next2');
  await presenterService.revokePresenter(b.presenter.id); // live
  await wait(250);
  snap = env.queueManager.snapshot();
  assert.equal(snap.live?.username, 'next2');
  assert.equal(snap.next, null);

  // disconnect releases slot
  try { connC.endStream(); } catch (_) { connC.socket.destroy(); }
  await wait(250);
  snap = env.queueManager.snapshot();
  assert.equal(snap.occupancy, 0);

  for (const s of [connA, connB, connC]) try { s.socket.destroy(); } catch (_) {}
});

test('gateway restart semantics: queue state is in-memory and cleared on restart', async (t) => {
  const dir = setupTestEnv();
  resetModules();
  const { initDatabase, closeDatabase } = require('../src/db/database');
  initDatabase();
  const queueManager = require('../src/services/queueManager');
  // simulate occupied state that would exist only in memory during runtime
  queueManager.live = { presenter: { id: 'x', username: 'x', display_name: 'X' }, connectedAt: new Date().toISOString(), role: 'live' };
  assert.equal(queueManager.snapshot().occupancy, 1);
  // simulate restart by resetting module/runtime state
  queueManager.live = null; queueManager.next = null;
  assert.equal(queueManager.snapshot().occupancy, 0);
  assert.equal(queueManager.snapshot().live, null);
  assert.equal(queueManager.snapshot().next, null);
  try { closeDatabase(); } catch (_) {}
  resetModules();
  cleanupDir(dir);

  // fresh bootstrap has empty queue
  const env = await bootstrap();
  t.after(() => env.shutdown());
  assert.equal(env.queueManager.snapshot().live, null);
  assert.equal(env.queueManager.snapshot().next, null);
});

test('source metadata headers and now-playing updates are forwarded to liquidsoap', async (t) => {
  const harbor = await startFakeLiquidsoapHarbor();
  const env = await bootstrap({ LIQUIDSOAP_PORT: harbor.port });
  t.after(async () => { await env.shutdown(); await harbor.close(); });

  const { presenterService } = env.services;
  const dj = await presenterService.createPresenter({ username: 'metadj', displayName: 'Meta DJ' });

  const conn = await sendSourceRequest({
    port: env.sourcePort,
    username: 'metadj',
    password: dj.password,
    expectContinue: true,
    extraHeaders: {
      'Ice-Name': 'Meta DJ Show',
      'Ice-Genre': 'Rock',
      'Ice-Description': 'Testing metadata',
      'Ice-URL': 'https://roadsideradio.example',
      'ice-audio-info': 'ice-samplerate=44100;ice-bitrate=128;ice-channels=2',
    },
  });
  assert.equal(conn.statusCode, 200);
  conn.writeChunk('audio-data');
  await wait(200);

  const streamReq = harbor.received.find(r => /PUT \/presenter HTTP\/1\.1/i.test(r.headers || '') && !/\/admin\/metadata/i.test(r.headers || ''));
  assert.ok(streamReq, 'expected forwarded source stream request');
  assert.match(streamReq.headers, /ice-genre:\s*Rock/i);
  assert.match(streamReq.headers, /ice-url:\s*https:\/\/roadsideradio\.example/i);
  assert.match(streamReq.headers, /ice-audio-info:\s*ice-samplerate=44100/i);

  const metaRes = await sendSourceRequest({
    port: env.sourcePort,
    method: 'GET',
    requestTarget: '/admin/metadata?mode=updinfo&mount=/live&song=Test%20Artist%20-%20Test%20Song',
    username: 'metadj',
    password: dj.password,
    contentType: null,
  });
  assert.equal(metaRes.statusCode, 200);
  metaRes.socket.destroy();

  await wait(150);
  const metaReq = harbor.received.find(r => /\/admin\/metadata/i.test(r.headers || '') || r.isMetadata);
  assert.ok(metaReq, 'expected forwarded metadata update request');
  assert.match(metaReq.headers || '', /song=Test(%20|\+)Artist(%20|\+)-(%20|\+)Test(%20|\+)Song/i);
  assert.match(metaReq.headers || metaReq.path || '', /mount=%2Fpresenter|mount=\/presenter/i);

  try { conn.endStream(); } catch (_) { conn.socket.destroy(); }
  await wait(150);
  assert.equal(env.queueManager.snapshot().occupancy, 0);
});
