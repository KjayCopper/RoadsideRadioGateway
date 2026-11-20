const http = require('http');
const net = require('net');
const { once } = require('events');

async function startApi(app) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}` };
}

async function startFakeLiquidsoapHarbor() {
  const connections = [];
  const received = [];
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let headersDone = false;
    let meta = { headers: '', bodyChunks: [], body: Buffer.alloc(0), isMetadata: false };
    let requestLine = '';
    let requestHeaders = {};
    let contentLength = 0;
    let responded = false;
    let recorded = false;
    connections.push(socket);

    const record = () => {
      if (recorded) return;
      recorded = true;
      received.push(meta);
    };

    const maybeHandleShortRequest = () => {
      if (!headersDone || responded) return false;
      const path = (requestLine.split(' ')[1] || '');
      const isMetadata = path.startsWith('/admin/metadata');
      const method = (requestLine.split(' ')[0] || '').toUpperCase();
      if (!isMetadata) return false;
      const bodyBuf = Buffer.concat(meta.bodyChunks);
      if (method === 'POST' && bodyBuf.length < contentLength) return false;
      responded = true;
      meta.body = bodyBuf.slice(0, contentLength || bodyBuf.length);
      meta.isMetadata = true;
      meta.method = method;
      meta.path = path;
      record();
      const respBody = '<?xml version="1.0"?><icestats><message>Metadata update successful</message><return>1</return></icestats>';
      try {
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: ' + Buffer.byteLength(respBody) + '\r\nConnection: close\r\n\r\n' + respBody);
      } catch (_) {}
      try { socket.end(); } catch (_) {}
      return true;
    };

    socket.on('data', (chunk) => {
      if (!headersDone) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          headersDone = true;
          const head = buf.slice(0, idx).toString('utf8');
          meta.headers = head;
          const lines = head.split('\r\n');
          requestLine = lines[0] || '';
          for (const line of lines.slice(1)) {
            const i = line.indexOf(':');
            if (i !== -1) requestHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
          }
          contentLength = parseInt(requestHeaders['content-length'] || '0', 10) || 0;
          meta.method = (requestLine.split(' ')[0] || '').toUpperCase();
          meta.path = (requestLine.split(' ')[1] || '');
          const rest = buf.slice(idx + 4);
          if (rest.length) meta.bodyChunks.push(Buffer.from(rest));

          if (/Expect:\s*100-continue/i.test(head)) {
            try { socket.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch (_) {}
          }

          // Record stream requests immediately so tests can inspect headers while open
          if (!String(meta.path).startsWith('/admin/metadata')) {
            meta.isMetadata = false;
            record();
          }

          if (maybeHandleShortRequest()) return;
        }
      } else {
        meta.bodyChunks.push(Buffer.from(chunk));
        if (maybeHandleShortRequest()) return;
      }
    });

    const done = new Promise((resolve) => {
      socket.on('close', () => {
        if (!responded) {
          meta.body = Buffer.concat(meta.bodyChunks);
          record();
        }
        resolve(meta);
      });
      socket.on('end', () => {});
    });
    socket._done = done;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    port,
    connections,
    received,
    async close() {
      for (const s of connections) try { s.destroy(); } catch (_) {}
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sendSourceRequest({ port, method = 'PUT', mount = '/live', username = 'user', password = 'pass', contentType = 'audio/mpeg', bodyChunks = [], expectContinue = true, keepOpen = false, extraHeaders = {}, rawBody = null, includeAuth = true, requestTarget = null }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const target = requestTarget || mount;
      const methodUpper = (method || 'PUT').toUpperCase();
      let headers = `${methodUpper} ${target} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n`;
      if (includeAuth) headers += `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`;
      if (contentType) headers += `Content-Type: ${contentType}\r\n`;
      headers += `User-Agent: TestEncoder/1.0\r\n`;
      if (methodUpper === 'PUT' || methodUpper === 'SOURCE') {
        headers += `Ice-Name: Test Stream\r\n`;
        headers += `Transfer-Encoding: chunked\r\n`;
        if (expectContinue) headers += 'Expect: 100-continue\r\n';
      }
      for (const [k, v] of Object.entries(extraHeaders)) headers += `${k}: ${v}\r\n`;
      if (rawBody != null) {
        const rb = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
        headers += `Content-Length: ${rb.length}\r\n`;
      }
      headers += '\r\n';
      socket.write(headers);
      if (rawBody != null) {
        const rb = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
        if (rb.length) socket.write(rb);
      }
    });

    let responseBuf = Buffer.alloc(0);
    let headersParsed = false;
    let statusCode = null;
    let responseHeaders = {};
    let bodyBuf = Buffer.alloc(0);

    const tryParse = () => {
      if (headersParsed) return;
      const idx = responseBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      headersParsed = true;
      const head = responseBuf.slice(0, idx).toString('utf8');
      bodyBuf = Buffer.concat([bodyBuf, responseBuf.slice(idx + 4)]);
      const lines = head.split('\r\n');
      const m = lines[0].match(/^HTTP\/1\.[01] (\d+)/);
      statusCode = m ? parseInt(m[1], 10) : null;
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i !== -1) responseHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      if (statusCode === 100) {
        // continue; wait for final
        headersParsed = false;
        responseBuf = bodyBuf;
        bodyBuf = Buffer.alloc(0);
        statusCode = null;
        responseHeaders = {};
        tryParse();
        return;
      }
      resolveResult();
    };

    let resolved = false;
    const resolveResult = () => {
      if (resolved) return;
      resolved = true;
      const writeChunk = (data) => {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
        socket.write(`${b.length.toString(16)}\r\n`);
        socket.write(b);
        socket.write('\r\n');
      };
      const endStream = () => { try { socket.write('0\r\n\r\n'); socket.end(); } catch (_) {} };
      resolve({ socket, statusCode, headers: responseHeaders, body: bodyBuf, writeChunk, endStream });
    };

    socket.on('data', (chunk) => {
      responseBuf = Buffer.concat([responseBuf, chunk]);
      tryParse();
    });
    socket.on('error', (err) => { if (!resolved) reject(err); });
    socket.on('end', () => { if (!resolved) { tryParse(); if (!resolved) reject(new Error('socket ended before response')); } });
    socket.setTimeout(5000, () => { if (!resolved) reject(new Error('timeout waiting response')); });
  });
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startApi, startFakeLiquidsoapHarbor, sendSourceRequest, wait };
