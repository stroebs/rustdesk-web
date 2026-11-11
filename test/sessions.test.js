import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { OPEN_GRACE_MS } from '../src/sessions.js';
import { startApp } from './helpers.js';

const DEV = '1138368930';

describe('connection log reconciliation with heartbeats', () => {
  let t;
  let admin;
  const heartbeat = (conns) => t.request('POST', '/api/heartbeat', { body: conns === undefined ? { id: DEV } : { id: DEV, conns } });
  const audit = (body) => t.request('POST', '/api/audit/conn', { body: { id: DEV, session_id: 0, ...body } });
  const rows = () => t.app.store.all('SELECT * FROM conn_logs WHERE device_id = ? ORDER BY id', DEV);
  const age = (ms) => t.app.store.run('UPDATE conn_logs SET started_at = started_at - ?', ms);

  before(async () => {
    t = await startApp();
    admin = await t.adminSession();
  });
  after(() => t.stop());
  beforeEach(() => t.app.store.run('DELETE FROM conn_logs'));

  it('marks a logged session active only while heartbeats report it', async () => {
    await audit({ action: 'new', conn_id: 1975, ip: '101.174.15.246' });
    await audit({ conn_id: 1975, peer: ['413111078', 'PC2'], type: 0 });
    await heartbeat([1975]);

    let list = (await admin.get('/api/admin/audit/connections')).data;
    assert.equal(list.items[0].active, true);
    assert.deepEqual(list.unrecorded_sessions, []);
    assert.ok(rows()[0].last_alive_at > 0);

    // Heartbeat no longer lists it, but it's younger than the grace period: still open.
    await heartbeat();
    assert.equal(rows()[0].ended_at, null);
    list = (await admin.get('/api/admin/audit/connections')).data;
    assert.equal(list.items[0].active, false);
  });

  it('infers the end of a session whose close audit was lost', async () => {
    await audit({ action: 'new', conn_id: 7 });
    await heartbeat([7]);
    const lastAlive = rows()[0].last_alive_at;
    age(OPEN_GRACE_MS + 1000);
    await heartbeat();

    const [row] = rows();
    assert.equal(row.ended_at, lastAlive);
    assert.equal(row.end_inferred, 1);
    const item = (await admin.get('/api/admin/audit/connections')).data.items[0];
    assert.equal(item.end_inferred, true);
    assert.equal(item.active, false);
  });

  it('reports sessions that are open but were never logged', async () => {
    // e.g. session started while the API server was down: heartbeat knows, log doesn't.
    await heartbeat([42, 43]);
    await audit({ action: 'new', conn_id: 43 });

    const expected = [{ device_id: DEV, hostname: '', ip: '127.0.0.1', count: 1 }];
    assert.deepEqual((await admin.get('/api/admin/audit/connections')).data.unrecorded_sessions, expected);
    const stats = (await admin.get('/api/admin/stats')).data;
    assert.equal(stats.active_sessions, 2);
    assert.deepEqual(stats.unrecorded_sessions, expected);
    // Filtering by another device hides it.
    assert.deepEqual((await admin.get('/api/admin/audit/connections?device=999')).data.unrecorded_sessions, []);
  });

  it('closes a stale row when a new connection reuses its ID after a client restart', async () => {
    await audit({ action: 'new', conn_id: 1 });
    await audit({ action: 'new', conn_id: 1 });
    const [old, current] = rows();
    assert.equal(old.end_inferred, 1);
    assert.ok(old.ended_at);
    assert.equal(current.ended_at, null);
  });

  it('ignores junk in the conns field', async () => {
    const res = await heartbeat(['x', 5, 5, null, 2.5]);
    assert.equal(res.status, 200);
    const d = t.app.store.get('SELECT active_conns, alive_conns FROM devices WHERE id = ?', DEV);
    assert.equal(d.active_conns, 1);
    assert.equal(d.alive_conns, '[5]');
  });
});
