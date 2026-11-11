// WebSocket gateway for the browser client.
//
//   /ws/id     -> hbbs WebSocket port (21118)   rendezvous: find the peer, request a relay
//   /ws/relay  -> hbbr WebSocket port (21119)   the relayed, end-to-end encrypted session
//
// hbbs and hbbr speak WebSocket themselves, so after checking the admin session
// the gateway replays the browser's upgrade request to the target and pipes raw
// bytes both ways; it never parses frames. The payload is end-to-end encrypted
// between the browser and the remote device, so the gateway cannot read it.
//
// Path names follow RustDesk's own reverse-proxy convention (/ws/id, /ws/relay).

import net from 'node:net';
import tls from 'node:tls';
import { clientIp } from './http.js';
import { SESSION_COOKIE } from './routes/admin.js';
import { effectiveServerConfig } from './serverconfig.js';

const CONNECT_TIMEOUT_MS = 10_000;
// Forwarded from the browser's handshake. Cookies and everything else stay here.
const FORWARD_HEADERS = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'];

function hostOf(server) {
  // "host", "host:port", "[v6]:port" -> host
  const s = String(server).trim();
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  const i = s.lastIndexOf(':');
  return i > 0 && s.indexOf(':') === i ? s.slice(0, i) : s;
}

/**
 * Where to forward. Explicit HBBS_WS_URL / HBBR_WS_URL win; otherwise use the
 * client-facing ID/relay servers from Settings with the standard WebSocket ports.
 */
export function gatewayTargets(app) {
  const cfg = effectiveServerConfig(app);
  const idHost = cfg.id_server ? hostOf(cfg.id_server) : '';
  const relayHost = cfg.relay_server ? hostOf(cfg.relay_server) : idHost;
  return {
    id: app.config.hbbsWsUrl || (idHost ? `ws://${idHost}:21118` : ''),
    relay: app.config.hbbrWsUrl || (relayHost ? `ws://${relayHost}:21119` : ''),
  };
}

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachWsGateway(server, app) {
  const { logger } = app;
  const active = new Set();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    upgrade(req, socket, head).catch((err) => {
      logger.error(`ws gateway: ${err.message}`);
      reject(socket, 500, 'Internal Server Error');
    });
  });

  async function upgrade(req, socket, head) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const kind = path === '/ws/id' ? 'id' : path === '/ws/relay' ? 'relay' : null;
    if (!kind) return reject(socket, 404, 'Not Found');
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket') return reject(socket, 400, 'Bad Request');

    // Browsers always send Origin on WebSocket handshakes; refuse cross-site ones.
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    const cookie = String(req.headers.cookie ?? '')
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${SESSION_COOKIE}=`));
    let token = '';
    try {
      token = cookie ? decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)) : '';
    } catch {
      /* malformed cookie */
    }
    const user = token ? await app.webUser(token, req.headers) : null;
    if (!user?.is_admin) return reject(socket, 401, 'Unauthorized');

    const ip = clientIp(req, app.config.trustProxy, app.cloudflare.connectingIp(req));
    const target = gatewayTargets(app)[kind];
    if (!target) return reject(socket, 503, 'Service Unavailable');
    let url;
    try {
      url = new URL(target);
    } catch {
      return reject(socket, 503, 'Service Unavailable');
    }
    const secure = url.protocol === 'wss:';
    const port = Number(url.port) || (secure ? 443 : 80);
    const upstream = secure
      ? tls.connect({ host: url.hostname, port, servername: url.hostname })
      : net.connect({ host: url.hostname, port });

    const timer = setTimeout(() => upstream.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    let piped = false;

    upstream.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      const lines = [`GET ${url.pathname || '/'}${url.search} HTTP/1.1`, `Host: ${url.host}`, 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const name of FORWARD_HEADERS) {
        if (req.headers[name]) lines.push(`${name}: ${req.headers[name]}`);
      }
      // hbbs/hbbr take the peer address from X-Real-IP (as behind any WebSocket proxy);
      // otherwise the device would log this container's address for the session.
      if (net.isIP(ip)) lines.push(`X-Real-IP: ${ip}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.setNoDelay(true);
      upstream.setNoDelay?.(true);
      upstream.pipe(socket);
      socket.pipe(upstream);
      piped = true;
      const entry = { socket, upstream };
      active.add(entry);
      const done = () => active.delete(entry);
      socket.once('close', () => { done(); upstream.destroy(); });
      upstream.once('close', () => { done(); socket.destroy(); });
    });

    upstream.on('error', (err) => {
      clearTimeout(timer);
      logger.error(`ws gateway: ${kind} -> ${url.host} failed: ${err.message}`);
      if (piped) socket.destroy();
      else reject(socket, 502, 'Bad Gateway');
    });
  }

  return {
    get size() {
      return active.size;
    },
    closeAll() {
      for (const { socket, upstream } of active) {
        socket.destroy();
        upstream.destroy();
      }
      active.clear();
    },
  };
}
