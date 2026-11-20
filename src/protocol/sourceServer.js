const net = require('net');
const { PassThrough, Writable } = require('stream');
const config = require('../config');
const logger = require('../logging/logger');
const { emit } = require('../services/eventService');
const queueManager = require('../services/queueManager');
const { authenticatePresenter, recordConnection } = require('../services/presenterService');
const { startForwarding } = require('../services/liquidsoapForwarder');

function parseHeaders(raw) {
  const lines = raw.split('\r\n');
  const [method, requestTarget, version] = (lines.shift() || '').split(' ');
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }
  return { method, requestTarget, version, headers };
}

function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.toLowerCase().startsWith('basic ')) return null;
  const b64 = authHeader.slice(6).trim();
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function writeStatus(socket, statusCode, statusText, headers = {}, body = '') {
  if (socket.destroyed || socket.writableEnded) return;
  const lines = [`HTTP/1.1 ${statusCode} ${statusText}`];
  const allHeaders = { 'Cache-Control': 'no-cache', ...headers };
  if (body && !allHeaders['Content-Length']) allHeaders['Content-Length'] = Buffer.byteLength(body);
  if (!allHeaders['Connection']) allHeaders['Connection'] = 'close';
  for (const [k, v] of Object.entries(allHeaders)) lines.push(`${k}: ${v}`);
  lines.push('', body);
  try { socket.write(lines.join('\r\n')); } catch (_) {}
}

function writeContinue(socket) {
  if (socket.destroyed || socket.writableEnded) return;
  try { socket.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch (_) {}
}

function createBlackhole() {
  return new Writable({
    write(_chunk, _enc, cb) { cb(); },
  });
}

function createSourceServer() {
  return net.createServer((socket) => {
    handleConnection(socket).catch((err) => {
      logger.error({ err }, 'unhandled_source_connection_error');
      try { socket.destroy(); } catch (_) {}
    });
  });
}

async function handleConnection(socket) {
  const remote = `${socket.remoteAddress || ''}:${socket.remotePort || ''}`;
  let buffer = Buffer.alloc(0);
  let headerParsed = false;
  let request;
  let audioStream = null;
  let blackhole = null;
  let slot = null;
  let released = false;
  let forwardingRef = null;
  let finalResponseSent = false;
  let accepted = false;

  const sendFinal = (code, text, headers = {}, body = '') => {
    if (finalResponseSent || socket.destroyed) return;
    finalResponseSent = true;
    writeStatus(socket, code, text, headers, body);
  };

  const releaseOnce = (reason) => {
    if (released) return;
    released = true;
    try { if (forwardingRef && forwardingRef.current) forwardingRef.current.stop(reason); } catch (_) {}
    try { if (audioStream) audioStream.unpipe(); } catch (_) {}
    try { if (blackhole && !blackhole.destroyed) blackhole.destroy(); } catch (_) {}
    if (slot) queueManager.release(slot, reason);
  };

  const cleanup = (reason, { code, text, headers, body } = {}) => {
    if (code && !finalResponseSent) sendFinal(code, text || '', headers || {}, body || '');
    releaseOnce(reason);
    if (!socket.destroyed) {
      try { socket.end(); } catch (_) { try { socket.destroy(); } catch (_) {} }
    }
  };

  socket.on('error', (err) => {
    logger.debug({ err: err.message, remote }, 'source_socket_error');
    releaseOnce('socket_error');
  });

  socket.on('close', () => {
    if (accepted && !finalResponseSent) {
      // For PUT+Expect flows we may defer final 200 until end; best effort.
      finalResponseSent = true;
    }
    releaseOnce('disconnected');
  });

  socket.on('timeout', () => {
    if (!accepted) cleanup('timeout', { code: 408, text: 'Request Timeout' });
  });
  socket.setTimeout(config.gateway.sourceReadTimeoutMs);

  socket.on('data', async (chunk) => {
    if (!headerParsed) {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buffer.length > 64 * 1024) cleanup('headers_too_large', { code: 431, text: 'Request Header Fields Too Large' });
        return;
      }
      headerParsed = true;
      const headerPart = buffer.slice(0, idx).toString('utf8');
      const rest = buffer.slice(idx + 4);
      buffer = Buffer.alloc(0);
      request = parseHeaders(headerPart);

      const outcome = await processRequest({ socket, request, rest, remote, sendFinal });
      if (!outcome || !outcome.accepted) {
        // processRequest handles response/cleanup for rejection paths
        if (outcome && outcome.cleanupReason && !socket.destroyed) cleanup(outcome.cleanupReason);
        return;
      }
      accepted = true;
      slot = outcome.slot;
      audioStream = outcome.audioStream;
      blackhole = outcome.blackhole;
      forwardingRef = outcome.forwardingRef || null;
      socket.setTimeout(0); // streaming can be long-lived
      return;
    }

    if (audioStream) {
      if (!audioStream.write(chunk)) {
        socket.pause();
        audioStream.once('drain', () => { try { socket.resume(); } catch (_) {} });
      }
    }
  });

  socket.on('end', () => {
    try { if (audioStream) audioStream.end(); } catch (_) {}
    releaseOnce('client_end');
  });
}

