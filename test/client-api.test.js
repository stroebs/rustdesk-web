import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN, startApp } from './helpers.js';

describe('RustDesk client API', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.stop());

  it('rejects wrong credentials with an error payload', async () => {
    const res = await t.request('POST', '/api/login', { body: { username: 'admin', password: 'nope', type: 'account' } });
    assert.equal(res.status, 200);
    assert.match(res.data.error, /wrong username or password/i);
  });

  it('logs in and returns an access token and user payload', async () => {
    const c = await t.clientSession(ADMIN.username, ADMIN.password, '111222333');
    assert.equal(c.login.type, 'access_token');
    assert.equal(c.login.user.name, 'admin');
    assert.equal(c.login.user.is_admin, true);

    const me = await c.post('/api/currentUser', { id: '111222333', uuid: 'x' });
    assert.equal(me.status, 200);
    assert.equal(me.data.name, 'admin');

    // Logging in assigns the device to the account.
    const device = t.app.store.get('SELECT owner_id FROM devices WHERE id = ?', '111222333');
    assert.equal(device.owner_id, 1);
  });

  it('returns 401 for an invalid token', async () => {
    const res = await t.request('POST', '/api/currentUser', { body: {}, headers: { Authorization: 'Bearer bogus' } });
    assert.equal(res.status, 401);
  });

  it('logout revokes the token', async () => {
    const c = await t.clientSession(ADMIN.username, ADMIN.password);
    assert.equal((await c.post('/api/logout', {})).status, 200);
    assert.equal((await c.post('/api/currentUser', {})).status, 401);
  });

  it('stores and returns the legacy address book', async () => {
    const c = await t.clientSession(ADMIN.username, ADMIN.password);
    const empty = await c.get('/api/ab');
    assert.deepEqual(JSON.parse(empty.data.data), { tags: [], peers: [], tag_colors: '{}' });

    const ab = { tags: ['office'], peers: [{ id: '987654321', alias: 'Reception', tags: ['office'], hash: 'secret' }], tag_colors: '{"office":4280391411}' };
    const push = await c.post('/api/ab', { data: JSON.stringify(ab) });
    assert.equal(push.status, 200);
    assert.equal(push.data, '');

    const pulled = await c.post('/api/ab/get', {});
    assert.deepEqual(JSON.parse(pulled.data.data), ab);
  });

  it('rejects malformed address book data', async () => {
    const c = await t.clientSession(ADMIN.username, ADMIN.password);
    assert.equal((await c.post('/api/ab', { data: '{not json' })).status, 400);
    assert.equal((await c.post('/api/ab', { data: '[1,2]' })).status, 400);
  });

  it('returns 404 for the shared address book API so clients use the legacy one', async () => {
    const c = await t.clientSession(ADMIN.username, ADMIN.password);
    assert.equal((await c.post('/api/ab/settings', {})).status, 404);
    assert.equal((await c.post('/api/ab/personal', {})).status, 404);
  });

  it('asks for sysinfo on first heartbeat and accepts it', async () => {
    const hb = await t.request('POST', '/api/heartbeat', { body: { id: '555666777', uuid: 'u', ver: 1003002, conns: [] } });
    assert.deepEqual(hb.data, { sysinfo: true });

    const si = await t.request('POST', '/api/sysinfo', {
      body: { id: '555666777', uuid: 'u', hostname: 'kiosk-1', username: 'kiosk', os: 'windows / Windows 11 Pro', version: '1.3.2', cpu: 'Intel i5', memory: '16GB' },
      raw: true,
    });
    assert.equal(si.data, 'SYSINFO_UPDATED');

    const hb2 = await t.request('POST', '/api/heartbeat', { body: { id: '555666777', uuid: 'u', conns: [3] } });
    assert.deepEqual(hb2.data, {});

    const d = t.app.store.get('SELECT * FROM devices WHERE id = ?', '555666777');
    assert.equal(d.hostname, 'kiosk-1');
    assert.equal(d.active_conns, 1);
    assert.ok(d.last_seen_at > 0);
  });

  it('records connection audit lifecycle', async () => {
    const post = (body) => t.request('POST', '/api/audit/conn', { body });
    await post({ action: 'new', id: '555666777', uuid: 'u', conn_id: 7, session_id: 1234567890123, ip: '::ffff:10.0.0.5' });
    await post({ id: '555666777', uuid: 'u', conn_id: 7, session_id: 1234567890123, peer: ['111222333', 'alice'], type: 0 });
    let row = t.app.store.get('SELECT * FROM conn_logs WHERE device_id = ? AND conn_id = 7', '555666777');
    assert.equal(row.ip, '10.0.0.5');
    assert.equal(row.peer_id, '111222333');
    assert.equal(row.peer_name, 'alice');
    assert.equal(row.conn_type, 0);
    assert.equal(row.ended_at, null);

    await post({ action: 'close', id: '555666777', uuid: 'u', conn_id: 7, session_id: 1234567890123 });
    row = t.app.store.get('SELECT * FROM conn_logs WHERE id = ?', row.id);
    assert.ok(row.ended_at >= row.started_at);
  });

  it('records file transfer audit entries', async () => {
    const res = await t.request('POST', '/api/audit/file', {
      body: { id: '555666777', uuid: 'u', peer_id: '111222333', type: 1, path: 'C:\\Users\\kiosk\\report.pdf', is_file: true, info: JSON.stringify({ ip: '10.0.0.5', name: 'alice', num: 1, files: [['report.pdf', 1024]] }) },
    });
    assert.equal(res.status, 200);
    const row = t.app.store.get('SELECT * FROM file_logs ORDER BY id DESC LIMIT 1');
    assert.equal(row.peer_name, 'alice');
    assert.equal(row.file_count, 1);
    assert.equal(row.is_file, 1);
  });

  it('lists users and peers for the signed-in account', async () => {
    const c = await t.clientSession(ADMIN.username, ADMIN.password, '111222333');
    const users = await c.get('/api/users?current=1&pageSize=100&status=1');
    assert.equal(users.data.total, 1);
    assert.equal(users.data.data[0].name, 'admin');
    const peers = await c.get('/api/peers?current=1&pageSize=100&status=1');
    assert.ok(peers.data.data.some((p) => p.id === '111222333' && p.user === 'admin'));
  });

  it('rate-limits repeated failed logins', async () => {
    for (let i = 0; i < 10; i++) {
      await t.request('POST', '/api/login', { body: { username: 'victim', password: 'x' } });
    }
    const res = await t.request('POST', '/api/login', { body: { username: 'victim', password: 'x' } });
    assert.match(res.data.error, /too many/i);
  });
});
