/**
 * Endpoints called by the RustDesk client when its "API server" option points here.
 *
 * Address books use the "legacy" single-document protocol (GET/POST /api/ab).
 * The shared address-book endpoints (/api/ab/settings, /api/ab/personal, ...)
 * intentionally return 404 so clients fall back to it.
 */
import { parseAlive, reconcileHeartbeat } from '../sessions.js';
import { HttpError, cleanId, cleanIp, intOrNull, paging, str } from '../util.js';

export const EMPTY_ADDRESS_BOOK = JSON.stringify({ tags: [], peers: [], tag_colors: '{}' });
const AB_LIMIT = 8 * 1024 * 1024;

export function clientUserPayload(user) {
  return {
    name: user.username,
    display_name: user.display_name || user.username,
    email: user.email,
    note: user.note,
    status: user.status,
    is_admin: Boolean(user.is_admin),
    info: { email_verification: false, email_alarm_notification: false, login_device_whitelist: [], other: {} },
  };
}

export function registerClientRoutes(r, app) {
  const { store, auth } = app;

  const requireClient = (ctx) => {
    const user = auth.lookup(ctx.bearer(), 'client');
    if (!user) throw new HttpError(401, 'Invalid token');
    ctx.user = user;
    return user;
  };

  r.get('/api/login-options', () => []);

  r.post('/api/login', async (ctx) => {
    const b = await ctx.body();
    const username = str(b.username, 64).trim();
    const password = str(b.password, 256);
    if (b.type && b.type !== 'account') return { error: 'Only username and password login is supported' };
    if (!username || !password) return { error: 'Username and password are required' };

    const limit = auth.limiter.check(ctx.ip, username);
    if (!limit.ok) return { error: `Too many failed attempts. Try again in ${limit.retryAfter} seconds.` };

    const user = await auth.authenticate(username, password);
    if (!user) {
      auth.limiter.fail(ctx.ip, username);
      app.log(ctx, 'client_login_failed', username);
      return { error: 'Wrong username or password' };
    }
    if (user.status !== 1) return { error: 'This account is disabled' };
    auth.limiter.reset(ctx.ip, username);

    const deviceId = cleanId(b.id);
    const deviceUuid = str(b.uuid, 200);
    const token = auth.createToken(user.id, 'client', {
      deviceId,
      deviceUuid,
      deviceInfo: JSON.stringify(b.deviceInfo ?? {}).slice(0, 1000),
      ip: ctx.ip,
      userAgent: ctx.header('user-agent'),
    });
    const now = Date.now();
    if (deviceId) {
      // Like RustDesk Server Pro: a device belongs to the account last signed in on it.
      store.run(
        `INSERT INTO devices (id, uuid, owner_id, ip, first_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, uuid = CASE WHEN excluded.uuid <> '' THEN excluded.uuid ELSE devices.uuid END`,
        deviceId, deviceUuid, user.id, ctx.ip, now,
      );
    }
    store.run('UPDATE users SET last_login_at = ? WHERE id = ?', now, user.id);
    ctx.user = user;
    app.log(ctx, 'client_login', deviceId, str(b.deviceInfo?.name, 200));
    return { type: 'access_token', access_token: token, user: clientUserPayload(user) };
  });

  r.post('/api/logout', (ctx) => {
    auth.revoke(ctx.bearer());
    return ctx.empty();
  });

  r.post('/api/currentUser', (ctx) => clientUserPayload(requireClient(ctx)));

  // --- Address book (legacy protocol) -------------------------------------
  const getAb = (ctx) => {
    const user = requireClient(ctx);
    const row = store.get('SELECT data FROM address_books WHERE user_id = ?', user.id);
    return { data: row?.data ?? EMPTY_ADDRESS_BOOK };
  };
  r.get('/api/ab', getAb);
  r.post('/api/ab/get', getAb);

  r.post('/api/ab', async (ctx) => {
    const user = requireClient(ctx);
    const b = await ctx.body({ limit: AB_LIMIT });
    if (typeof b.data !== 'string') throw new HttpError(400, 'Missing address book data');
    let parsed;
    try {
      parsed = JSON.parse(b.data);
    } catch {
      throw new HttpError(400, 'Address book data is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Address book data must be an object');
    }
    store.run(
      `INSERT INTO address_books (user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      user.id, b.data, Date.now(),
    );
    return ctx.empty();
  });

  // --- Users / peers visible to the signed-in account ---------------------
  r.get('/api/users', (ctx) => {
    const user = requireClient(ctx);
    const { pageSize, offset } = paging(ctx.query, { defaultSize: 100, maxSize: 500 });
    const where = user.is_admin ? 'WHERE status = 1' : 'WHERE id = ?';
    const args = user.is_admin ? [] : [user.id];
    const total = store.get(`SELECT COUNT(*) AS n FROM users ${where}`, ...args).n;
    const rows = store.all(`SELECT * FROM users ${where} ORDER BY username LIMIT ? OFFSET ?`, ...args, pageSize, offset);
    return { total, data: rows.map(clientUserPayload) };
  });

  r.get('/api/peers', (ctx) => {
    const user = requireClient(ctx);
    const { pageSize, offset } = paging(ctx.query, { defaultSize: 100, maxSize: 500 });
    const where = user.is_admin ? '' : 'WHERE d.owner_id = ?';
    const args = user.is_admin ? [] : [user.id];
    const total = store.get(`SELECT COUNT(*) AS n FROM devices d ${where}`, ...args).n;
    const rows = store.all(
      `SELECT d.*, u.username AS owner_username, u.display_name AS owner_display_name
       FROM devices d LEFT JOIN users u ON u.id = d.owner_id ${where}
       ORDER BY d.id LIMIT ? OFFSET ?`,
      ...args, pageSize, offset,
    );
    return {
      total,
      data: rows.map((d) => ({
        id: d.id,
        info: { username: d.username, os: d.os, device_name: d.hostname },
        status: 1,
        user: d.owner_username ?? '',
        user_name: d.owner_display_name || d.owner_username || '',
        note: d.note,
      })),
    };
  });

  r.get('/api/device-group/accessible', (ctx) => {
    requireClient(ctx);
    return { total: 0, data: [] };
  });

  // --- Device telemetry ----------------------------------------------------
  r.post('/api/heartbeat', async (ctx) => {
    const b = await ctx.body();
    const id = cleanId(b.id);
    if (!id) throw new HttpError(400, 'Missing id');
    const now = Date.now();
    // Clients omit `conns` entirely when nothing is open.
    const alive = parseAlive(b.conns ?? []);
    store.tx(() => {
      store.run(
        `INSERT INTO devices (id, uuid, ip, active_conns, alive_conns, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, ip = excluded.ip,
           active_conns = excluded.active_conns, alive_conns = excluded.alive_conns,
           uuid = CASE WHEN excluded.uuid <> '' THEN excluded.uuid ELSE devices.uuid END`,
        id, str(b.uuid, 200), ctx.ip, alive.length, JSON.stringify(alive), now, now,
      );
      reconcileHeartbeat(store, id, alive, now);
    });
    const device = store.get('SELECT sysinfo_at FROM devices WHERE id = ?', id);
    // Ask the client to (re-)upload its system information when we have none.
    return device?.sysinfo_at ? {} : { sysinfo: true };
  });

  r.post('/api/sysinfo', async (ctx) => {
    const b = await ctx.body({ limit: 256 * 1024 });
    const id = cleanId(b.id);
    if (!id) throw new HttpError(400, 'Missing id');
    const now = Date.now();
    store.run(
      `INSERT INTO devices (id, uuid, hostname, username, os, version, cpu, memory, sysinfo, ip, first_seen_at, last_seen_at, sysinfo_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         uuid = CASE WHEN excluded.uuid <> '' THEN excluded.uuid ELSE devices.uuid END,
         hostname = excluded.hostname, username = excluded.username, os = excluded.os,
         version = excluded.version, cpu = excluded.cpu, memory = excluded.memory,
         sysinfo = excluded.sysinfo, ip = excluded.ip, last_seen_at = excluded.last_seen_at,
         sysinfo_at = excluded.sysinfo_at`,
      id, str(b.uuid, 200), str(b.hostname, 255), str(b.username, 255), str(b.os, 255),
      str(b.version, 64), str(b.cpu, 255), str(b.memory, 64), JSON.stringify(b).slice(0, 64 * 1024),
      ctx.ip, now, now, now,
    );
    return ctx.text('SYSINFO_UPDATED');
  });

  // --- Audit logs ---------------------------------------------------------
  r.post('/api/audit/conn', async (ctx) => {
    const b = await ctx.body();
    const deviceId = cleanId(b.id);
    if (!deviceId) throw new HttpError(400, 'Missing id');
    const connId = intOrNull(b.conn_id);
    const now = Date.now();
    const openRow = `SELECT id FROM conn_logs WHERE device_id = ? AND conn_id IS ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`;

    if (b.action === 'new') {
      // Connection IDs restart from 1 when the RustDesk service restarts; an older
      // row still open under the same ID can no longer be the live connection.
      store.run(
        `UPDATE conn_logs SET ended_at = COALESCE(last_alive_at, started_at), end_inferred = 1
         WHERE device_id = ? AND conn_id IS ? AND ended_at IS NULL`,
        deviceId, connId,
      );
      store.run(
        'INSERT INTO conn_logs (device_id, conn_id, session_id, ip, started_at) VALUES (?, ?, ?, ?, ?)',
        deviceId, connId, str(b.session_id, 64), cleanIp(b.ip), now,
      );
    } else if (b.action === 'close') {
      store.run(`UPDATE conn_logs SET ended_at = ? WHERE id = (${openRow})`, now, deviceId, connId);
    } else if (Array.isArray(b.peer) || b.type !== undefined) {
      const [peerId, peerName] = Array.isArray(b.peer) ? b.peer : [];
      const res = store.run(
        `UPDATE conn_logs SET peer_id = ?, peer_name = ?, conn_type = ? WHERE id = (${openRow})`,
        str(peerId, 100), str(peerName, 255), intOrNull(b.type), deviceId, connId,
      );
      if (!res.changes) {
        store.run(
          `INSERT INTO conn_logs (device_id, conn_id, session_id, peer_id, peer_name, conn_type, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          deviceId, connId, str(b.session_id, 64), str(peerId, 100), str(peerName, 255), intOrNull(b.type), now,
        );
      }
    }
    return ctx.empty();
  });

  r.post('/api/audit/file', async (ctx) => {
    const b = await ctx.body({ limit: 4 * 1024 * 1024 });
    const deviceId = cleanId(b.id);
    if (!deviceId) throw new HttpError(400, 'Missing id');
    let info = b.info;
    if (typeof info === 'string') {
      try {
        info = JSON.parse(info);
      } catch {
        info = {};
      }
    }
    if (!info || typeof info !== 'object') info = {};
    const files = Array.isArray(info.files) ? info.files : [];
    store.run(
      `INSERT INTO file_logs (device_id, peer_id, peer_name, ip, direction, path, is_file, file_count, files, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deviceId, cleanId(b.peer_id), str(info.name, 255), cleanIp(info.ip), intOrNull(b.type),
      str(b.path, 4096), Boolean(b.is_file), intOrNull(info.num) ?? files.length,
      JSON.stringify(files.slice(0, 500)), Date.now(),
    );
    return ctx.empty();
  });

  r.post('/api/audit/alarm', async (ctx) => {
    const b = await ctx.body();
    app.log(ctx, 'client_alarm', cleanId(b.id), JSON.stringify({ typ: b.typ, info: b.info }).slice(0, 2000));
    return ctx.empty();
  });
}
