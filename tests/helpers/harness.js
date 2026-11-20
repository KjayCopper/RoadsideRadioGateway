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
    let meta = { headers: '', bodyChunks: [] };
    connections.push(socket);
    socket.on('data', (chunk) => {
      if (!headersDone) {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          headersDone = true;
          const head = buf.slice(0, idx).toString('utf8');
          meta.headers = head;
          const rest = buf.slice(idx + 4);
          if (rest.length) meta.bodyChunks.push(Buffer.from(rest));
          // respond like harbor: 100 continue not strictly required here, but accept
          if (/Expect:\s*100-continue/i.test(head)) {
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          }
          // some clients okay with 200 early; keep open to receive stream
          // socket.write('HTTP/1.0 200 OK\r\n\r\n');
        }
      } else {
        meta.bodyChunks.push(Buffer.from(chunk));
      }
    });
    const done = new Promise((resolve) => {
      socket.on('close', () => {
        meta.body = Buffer.concat(meta.bodyChunks);
        received.push(meta);
        resolve(meta);
      });
      socket.on('end', () => {
        // keep until close
      });
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

function sendSourceRequest({ port, method = 'PUT', mount = '/live', username = 'user', password = 'pass', contentType = 'audio/mpeg', bodyChunks = [], expectContinue = true, keepOpen = false, extraHeaders = {} }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      let headers = `${method} ${mount} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n` +
        `Content-Type: ${contentType}\r\n` +
        `User-Agent: TestEncoder/1.0\r\n` +
        `Ice-Name: Test Stream\r\n` +
        `Transfer-Encoding: chunked\r\n`;
      if (expectContinue) headers += 'Expect: 100-continue\r\n';
      for (const [k, v] of Object.entries(extraHeaders)) headers += `${k}: ${v}\r\n`;
      headers += '\r\n';
      socket.write(headers);
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
