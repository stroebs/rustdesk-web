import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

export class Router {
  #routes = [];

  #add(method, pattern, handler) {
    const keys = [];
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      });
    this.#routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler });
  }

  get(p, h) { this.#add('GET', p, h); }
  post(p, h) { this.#add('POST', p, h); }
  put(p, h) { this.#add('PUT', p, h); }
  patch(p, h) { this.#add('PATCH', p, h); }
  delete(p, h) { this.#add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.#routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) {
        pathMatched = true;
        continue;
      }
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          params[key] = m[i + 1];
        }
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function clientIp(req, trustProxy, forwardedIp) {
  if (forwardedIp) return forwardedIp;
  let ip = req.socket.remoteAddress ?? '';
  if (trustProxy) {
    // Right-most entry is the address our (single, trusted) proxy saw.
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (forwarded.length) ip = forwarded[forwarded.length - 1];
  }
  return ip.replace(/^::ffff:/, '');
}

export class Context {
  #body;

  /** `forwardedIp`: a client address already vouched for (Cloudflare's CF-Connecting-IP). */
  constructor(req, res, config, { forwardedIp = null } = {}) {
    this.req = req;
    this.res = res;
    this.config = config;
    this.url = new URL(req.url ?? '/', 'http://localhost');
    this.path = this.url.pathname;
    this.query = this.url.searchParams;
    this.method = req.method ?? 'GET';
    this.params = {};
    this.user = null;
    this.ip = clientIp(req, config.trustProxy, forwardedIp);
  }

  header(name) {
    const value = this.req.headers[name.toLowerCase()];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  }

  get secure() {
    if (this.req.socket.encrypted) return true;
    return this.config.trustProxy && this.header('x-forwarded-proto').split(',')[0].trim() === 'https';
  }

  bearer() {
    const m = /^Bearer\s+(.+)$/i.exec(this.header('authorization'));
    return m ? m[1].trim() : '';
  }

  cookie(name) {
    for (const part of this.header('cookie').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) {
        try {
          return decodeURIComponent(part.slice(i + 1).trim());
        } catch {
          return '';
        }
      }
    }
    return '';
  }

  /** Parse the JSON request body (cached). Empty bodies yield `{}`. */
  async body({ limit = 1024 * 1024 } = {}) {
    if (this.#body !== undefined) return this.#body;
    const chunks = [];
    let size = 0;
    for await (const chunk of this.req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    }
    this.#body = parsed !== null && typeof parsed === 'object' ? parsed : {};
    return this.#body;
  }

  #send(status, type, payload) {
    this.res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    this.res.end(this.method === 'HEAD' ? undefined : payload);
  }

  json(data, status = 200) {
    this.#send(status, 'application/json; charset=utf-8', JSON.stringify(data));
  }

  text(text, status = 200) {
    this.#send(status, 'text/plain; charset=utf-8', text);
  }

  empty(status = 200) {
    this.res.writeHead(status, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
    this.res.end();
  }

  setCookie(name, value, { maxAge, httpOnly = true } = {}) {
    let cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Strict`;
    if (httpOnly) cookie += '; HttpOnly';
    if (maxAge !== undefined) cookie += `; Max-Age=${maxAge}`;
    const secure = this.config.cookieSecure === 'auto' ? this.secure : /^(1|true|yes|on)$/.test(this.config.cookieSecure);
    if (secure) cookie += '; Secure';
    const existing = this.res.getHeader('Set-Cookie');
    this.res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : cookie);
  }
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export async function serveStatic(ctx, root, { cacheControl = 'no-cache' } = {}) {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return ctx.text('Method not allowed', 405);
  let rel;
  try {
    rel = decodeURIComponent(ctx.path);
  } catch {
    return ctx.text('Bad request', 400);
  }
  if (rel.includes('\0')) return ctx.text('Bad request', 400);

  let file = path.join(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return ctx.text('Not found', 404);

  let stat = await fs.promises.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = await fs.promises.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) return ctx.text('Not found', 404);

  const lastModified = stat.mtime.toUTCString();
  if (ctx.header('if-modified-since') === lastModified) {
    ctx.res.writeHead(304);
    return ctx.res.end();
  }
  ctx.res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Last-Modified': lastModified,
    'Cache-Control': cacheControl,
  });
  if (ctx.method === 'HEAD') return ctx.res.end();
  await new Promise((resolve) => {
    fs.createReadStream(file).on('error', () => ctx.res.destroy()).on('close', resolve).pipe(ctx.res);
  });
}
