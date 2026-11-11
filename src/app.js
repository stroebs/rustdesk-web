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

export function createApp(config, { logger = console } = {}) {
  const store = new Store(config.dbPath);
  const app = {
    config,
    store,
    logger,
    version: pkg.version,
    auth: new Auth(store, config),
    hbbs: new Hbbs(store, config),
    log(ctx, action, target = '', detail = '') {
      store.run(
        'INSERT INTO activity (created_at, user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        Date.now(), ctx.user?.id ?? null, ctx.user?.username ?? '', action, String(target), String(detail), ctx.ip ?? '',
      );
    },
  };

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
      } else {
        await serveStatic(ctx, config.publicDir);
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