async function processRequest({ socket, request, rest, remote, sendFinal }) {
  const method = (request.method || '').toUpperCase();
  const target = request.requestTarget || '/';
  const headers = request.headers || {};
  const mountpoint = target.split('?')[0] || '/';
  const expectContinue = (headers['expect'] || '').toLowerCase().includes('100-continue');

  emit('incoming_connection', { message: 'Incoming presenter connection', details: { remote, method, mountpoint, userAgent: headers['user-agent'] || null, contentType: headers['content-type'] || null } });

  if (method !== 'PUT' && method !== 'SOURCE') {
    sendFinal(405, 'Method Not Allowed', { Allow: 'PUT, SOURCE' });
    return { accepted: false, cleanupReason: 'method_not_allowed' };
  }

  const creds = parseBasicAuth(headers['authorization']);
  if (!creds) {
    if (expectContinue) writeContinue(socket);
    sendFinal(401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="RoadsideRadioGateway"', Connection: 'close' });
    emit('authentication_failed', { level: 'warn', message: 'Presenter authentication failed (missing credentials)', details: { remote, mountpoint } });
    return { accepted: false, cleanupReason: 'missing_credentials' };
  }

  const auth = await authenticatePresenter(creds.username, creds.password);
  if (!auth.ok) {
    if (expectContinue) writeContinue(socket);
    sendFinal(401, 'Unauthorized', { 'WWW-Authenticate': 'Basic realm="RoadsideRadioGateway"', Connection: 'close' });
    return { accepted: false, cleanupReason: 'invalid_credentials' };
  }

  const presenter = auth.presenter;
  recordConnection(presenter.id);

  const audioStream = new PassThrough({ highWaterMark: 64 * 1024 });
  const blackhole = createBlackhole();
  const forwardingRef = { current: null };
  let slotRef = null;

  const closeFn = (reason) => {
    logger.info({ presenterId: presenter.id, username: presenter.username, reason }, 'closing_presenter_connection');
    try { audioStream.end(); } catch (_) {}
    if (!socket.destroyed) try { socket.destroy(); } catch (_) {}
  };

  const startForwardingNow = () => {
    try { audioStream.unpipe(blackhole); } catch (_) {}
    forwardingRef.current = startForwarding({
      presenter,
      contentType: headers['content-type'] || 'audio/mpeg',
      mountpoint,
      userAgent: headers['user-agent'] || null,
      sourceStream: audioStream,
      onClose: (err, reason) => {
        if (err) logger.error({ err: err.message, reason, presenterId: presenter.id }, 'forwarding_closed_with_error');
        else logger.info({ reason, presenterId: presenter.id }, 'forwarding_closed');
        if (!socket.destroyed) try { socket.destroy(); } catch (_) {}
      },
    });
    emit('audio_forwarding_started', { message: 'Live presenter audio forwarding started', presenterId: presenter.id, username: presenter.username, details: { mountpoint } });
    if (slotRef) queueManager.markForwardingStarted(slotRef);
  };

  const reservation = queueManager.reserve(presenter, {
    mountpoint,
    contentType: headers['content-type'] || null,
    userAgent: headers['user-agent'] || null,
    close: closeFn,
    startForwarding: startForwardingNow,
  });

  if (!reservation.accepted) {
    if (reservation.reason === 'queue_full') {
      sendFinal(503, 'Service Unavailable', { 'Retry-After': '30', Connection: 'close' }, 'Queue full: live and next slots are occupied');
    } else if (reservation.reason === 'duplicate_connection') {
      sendFinal(409, 'Conflict', { Connection: 'close' }, 'Presenter is already connected');
    } else {
      sendFinal(503, 'Service Unavailable', { Connection: 'close' });
    }
    return { accepted: false, cleanupReason: reservation.reason || 'rejected' };
  }

  slotRef = reservation.slot;

  // Initial body bytes after headers
  if (rest && rest.length) audioStream.write(rest);

  // Acknowledge accepted stream so encoders can proceed to send audio.
  if (expectContinue) {
    // Some clients expect 100 then proceed; others accept 200 directly. Send 200 as clear acceptance.
    // (We avoided sending 100 earlier for the accepted path to keep response simple.)
  }
  sendFinal(200, 'OK', { Server: 'RoadsideRadioGateway', Connection: 'close' });

  if (reservation.role === 'live') {
    // Forward immediately
    audioStream.resume();
    startForwardingNow();
  } else {
    // NEXT: keep connection alive and discard audio without accumulating delay
    audioStream.pipe(blackhole);
    audioStream.resume();
    logger.info({ presenterId: presenter.id, username: presenter.username }, 'presenter_connected_as_next_draining');
  }

  return { accepted: true, slot: slotRef, audioStream, blackhole, forwardingRef };
}

function startSourceServer({ port = config.gateway.port, host = config.gateway.host } = {}) {
  return new Promise((resolve, reject) => {
    const server = createSourceServer();
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      logger.info({ host, port: addr && addr.port ? addr.port : port }, 'source_server_listening');
      resolve(server);
    });
  });
}

module.exports = { startSourceServer, createSourceServer };
