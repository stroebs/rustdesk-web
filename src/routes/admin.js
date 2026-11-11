import { hashPassword, validatePassword } from '../auth.js';
import { AccessError, normalizeTeamDomain, parseAudiences, parseProxyList } from '../cfaccess.js';
import { effectiveServerConfig, encodeConfigString, installerName } from '../serverconfig.js';
import { isActive, unrecordedSessions } from '../sessions.js';
import { gatewayTargets } from '../wsgateway.js';
import { HttpError, cleanId, likePattern, paging, parseJson, str } from '../util.js';
import { EMPTY_ADDRESS_BOOK } from './client.js';

export const SESSION_COOKIE = 'rdw_session';
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'rustdesk-web';
const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const DAY = 86400 * 1000;

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    display_name: u.display_name,
    note: u.note,
    is_admin: Boolean(u.is_admin),
    status: u.status,
    created_at: u.created_at,
    updated_at: u.updated_at,
    last_login_at: u.last_login_at,
    cloudflare_email: u.cf_email ?? '',
    cloudflare_linked_at: u.cf_linked_at ?? null,
  };
}

function page(items, total, { page, pageSize }) {
  return { items, total, page, pageSize };
}

function searchClause(q, columns) {
  if (!q) return { sql: '', args: [] };
  const pattern = likePattern(q);
  return {
    sql: `(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    args: columns.map(() => pattern),
  };
}

function where(...clauses) {
  const parts = clauses.filter((c) => c.sql);
  return {
    sql: parts.length ? `WHERE ${parts.map((c) => c.sql).join(' AND ')}` : '',
    args: parts.flatMap((c) => c.args),
  };
}

function parseAddressBook(data) {
  const ab = parseJson(data ?? EMPTY_ADDRESS_BOOK, {});
  const tagColors = typeof ab.tag_colors === 'string' ? parseJson(ab.tag_colors, {}) : ab.tag_colors ?? {};
  return {
    raw: ab,
    tags: Array.isArray(ab.tags) ? ab.tags.filter((t) => typeof t === 'string') : [],
    tag_colors: tagColors && typeof tagColors === 'object' ? tagColors : {},
    peers: Array.isArray(ab.peers) ? ab.peers.filter((p) => p && typeof p === 'object' && p.id) : [],
  };
}

// Fields the client stores per peer that should never be shown in the UI.
const SECRET_PEER_FIELDS = ['hash', 'password'];

function redactPeer(peer) {
  const copy = { ...peer };
  for (const f of SECRET_PEER_FIELDS) delete copy[f];
  copy.tags = Array.isArray(copy.tags) ? copy.tags : [];
  return copy;
}

export function registerAdminRoutes(r, app) {
  const { store, auth, config } = app;
  const onlineSince = () => Date.now() - config.onlineThresholdSeconds * 1000;

  // Log rows are selected with the device's d.last_seen_at AS device_last_seen and
  // d.alive_conns AS device_alive.
  const connRow = (since) => ({ device_last_seen, device_alive, ...c }) => ({
    ...c,
    end_inferred: Boolean(c.end_inferred),
    active: isActive(c, device_last_seen, device_alive, since),
    device_online: device_last_seen >= since,
  });

  const csrf = (ctx) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD' && ctx.header(CSRF_HEADER) !== CSRF_VALUE) {
      throw new HttpError(403, 'Missing X-Requested-With header');
    }
  };

  const admin = (handler) => async (ctx) => {
    csrf(ctx);
    const user = await app.webUser(ctx.cookie(SESSION_COOKIE), ctx.req.headers);
    if (!user) throw new HttpError(401, 'Not signed in');
    if (!user.is_admin) throw new HttpError(403, 'Administrator access required');
    ctx.user = user;
    return handler(ctx);
  };

  const userById = (id) => {
    const user = store.get('SELECT * FROM users WHERE id = ?', Number(id));
    if (!user) throw new HttpError(404, 'User not found');
    return user;
  };

  const otherActiveAdmins = (id) =>
    store.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 1 AND id <> ?', id).n;

  // --- Session ------------------------------------------------------------
  r.post('/api/admin/login', async (ctx) => {
    csrf(ctx);
    const b = await ctx.body();
    const username = str(b.username, 64).trim();
    const password = str(b.password, 256);
    if (!username || !password) throw new HttpError(400, 'Username and password are required');

    const limit = auth.limiter.check(ctx.ip, username);
    if (!limit.ok) throw new HttpError(429, `Too many failed attempts. Try again in ${limit.retryAfter} seconds.`);

    const user = await auth.authenticate(username, password);
    if (!user) {
      auth.limiter.fail(ctx.ip, username);
      app.log(ctx, 'login_failed', username);
      throw new HttpError(401, 'Invalid username or password');
    }
    if (user.status !== 1) throw new HttpError(403, 'This account is disabled');
    if (!user.is_admin) throw new HttpError(403, 'Administrator access required');
    auth.limiter.reset(ctx.ip, username);

    const token = auth.createToken(user.id, 'web', { ip: ctx.ip, userAgent: ctx.header('user-agent') });
    store.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
    ctx.setCookie(SESSION_COOKIE, token);
    ctx.user = user;
    app.log(ctx, 'login');
    return { user: publicUser(user) };
  });

  // What the sign-in page can offer. Public; reveals the Access identity only to
  // the browser that presented its token.
  r.get('/api/admin/login-options', async (ctx) => {
    const cf = app.cloudflare.settings();
    const { identity } = cf.ready ? await app.cloudflare.identify(ctx.req.headers) : {};
    const linked = Boolean(identity && store.get("SELECT 1 FROM users WHERE cf_email = ? COLLATE NOCASE AND status = 1 AND is_admin = 1", identity.email));
    return { cloudflare: { enabled: cf.ready, auto_login: cf.auto_login, email: identity?.email ?? null, linked } };
  });

  // Sign in with the Cloudflare Access identity on this request (linked in My account).
  r.post('/api/admin/login/cloudflare', async (ctx) => {
    csrf(ctx);
    if (!app.cloudflare.settings().ready) throw new HttpError(404, 'Cloudflare Access sign-in is not enabled');
    const { identity, error } = await app.cloudflare.identify(ctx.req.headers);
    if (error) {
      app.log(ctx, 'login_failed', '', `cloudflare: ${error}`);
      throw new HttpError(401, `Cloudflare Access token rejected: ${error}`);
    }
    if (!identity) throw new HttpError(401, 'This request has no Cloudflare Access token. Open the console through its Access application.');
    const user = store.get('SELECT * FROM users WHERE cf_email = ? COLLATE NOCASE', identity.email);
    if (!user) {
      app.log(ctx, 'login_failed', identity.email, 'cloudflare: not linked');
      throw new HttpError(403, `No account is linked to ${identity.email}. Sign in with your password and link it under My account.`);
    }
    if (user.status !== 1) throw new HttpError(403, 'This account is disabled');
    if (!user.is_admin) throw new HttpError(403, 'Administrator access required');
    const token = auth.createToken(user.id, 'web', { ip: ctx.ip, userAgent: ctx.header('user-agent'), method: 'cloudflare' });
    store.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
    ctx.setCookie(SESSION_COOKIE, token);
    ctx.user = user;
    app.log(ctx, 'login', '', `cloudflare: ${identity.email}`);
    return { user: publicUser(user) };
  });

  r.post('/api/admin/logout', (ctx) => {
    csrf(ctx);
    auth.revoke(ctx.cookie(SESSION_COOKIE));
    ctx.setCookie(SESSION_COOKIE, '', { maxAge: 0 });
    return ctx.empty();
  });

  r.get('/api/admin/me', admin((ctx) => ({
    user: publicUser(ctx.user),
    auth_method: ctx.user.token_auth_method,
    version: app.version,
    source_url: config.sourceUrl,
  })));

  // --- Cloudflare Access identity of the signed-in user ---------------------
  const cloudflareStatus = async (ctx, user) => {
    const cf = app.cloudflare.settings();
    const { identity, error } = cf.ready ? await app.cloudflare.identify(ctx.req.headers) : {};
    return {
      enabled: cf.ready,
      auto_login: cf.auto_login,
      linked_email: user.cf_email,
      linked_at: user.cf_linked_at,
      identity: identity ? { email: identity.email } : null,
      error: error ?? null,
    };
  };

  r.get('/api/admin/me/cloudflare', admin((ctx) => cloudflareStatus(ctx, ctx.user)));

  // Link the Access identity on this request: proving it needs a valid token, so
  // nobody can link an address they cannot sign in to Cloudflare with.
  r.post('/api/admin/me/cloudflare', admin(async (ctx) => {
    if (!app.cloudflare.settings().ready) throw new HttpError(400, 'Cloudflare Access sign-in is not enabled in Settings');
    const { identity, error } = await app.cloudflare.identify(ctx.req.headers);
    if (error) throw new HttpError(400, `Cloudflare Access token rejected: ${error}`);
    if (!identity) throw new HttpError(400, 'This request has no Cloudflare Access token. Open the console through its Access application.');
    const other = store.get('SELECT username FROM users WHERE cf_email = ? COLLATE NOCASE AND id <> ?', identity.email, ctx.user.id);
    if (other) throw new HttpError(409, `${identity.email} is already linked to another account`);
    store.tx(() => {
      store.run('UPDATE users SET cf_email = ?, cf_linked_at = ?, updated_at = ? WHERE id = ?', identity.email, Date.now(), Date.now(), ctx.user.id);
      store.run("DELETE FROM tokens WHERE user_id = ? AND auth_method = 'cloudflare' AND id <> ?", ctx.user.id, ctx.user.token_id);
    });
    app.log(ctx, 'cloudflare_link', ctx.user.username, identity.email);
    return cloudflareStatus(ctx, userById(ctx.user.id));
  }));

  r.delete('/api/admin/me/cloudflare', admin(async (ctx) => {
    if (ctx.user.token_auth_method === 'cloudflare') {
      throw new HttpError(400, 'Sign in with your password to unlink Cloudflare Access (this session depends on it)');
    }
    store.tx(() => {
      store.run('UPDATE users SET cf_email = \'\', cf_linked_at = NULL, updated_at = ? WHERE id = ?', Date.now(), ctx.user.id);
      store.run("DELETE FROM tokens WHERE user_id = ? AND auth_method = 'cloudflare'", ctx.user.id);
    });
    app.log(ctx, 'cloudflare_unlink', ctx.user.username, ctx.user.cf_email);
    return cloudflareStatus(ctx, userById(ctx.user.id));
  }));

  r.post('/api/admin/me/password', admin(async (ctx) => {
    const b = await ctx.body();
    const valid = await auth.authenticate(ctx.user.username, str(b.current_password, 256));
    if (!valid) throw new HttpError(400, 'Current password is incorrect');
    const problem = validatePassword(b.new_password);
    if (problem) throw new HttpError(400, problem);
    const hash = await hashPassword(b.new_password);
    store.tx(() => {
      store.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), ctx.user.id);
      // Sign out every other session (browsers and RustDesk clients).
      store.run('DELETE FROM tokens WHERE user_id = ? AND id <> ?', ctx.user.id, ctx.user.token_id);
    });
    app.log(ctx, 'password_change', ctx.user.username);
    return ctx.empty();
  }));

  // --- Dashboard ----------------------------------------------------------
  r.get('/api/admin/stats', admin(() => {
    const since = onlineSince();
    const day = Date.now() - DAY;
    const cfg = effectiveServerConfig(app);
    return {
      users: store.get('SELECT COUNT(*) AS n FROM users').n,
      admins: store.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').n,
      devices: store.get('SELECT COUNT(*) AS n FROM devices').n,
      online: store.get('SELECT COUNT(*) AS n FROM devices WHERE last_seen_at >= ?', since).n,
      active_sessions: store.get('SELECT COALESCE(SUM(active_conns), 0) AS n FROM devices WHERE last_seen_at >= ?', since).n,
      connections_24h: store.get('SELECT COUNT(*) AS n FROM conn_logs WHERE started_at >= ?', day).n,
      files_24h: store.get('SELECT COUNT(*) AS n FROM file_logs WHERE created_at >= ?', day).n,
      recent_connections: store.all(
        `SELECT c.*, d.hostname, d.last_seen_at AS device_last_seen, d.alive_conns AS device_alive
         FROM conn_logs c LEFT JOIN devices d ON d.id = c.device_id
         ORDER BY c.started_at DESC LIMIT 8`,
      ).map(connRow(since)),
      unrecorded_sessions: unrecordedSessions(store, since),
      hbbs: app.hbbs.status,
      server_configured: Boolean(cfg.id_server && cfg.key),
    };
  }));

  // --- Users --------------------------------------------------------------
  r.get('/api/admin/users', admin((ctx) => {
    const p = paging(ctx.query, { maxSize: 500 });
    const w = where(searchClause(ctx.query.get('q')?.trim(), ['username', 'email', 'display_name', 'note', 'cf_email']));
    const total = store.get(`SELECT COUNT(*) AS n FROM users ${w.sql}`, ...w.args).n;
    const rows = store.all(
      `SELECT u.*,
         (SELECT COUNT(*) FROM devices d WHERE d.owner_id = u.id) AS device_count,
         (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.expires_at > ?) AS session_count
       FROM users u ${w.sql} ORDER BY u.username LIMIT ? OFFSET ?`,
      Date.now(), ...w.args, p.pageSize, p.offset,
    );
    return page(rows.map((u) => ({ ...publicUser(u), device_count: u.device_count, session_count: u.session_count })), total, p);
  }));

  const readUserFields = (b, { creating }) => {
    const out = {};
    if (creating || b.username !== undefined) {
      out.username = str(b.username, 64).trim();
      if (!USERNAME_RE.test(out.username)) {
        throw new HttpError(400, 'Username may only contain letters, digits and . _ @ - (max 64)');
      }
    }
    if (b.email !== undefined) {
      out.email = str(b.email, 254).trim();
      if (out.email && !EMAIL_RE.test(out.email)) throw new HttpError(400, 'Email address is not valid');
    }
    if (b.cloudflare_email !== undefined) {
      out.cf_email = str(b.cloudflare_email, 254).trim().toLowerCase();
      if (out.cf_email && !EMAIL_RE.test(out.cf_email)) throw new HttpError(400, 'Cloudflare Access email is not valid');
    }
    if (b.display_name !== undefined) out.display_name = str(b.display_name, 100).trim();
    if (b.note !== undefined) out.note = str(b.note, 1000);
    if (b.is_admin !== undefined) out.is_admin = b.is_admin ? 1 : 0;
    if (b.status !== undefined) out.status = Number(b.status) === 1 ? 1 : 0;
    if (creating || (b.password !== undefined && b.password !== '')) {
      const problem = validatePassword(b.password);
      if (problem) throw new HttpError(400, problem);
      out.password = b.password;
    }
    return out;
  };

  const checkCloudflareEmail = (email, userId) => {
    if (email && store.get('SELECT 1 FROM users WHERE cf_email = ? COLLATE NOCASE AND id <> ?', email, userId)) {
      throw new HttpError(409, `${email} is already linked to another account`);
    }
  };

  r.post('/api/admin/users', admin(async (ctx) => {
    const f = readUserFields(await ctx.body(), { creating: true });
    if (store.get('SELECT 1 FROM users WHERE username = ?', f.username)) {
      throw new HttpError(409, 'A user with that username already exists');
    }
    checkCloudflareEmail(f.cf_email, -1);
    const now = Date.now();
    const hash = await hashPassword(f.password);
    const { lastInsertRowid } = store.run(
      `INSERT INTO users (username, email, display_name, note, password_hash, is_admin, status, created_at, updated_at, cf_email, cf_linked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.username, f.email ?? '', f.display_name ?? '', f.note ?? '', hash, f.is_admin ?? 0, f.status ?? 1, now, now, f.cf_email ?? '', f.cf_email ? now : null,
    );
    app.log(ctx, 'user_create', f.username, f.is_admin ? 'admin' : '');
    return { user: publicUser(userById(lastInsertRowid)) };
  }));

  r.patch('/api/admin/users/:id', admin(async (ctx) => {
    const user = userById(ctx.params.id);
    const f = readUserFields(await ctx.body(), { creating: false });
    const isSelf = user.id === ctx.user.id;
    const losesAdmin = (f.is_admin === 0 || f.status === 0) && user.is_admin && user.status === 1;
    if (isSelf && (f.is_admin === 0 || f.status === 0)) {
      throw new HttpError(400, 'You cannot remove your own administrator access or disable yourself');
    }
    if (losesAdmin && otherActiveAdmins(user.id) === 0) {
      throw new HttpError(400, 'At least one active administrator is required');
    }
    if (f.username && f.username.toLowerCase() !== user.username.toLowerCase() &&
        store.get('SELECT 1 FROM users WHERE username = ? AND id <> ?', f.username, user.id)) {
      throw new HttpError(409, 'A user with that username already exists');
    }
    checkCloudflareEmail(f.cf_email, user.id);
    const cfChanged = f.cf_email !== undefined && f.cf_email !== user.cf_email.toLowerCase();
    if (cfChanged && isSelf && ctx.user.token_auth_method === 'cloudflare') {
      throw new HttpError(400, 'Sign in with your password to change your own Cloudflare Access link (this session depends on it)');
    }

    const hash = f.password ? await hashPassword(f.password) : null;
    const sets = [];
    const args = [];
    for (const col of ['username', 'email', 'display_name', 'note', 'is_admin', 'status']) {
      if (f[col] !== undefined) {
        sets.push(`${col} = ?`);
        args.push(f[col]);
      }
    }
    if (hash) {
      sets.push('password_hash = ?');
      args.push(hash);
    }
    if (cfChanged) {
      sets.push('cf_email = ?', 'cf_linked_at = ?');
      args.push(f.cf_email, f.cf_email ? Date.now() : null);
    }
    store.tx(() => {
      if (sets.length) store.run(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...args, Date.now(), user.id);
      // Changing the password or disabling the account signs the user out everywhere
      // (except the admin's own current browser session).
      if (hash || f.status === 0) store.run('DELETE FROM tokens WHERE user_id = ? AND id <> ?', user.id, isSelf ? ctx.user.token_id : -1);
      if (f.is_admin === 0) store.run("DELETE FROM tokens WHERE user_id = ? AND kind = 'web'", user.id);
      if (cfChanged) store.run("DELETE FROM tokens WHERE user_id = ? AND auth_method = 'cloudflare'", user.id);
    });
    const changed = Object.keys(f).filter((k) => k !== 'password' && (k !== 'cf_email' || cfChanged))
      .map((k) => (k === 'cf_email' ? 'cloudflare_email' : k)).concat(hash ? ['password'] : []);
    app.log(ctx, 'user_update', user.username, changed.join(', '));
    return { user: publicUser(userById(user.id)) };
  }));

  r.delete('/api/admin/users/:id', admin((ctx) => {
    const user = userById(ctx.params.id);
    if (user.id === ctx.user.id) throw new HttpError(400, 'You cannot delete your own account');
    if (user.is_admin && user.status === 1 && otherActiveAdmins(user.id) === 0) {
      throw new HttpError(400, 'At least one active administrator is required');
    }
    store.run('DELETE FROM users WHERE id = ?', user.id);
    app.log(ctx, 'user_delete', user.username);
    return ctx.empty();
  }));

  r.get('/api/admin/users/:id/sessions', admin((ctx) => {
    const user = userById(ctx.params.id);
    const rows = store.all(
      `SELECT id, kind, device_id, device_info, ip, user_agent, created_at, last_used_at, expires_at
       FROM tokens WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`,
      user.id, Date.now(),
    );
    return {
      items: rows.map((t) => ({ ...t, device_info: parseJson(t.device_info, {}), current: t.id === ctx.user.token_id })),
    };
  }));

  r.delete('/api/admin/sessions/:id', admin((ctx) => {
    const token = store.get(
      'SELECT t.id, t.kind, t.device_id, u.username FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?',
      Number(ctx.params.id),
    );
    if (!token) throw new HttpError(404, 'Session not found');
    store.run('DELETE FROM tokens WHERE id = ?', token.id);
    app.log(ctx, 'session_revoke', token.username, `${token.kind}${token.device_id ? ` ${token.device_id}` : ''}`);
    return ctx.empty();
  }));

  // --- Devices ------------------------------------------------------------
  const deviceRow = (d, since) => ({
    id: d.id,
    hostname: d.hostname,
    username: d.username,
    os: d.os,
    version: d.version,
    cpu: d.cpu,
    memory: d.memory,
    note: d.note,
    ip: d.ip,
    owner_id: d.owner_id,
    owner_username: d.owner_username ?? null,
    active_conns: d.last_seen_at >= since ? d.active_conns : 0,
    online: d.last_seen_at != null && d.last_seen_at >= since,
    first_seen_at: d.first_seen_at,
    last_seen_at: d.last_seen_at,
    sysinfo_at: d.sysinfo_at,
    registered_at: d.registered_at,
  });

  r.get('/api/admin/devices', admin((ctx) => {
    const p = paging(ctx.query);
    const since = onlineSince();
    const q = ctx.query.get('q')?.trim();
    const status = ctx.query.get('status');
    const owner = ctx.query.get('owner');
    const w = where(
      searchClause(q, ['d.id', 'd.hostname', 'd.username', 'd.os', 'd.note', 'd.ip', 'u.username']),
      status === 'online' ? { sql: 'd.last_seen_at >= ?', args: [since] } :
      status === 'offline' ? { sql: '(d.last_seen_at IS NULL OR d.last_seen_at < ?)', args: [since] } : { sql: '' },
      owner === 'none' ? { sql: 'd.owner_id IS NULL', args: [] } :
      owner ? { sql: 'd.owner_id = ?', args: [Number(owner)] } : { sql: '' },
    );
    const from = 'FROM devices d LEFT JOIN users u ON u.id = d.owner_id';
    const total = store.get(`SELECT COUNT(*) AS n ${from} ${w.sql}`, ...w.args).n;
    const rows = store.all(
      `SELECT d.*, u.username AS owner_username ${from} ${w.sql}
       ORDER BY d.last_seen_at IS NULL, d.last_seen_at DESC, d.id LIMIT ? OFFSET ?`,
      ...w.args, p.pageSize, p.offset,
    );
    return page(rows.map((d) => deviceRow(d, since)), total, p);
  }));

  const deviceById = (id) => {
    const d = store.get(
      'SELECT d.*, u.username AS owner_username FROM devices d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?',
      cleanId(id),
    );
    if (!d) throw new HttpError(404, 'Device not found');
    return d;
  };

  r.get('/api/admin/devices/:id', admin((ctx) => {
    const d = deviceById(ctx.params.id);
    const sysinfo = parseJson(d.sysinfo, {});
    delete sysinfo.uuid;
    return {
      device: { ...deviceRow(d, onlineSince()), uuid: d.uuid, sysinfo },
      connections: store.all(
        `SELECT c.*, d.last_seen_at AS device_last_seen, d.alive_conns AS device_alive
         FROM conn_logs c JOIN devices d ON d.id = c.device_id
         WHERE c.device_id = ? ORDER BY c.started_at DESC LIMIT 10`,
        d.id,
      ).map(connRow(onlineSince())),
    };
  }));

  r.patch('/api/admin/devices/:id', admin(async (ctx) => {
    const d = deviceById(ctx.params.id);
    const b = await ctx.body();
    const changes = [];
    if (b.note !== undefined) {
      store.run('UPDATE devices SET note = ? WHERE id = ?', str(b.note, 1000), d.id);
      changes.push('note');
    }
    if (b.owner_id !== undefined) {
      const ownerId = b.owner_id === null || b.owner_id === '' ? null : Number(b.owner_id);
      if (ownerId !== null) userById(ownerId);
      store.run('UPDATE devices SET owner_id = ? WHERE id = ?', ownerId, d.id);
      changes.push('owner');
    }
    app.log(ctx, 'device_update', d.id, changes.join(', '));
    return { device: deviceRow(deviceById(d.id), onlineSince()) };
  }));

  r.delete('/api/admin/devices/:id', admin((ctx) => {
    const d = deviceById(ctx.params.id);
    store.run('DELETE FROM devices WHERE id = ?', d.id);
    app.log(ctx, 'device_delete', d.id, d.hostname);
    return ctx.empty();
  }));

  // --- Address books ------------------------------------------------------
  r.get('/api/admin/address-books', admin(() => {
    const rows = store.all(
      `SELECT u.id, u.username, u.display_name, ab.data, ab.updated_at
       FROM users u LEFT JOIN address_books ab ON ab.user_id = u.id ORDER BY u.username`,
    );
    return {
      items: rows.map((row) => {
        const ab = parseAddressBook(row.data);
        return {
          user_id: row.id,
          username: row.username,
          display_name: row.display_name,
          peers: ab.peers.length,
          tags: ab.tags.length,
          updated_at: row.updated_at,
        };
      }),
    };
  }));

  r.get('/api/admin/address-books/:userId', admin((ctx) => {
    const user = userById(ctx.params.userId);
    const row = store.get('SELECT data, updated_at FROM address_books WHERE user_id = ?', user.id);
    const ab = parseAddressBook(row?.data);
    return {
      user: publicUser(user),
      tags: ab.tags,
      tag_colors: ab.tag_colors,
      peers: ab.peers.map(redactPeer),
      updated_at: row?.updated_at ?? null,
    };
  }));

  r.put('/api/admin/address-books/:userId', admin(async (ctx) => {
    const user = userById(ctx.params.userId);
    const b = await ctx.body({ limit: 8 * 1024 * 1024 });
    if (!Array.isArray(b.peers) || !Array.isArray(b.tags)) throw new HttpError(400, 'peers and tags must be arrays');

    const tags = [...new Set(b.tags.map((t) => str(t, 100).trim()).filter(Boolean))];
    const tagColors = {};
    for (const [name, color] of Object.entries(b.tag_colors ?? {})) {
      if (tags.includes(name) && Number.isInteger(color)) tagColors[name] = color;
    }

    store.tx(() => {
      const row = store.get('SELECT data FROM address_books WHERE user_id = ?', user.id);
      const existing = parseAddressBook(row?.data);
      const previous = new Map(existing.peers.map((p) => [String(p.id), p]));
      const seen = new Set();
      const peers = [];
      for (const input of b.peers) {
        const id = cleanId(input?.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        // Keep fields the client stores but the UI doesn't edit (saved password hash, RDP settings, ...).
        peers.push({
          ...previous.get(id),
          id,
          alias: str(input.alias, 255),
          hostname: str(input.hostname, 255),
          username: str(input.username, 255),
          platform: str(input.platform, 50),
          tags: Array.isArray(input.tags) ? input.tags.map((t) => str(t, 100)).filter((t) => tags.includes(t)) : [],
        });
      }
      const data = JSON.stringify({ ...existing.raw, tags, peers, tag_colors: JSON.stringify(tagColors) });
      store.run(
        `INSERT INTO address_books (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        user.id, data, Date.now(),
      );
    });
    app.log(ctx, 'address_book_update', user.username, `${b.peers.length} peers, ${tags.length} tags`);
    return ctx.empty();
  }));

  // --- Logs ---------------------------------------------------------------
  r.get('/api/admin/audit/connections', admin((ctx) => {
    const p = paging(ctx.query);
    const since = onlineSince();
    const device = ctx.query.get('device');
    const w = where(
      searchClause(ctx.query.get('q')?.trim(), ['c.device_id', 'c.peer_id', 'c.peer_name', 'c.ip', 'd.hostname']),
      device ? { sql: 'c.device_id = ?', args: [device] } : { sql: '' },
    );
    const from = 'FROM conn_logs c LEFT JOIN devices d ON d.id = c.device_id';
    const total = store.get(`SELECT COUNT(*) AS n ${from} ${w.sql}`, ...w.args).n;
    const rows = store.all(
      `SELECT c.*, d.hostname, d.last_seen_at AS device_last_seen, d.alive_conns AS device_alive ${from} ${w.sql}
       ORDER BY c.started_at DESC LIMIT ? OFFSET ?`,
      ...w.args, p.pageSize, p.offset,
    );
    const unrecorded = unrecordedSessions(store, since).filter((u) => !device || u.device_id === device);
    return { ...page(rows.map(connRow(since)), total, p), unrecorded_sessions: unrecorded };
  }));

  r.get('/api/admin/audit/files', admin((ctx) => {
    const p = paging(ctx.query);
    const w = where(searchClause(ctx.query.get('q')?.trim(), ['f.device_id', 'f.peer_id', 'f.peer_name', 'f.path', 'f.ip', 'd.hostname']));
    const from = 'FROM file_logs f LEFT JOIN devices d ON d.id = f.device_id';
    const total = store.get(`SELECT COUNT(*) AS n ${from} ${w.sql}`, ...w.args).n;
    const rows = store.all(
      `SELECT f.*, d.hostname ${from} ${w.sql} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
      ...w.args, p.pageSize, p.offset,
    );
    return page(rows.map((f) => ({ ...f, is_file: Boolean(f.is_file), files: parseJson(f.files, []) })), total, p);
  }));

  r.get('/api/admin/activity', admin((ctx) => {
    const p = paging(ctx.query);
    const w = where(searchClause(ctx.query.get('q')?.trim(), ['username', 'action', 'target', 'detail', 'ip']));
    const total = store.get(`SELECT COUNT(*) AS n FROM activity ${w.sql}`, ...w.args).n;
    const rows = store.all(`SELECT * FROM activity ${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...w.args, p.pageSize, p.offset);
    return page(rows, total, p);
  }));

  // --- Browser remote sessions -------------------------------------------
  r.get('/api/admin/remote/config', admin(() => {
    const targets = gatewayTargets(app);
    const cfg = effectiveServerConfig(app);
    return {
      // hbbs checks licence_key against its key, and the client verifies peer identities with it.
      key: cfg.key,
      ready: Boolean(targets.id && targets.relay && cfg.key),
      problems: [
        !targets.id && 'Set the ID server in Settings (or HBBS_WS_URL) so the console can reach hbbs.',
        !targets.relay && 'Set the relay server in Settings (or HBBR_WS_URL) so the console can reach hbbr.',
        !cfg.key && 'Set the public key in Settings: peers are verified with it.',
      ].filter(Boolean),
    };
  }));

  r.post('/api/admin/remote/sessions', admin(async (ctx) => {
    const b = await ctx.body();
    const peerId = cleanId(b.peer_id);
    if (!peerId) throw new HttpError(400, 'Missing peer_id');
    app.log(ctx, 'web_session', peerId, str(b.detail, 200));
    return ctx.empty();
  }));

  // --- Settings -----------------------------------------------------------
  const CF_KEYS = ['cf_enabled', 'cf_team_domain', 'cf_audience', 'cf_auto_login', 'cf_client_ip', 'cf_trusted_proxies'];
  const cloudflareSettings = () => {
    const cf = app.cloudflare.settings();
    return {
      enabled: cf.enabled,
      ready: cf.ready,
      team_domain: cf.team_domain,
      issuer: cf.issuer,
      certs_url: cf.certs_url,
      audiences: cf.audiences,
      auto_login: cf.auto_login,
      client_ip: cf.client_ip,
      trusted_proxies: cf.trusted_proxies,
      problems: cf.problems,
      sources: cf.sources,
      saved: Object.fromEntries(CF_KEYS.map((k) => [k.slice(3), store.getSetting(k)])),
      linked_users: store.get("SELECT COUNT(*) AS n FROM users WHERE cf_email <> ''").n,
    };
  };

  const settingsPayload = () => {
    const cfg = effectiveServerConfig(app);
    return {
      ...cfg,
      config_string: cfg.id_server ? encodeConfigString(cfg) : '',
      installer_name: installerName(cfg),
      saved: {
        id_server: store.getSetting('id_server'),
        relay_server: store.getSetting('relay_server'),
        api_server: store.getSetting('api_server'),
        key: store.getSetting('key'),
      },
      environment: {
        online_threshold_seconds: config.onlineThresholdSeconds,
        client_token_ttl_days: config.clientTokenTtlDays,
        session_ttl_hours: config.sessionTtlHours,
        log_retention_days: config.logRetentionDays,
        hbbs_db: Boolean(config.hbbsDbPath),
        hbbs_key_file: Boolean(config.hbbsKeyFile),
        trust_proxy: config.trustProxy,
      },
      cloudflare: cloudflareSettings(),
      hbbs: app.hbbs.status,
      version: app.version,
    };
  };

  r.get('/api/admin/settings', admin(settingsPayload));

  r.put('/api/admin/settings', admin(async (ctx) => {
    const b = await ctx.body();
    const changed = [];
    // Cloudflare: "" (or null) clears a saved value, falling back to the environment.
    const cf = b.cloudflare && typeof b.cloudflare === 'object' ? b.cloudflare : {};
    const cfValues = {};
    for (const name of ['enabled', 'auto_login', 'client_ip']) {
      const v = cf[name];
      if (v === undefined) continue;
      cfValues[name] = v === null || v === '' ? '' : v === true || v === '1' || v === 1 ? '1' : v === false || v === '0' || v === 0 ? '0' : null;
      if (cfValues[name] === null) throw new HttpError(400, `cloudflare.${name} must be true, false or empty`);
    }
    try {
      if (cf.team_domain !== undefined) cfValues.team_domain = normalizeTeamDomain(str(cf.team_domain ?? '', 300));
      if (cf.audience !== undefined) cfValues.audience = parseAudiences(str(cf.audience ?? '', 2000)).join(',');
      if (cf.trusted_proxies !== undefined) {
        const list = str(cf.trusted_proxies ?? '', 4000).split(/[\s,]+/).filter(Boolean).join(', ');
        parseProxyList(list);
        cfValues.trusted_proxies = list;
      }
    } catch (err) {
      if (err instanceof AccessError) throw new HttpError(400, err.message);
      throw err;
    }
    for (const [name, value] of Object.entries(cfValues)) {
      store.setSetting(`cf_${name}`, value);
      changed.push(`cloudflare.${name}`);
    }
    app.cloudflare.invalidate();

    for (const key of ['id_server', 'relay_server', 'api_server', 'key']) {
      if (b[key] === undefined) continue;
      const value = str(b[key], 500).trim();
      if (/\s/.test(value)) throw new HttpError(400, `${key} must not contain spaces`);
      if (key === 'api_server' && value && !/^https?:\/\/[^/\s]+/i.test(value)) {
        throw new HttpError(400, 'API server must start with http:// or https://');
      }
      store.setSetting(key, key === 'api_server' ? value.replace(/\/+$/, '') : value);
      changed.push(key);
    }
    app.log(ctx, 'settings_update', '', changed.join(', '));
    return settingsPayload();
  }));
}
