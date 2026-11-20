const http = require('http');
const { URL } = require('url');
const config = require('../config');
const logger = require('../logging/logger');
const { emit } = require('./eventService');

function startForwarding({ presenter, contentType, userAgent, sourceStream, onClose }) {
  const ls = config.liquidsoap;
  const targetPath = ls.mount && ls.mount.startsWith('/') ? ls.mount : `/${ls.mount || 'presenter'}`;
  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${ls.user}:${ls.password}`).toString('base64'),
    'Content-Type': contentType || 'audio/mpeg',
    'User-Agent': userAgent || 'RoadsideRadioGateway/1.0',
    'Ice-Public': '0',
    'Ice-Name': presenter.display_name || presenter.username,
    'Ice-Description': `Roadside Radio presenter ${presenter.username}`,
    'Transfer-Encoding': 'chunked',
    'Expect': '100-continue',
    'Connection': 'close',
  };

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

module.exports = { startForwarding };
