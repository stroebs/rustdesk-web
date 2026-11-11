import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Auth, hashPassword, randomPassword } from './auth.js';
import { Hbbs } from './hbbs.js';
import { Context, Router, SECURITY_HEADERS, serveStatic } from './http.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerClientRoutes } from './routes/client.js';
import { attachWsGateway } from './wsgateway.js';
import { Store } from './store.js';
import { HttpError } from './util.js';

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
const HOUR = 3600 * 1000;

/**
 * Identifies the UI build: changes whenever any file under public/ changes. Assets
 * are served under /v/<buildId>/, so a new release gets new URLs that no browser
 * or CDN cache (e.g. a Cloudflare Browser Cache TTL) can serve stale.
 */
function computeBuildId(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else hash.update(path.relative(dir, p)).update('\0').update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

export function createApp(config, { logger = console } = {}) {
  const store = new Store(config.dbPath);
  const app = {
    config,
    store,
    logger,
    version: pkg.version,
    buildId: null,
    auth: new Auth(store, config),
    hbbs: new Hbbs(store, config),
    log(ctx, action, target = '', detail = '') {
      store.run(
        'INSERT INTO activity (created_at, user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        Date.now(), ctx.user?.id ?? null, ctx.user?.username ?? '', action, String(target), String(detail), ctx.ip ?? '',
      );
    },
  };

  const buildId = computeBuildId(config.publicDir);
  app.buildId = buildId;
  const indexHtml = fs.readFileSync(path.join(config.publicDir, 'index.html'), 'utf8')
    .replace(/(href|src)="\/assets\//g, `$1="/v/${buildId}/assets/`);
  const VERSIONED = /^\/v\/([0-9a-f]+)(\/.*)$/;

  const router = new Router();
  router.get('/api/health', () => ({ ok: true, version: app.version }));
  registerClientRoutes(router, app);
  registerAdminRoutes(router, app);

  async function handle(req, res) {
    const ctx = new Context(req, res, config);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      if (ctx.path === '/api' || ctx.path.startsWith('/api/')) {
        const match = router.match(ctx.method, ctx.path);
        if (!match) throw new HttpError(404, 'Not found');
        if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
        ctx.params = match.params;
        const result = await match.handler(ctx);
        if (!res.headersSent) {
          if (result === undefined || result === null) ctx.empty();
          else ctx.json(result);
        }
      } else if (ctx.path === '/' || ctx.path === '/index.html') {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(indexHtml) });
        res.end(ctx.method === 'HEAD' ? undefined : indexHtml);
      } else {
        const m = VERSIONED.exec(ctx.path);
        if (m) {
          ctx.path = m[2];
          // Current build: never changes under this URL. An older build's URL (a page
          // loaded before an upgrade) still gets today's file, just not cached.
          const cacheControl = m[1] === buildId ? 'public, max-age=31536000, immutable' : 'no-cache';
          await serveStatic(ctx, config.publicDir, { cacheControl });
        } else {
          await serveStatic(ctx, config.publicDir);
        }
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        ctx.json({ error: err.message }, err.status);
      } else {
        logger.error(`${ctx.method} ${ctx.path} failed:`, err);
        ctx.json({ error: 'Internal server error' }, 500);
      }
    }
  }

  const onRequest = (req, res) => {
    handle(req, res).catch((err) => {
      logger.error(err);
      res.destroy();
    });
  };
  const tls = config.tlsCertFile && config.tlsKeyFile
    ? { cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }
    : null;
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);

  const gateway = attachWsGateway(server, app);

  function maintenance() {
    const now = Date.now();
    const cutoff = now - config.logRetentionDays * 24 * HOUR;
    store.run('DELETE FROM tokens WHERE expires_at <= ?', now);
    store.run('DELETE FROM conn_logs WHERE started_at < ?', cutoff);
    store.run('DELETE FROM file_logs WHERE created_at < ?', cutoff);
    store.run('DELETE FROM activity WHERE created_at < ?', cutoff);
    app.auth.limiter.prune();
  }

  const timers = [];

  return {
    ...app,
    server,
    protocol: tls ? 'https' : 'http',

    /** Create the first administrator when the database is empty. */
    async bootstrap() {
      if (store.get('SELECT COUNT(*) AS n FROM users').n > 0) return null;
      const password = config.adminPassword || randomPassword();
      const now = Date.now();
      store.run(
        `INSERT INTO users (username, password_hash, is_admin, status, display_name, created_at, updated_at)
         VALUES (?, ?, 1, 1, 'Administrator', ?, ?)`,
        config.adminUsername, await hashPassword(password), now, now,
      );
      return { username: config.adminUsername, password, generated: !config.adminPassword };
    },

    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      maintenance();
      app.hbbs.sync();
      timers.push(setInterval(maintenance, HOUR).unref());
      if (config.hbbsDbPath) {
        timers.push(setInterval(() => app.hbbs.sync(), Math.max(5, config.hbbsSyncSeconds) * 1000).unref());
      }
      return server.address();
    },

    gateway,

    async close() {
      timers.forEach(clearInterval);
      gateway.closeAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
