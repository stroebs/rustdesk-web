import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers.js';

/** A stand-in for hbbs/hbbr: completes the WebSocket handshake, then echoes raw bytes. */
async function fakeUpstream() {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((_, res) => res.writeHead(400).end());
  server.on('upgrade', (req, socket) => {
    // Upgraded sockets are no longer tracked by the HTTP server, so close() would wait forever.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    seen.push({ url: req.url, headers: req.headers });
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    server.close(r);
  }) };
}

/** Open a WebSocket upgrade with full control over headers; resolves with status (+ socket on 101). */
function upgrade(base, path, headers) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers },
    });
    req.on('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }));
    req.on('response', (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('WebSocket gateway', () => {
  let t;
  let hbbs;
  let hbbr;
  let cookie;
  let origin;

  before(async () => {
    hbbs = await fakeUpstream();
    hbbr = await fakeUpstream();
    t = await startApp({ hbbsWsUrl: hbbs.url, hbbrWsUrl: hbbr.url });
    cookie = (await t.adminSession()).cookie;
    origin = t.base;
  });
  after(async () => {
    await t.stop();
    await hbbs.close();
    await hbbr.close();
  });

  it('pipes /ws/id and /ws/relay to hbbs and hbbr byte for byte', async () => {
    for (const [path, upstream] of [['/ws/id', hbbs], ['/ws/relay', hbbr]]) {
      const { status, socket } = await upgrade(t.base, path, { Cookie: cookie, Origin: origin });
      assert.equal(status, 101, path);
      const payload = crypto.randomBytes(4096);
      const echoed = new Promise((resolve) => {
        const chunks = [];
        socket.on('data', (d) => {
          chunks.push(d);
          if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks));
        });
      });
      socket.write(payload);
      assert.deepEqual(await echoed, payload);
      socket.destroy();
      const last = upstream.seen.at(-1);
      assert.equal(last.headers.cookie, undefined, 'session cookie must not be forwarded');
      assert.equal(last.headers.origin, undefined);
    }
  });

  it('requires an admin session', async () => {
    assert.equal((await upgrade(t.base, '/ws/id', { Origin: origin })).status, 401);
    assert.equal((await upgrade(t.base, '/ws/id', { Origin: origin, Cookie: 'rdw_session=bogus' })).status, 401);
  });

  it('refuses cross-site and Origin-less handshakes', async () => {
    assert.equal((await upgrade(t.base, '/ws/id', { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await upgrade(t.base, '/ws/id', { Cookie: cookie })).status, 403);
  });

  it('rejects unknown paths', async () => {
    assert.equal((await upgrade(t.base, '/ws/other', { Cookie: cookie, Origin: origin })).status, 404);
  });

  it('reports a bad gateway when hbbs is unreachable', async () => {
    const saved = t.app.config.hbbsWsUrl;
    t.app.config.hbbsWsUrl = 'ws://127.0.0.1:1';
    try {
      assert.equal((await upgrade(t.base, '/ws/id', { Cookie: cookie, Origin: origin })).status, 502);
    } finally {
      t.app.config.hbbsWsUrl = saved;
    }
  });

  it('exposes the remote-session config to admins', async () => {
    const admin = await t.adminSession();
    await admin.put('/api/admin/settings', { key: 'PUBKEY=' });
    const { data } = await admin.get('/api/admin/remote/config');
    assert.equal(data.key, 'PUBKEY=');
    assert.equal(data.ready, true);
    assert.equal((await admin.post('/api/admin/remote/sessions', { peer_id: '123456789' })).status, 200);
    const log = (await admin.get('/api/admin/activity?q=web_session')).data;
    assert.equal(log.items[0].target, '123456789');
  });
});
