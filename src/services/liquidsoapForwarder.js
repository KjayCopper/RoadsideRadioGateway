const http = require('http');
const config = require('../config');
const logger = require('../logging/logger');
const { emit } = require('./eventService');

function sanitizeHeaderValue(value) {
  if (value === undefined || value === null) return undefined;
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function pickSourceMetadataHeaders(sourceHeaders = {}) {
  const h = {};
  const allow = new Set([
    'ice-name',
    'ice-description',
    'ice-genre',
    'ice-url',
    'ice-public',
    'ice-audio-info',
    'ice-bitrate',
    'icy-name',
    'icy-genre',
    'icy-url',
    'icy-br',
    'icy-description',
    'icy-pub',
  ]);
  for (const [key, value] of Object.entries(sourceHeaders)) {
    if (!key) continue;
    const lower = key.toLowerCase();
    if (!allow.has(lower)) continue;
    const clean = sanitizeHeaderValue(value);
    if (clean !== undefined && clean !== '') h[lower] = clean;
  }
  return h;
}

function buildForwardHeaders({ presenter, contentType, userAgent, sourceHeaders = {}, includeExpect = true }) {
  const ls = config.liquidsoap;
  const srcMeta = pickSourceMetadataHeaders(sourceHeaders);
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${ls.user}:${ls.password}`).toString('base64'),
    'Content-Type': sanitizeHeaderValue(contentType) || 'audio/mpeg',
    'User-Agent': sanitizeHeaderValue(userAgent) || 'RoadsideRadioGateway/1.0',
    'Ice-Public': srcMeta['ice-public'] || srcMeta['icy-pub'] || '0',
    'Ice-Name': srcMeta['ice-name'] || srcMeta['icy-name'] || sanitizeHeaderValue(presenter.display_name || presenter.username) || 'Roadside Radio',
    'Ice-Description': srcMeta['ice-description'] || srcMeta['icy-description'] || `Roadside Radio presenter ${sanitizeHeaderValue(presenter.username) || 'presenter'}`,
    'Transfer-Encoding': 'chunked',
    'Connection': 'close',
  };
  if (includeExpect) headers['Expect'] = '100-continue';

  const genre = srcMeta['ice-genre'] || srcMeta['icy-genre'];
  const url = srcMeta['ice-url'] || srcMeta['icy-url'];
  const audioInfo = srcMeta['ice-audio-info'];
  const bitrate = srcMeta['ice-bitrate'] || srcMeta['icy-br'];
  if (genre) headers['Ice-Genre'] = genre;
  if (url) headers['Ice-URL'] = url;
  if (audioInfo) headers['ice-audio-info'] = audioInfo;
  if (bitrate) headers['Ice-Bitrate'] = bitrate;

  return headers;
}

function startForwarding({ presenter, contentType, userAgent, sourceHeaders, sourceStream, onClose }) {
  const ls = config.liquidsoap;
  const targetPath = ls.mount && ls.mount.startsWith('/') ? ls.mount : `/${ls.mount || 'presenter'}`;
  const headers = buildForwardHeaders({ presenter, contentType, userAgent, sourceHeaders: sourceHeaders || {}, includeExpect: true });

  let started = false;
  let ended = false;
  let req;
  let fallbackTimer;

  const doPipe = () => {
    if (started || ended) return;
    started = true;
    try { sourceStream.pipe(req, { end: true }); }
    catch (err) { cleanup(err, 'pipe_error'); }
  };

  const cleanup = (err, reason) => {
    if (ended) return;
    ended = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
    try { sourceStream.unpipe(req); } catch (_) {}
    try { if (req && !req.destroyed) req.destroy(err || undefined); } catch (_) {}
    if (err) {
      emit('gateway_error', { level: 'error', message: 'Liquidsoap forwarding failed', presenterId: presenter.id, username: presenter.username, details: { reason: reason || err.message } });
    }
    if (typeof onClose === 'function') onClose(err || null, reason || null);
  };

  req = http.request({
    host: ls.host,
    port: ls.port,
    method: 'PUT',
    path: targetPath,
    headers,
  });

  req.setTimeout(ls.connectTimeoutMs, () => cleanup(new Error('Liquidsoap connect timeout'), 'connect_timeout'));
  req.on('error', (err) => cleanup(err, 'request_error'));
  req.on('continue', () => {
    logger.info({ presenterId: presenter.id, username: presenter.username, target: `${ls.host}:${ls.port}${targetPath}` }, 'liquidsoap_forwarding_started');
    doPipe();
  });
  req.on('response', (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (!started) {
        logger.info({ presenterId: presenter.id, username: presenter.username, statusCode: res.statusCode }, 'liquidsoap_forwarding_started_response');
        doPipe();
      }
      res.resume();
      res.on('end', () => cleanup(null, 'liquidsoap_closed'));
    } else {
      res.resume();
      cleanup(new Error(`Liquidsoap responded ${res.statusCode}`), 'bad_status');
    }
  });
  req.on('close', () => { if (!ended) cleanup(null, 'request_closed'); });

  sourceStream.on('error', (err) => cleanup(err, 'source_error'));

  fallbackTimer = setTimeout(() => {
    if (!started && !ended) {
      logger.warn({ presenterId: presenter.id, username: presenter.username }, 'liquidsoap_no_continue_fallback_start');
      doPipe();
    }
  }, 500);

  try { req.flushHeaders?.(); } catch (_) { try { req.end(); } catch (_) {} }

  return {
    stop(reason = 'stopped') { cleanup(null, reason); },
  };
}

function forwardMetadataUpdate({ requestMethod = 'GET', requestTarget = '/admin/metadata', sourceHeaders = {}, body = null, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const ls = config.liquidsoap;
    const targetMount = ls.mount && ls.mount.startsWith('/') ? ls.mount : `/${ls.mount || 'presenter'}`;
    let parsed;
    try {
      parsed = new URL(requestTarget || '/admin/metadata', 'http://localhost');
    } catch {
      parsed = new URL('/admin/metadata', 'http://localhost');
    }

    const params = parsed.searchParams;
    const hadMount = params.has('mount');
    params.set('mount', targetMount);
    // Some clients may use different path/mode conventions; keep as provided.
    const query = params.toString();
    const path = `${parsed.pathname || '/admin/metadata'}${query ? `?${query}` : ''}`;

    let outBody = body;
    if (body && body.length && /application\/x-www-form-urlencoded/i.test(sourceHeaders['content-type'] || '')) {
      try {
        const form = new URLSearchParams(body.toString('utf8'));
        if (form.has('mount') || hadMount) form.set('mount', targetMount);
        outBody = Buffer.from(form.toString(), 'utf8');
      } catch (_) {
        outBody = body;
      }
    }

    const headers = {
      'Authorization': 'Basic ' + Buffer.from(`${ls.user}:${ls.password}`).toString('base64'),
      'User-Agent': 'RoadsideRadioGateway/1.0',
      'Connection': 'close',
      'Host': `${ls.host}:${ls.port}`,
    };
    if (outBody && outBody.length) {
      headers['Content-Type'] = sanitizeHeaderValue(sourceHeaders['content-type']) || 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(outBody);
    }

    const req = http.request({
      host: ls.host,
      port: ls.port,
      method: requestMethod === 'POST' ? 'POST' : 'GET',
      path,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode || 502,
          headers: res.headers || {},
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      resolve({ ok: false, statusCode: 504, headers: {}, body: Buffer.from('Metadata update timed out') });
    });
    req.on('error', (err) => {
      logger.warn({ err: err.message }, 'liquidsoap_metadata_update_error');
      resolve({ ok: false, statusCode: 502, headers: {}, body: Buffer.from('Metadata update failed') });
    });

    if (outBody && outBody.length && requestMethod === 'POST') req.write(outBody);
    req.end();
  });
}

module.exports = { startForwarding, forwardMetadataUpdate, buildForwardHeaders, pickSourceMetadataHeaders };
