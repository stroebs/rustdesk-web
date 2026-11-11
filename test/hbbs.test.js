import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { startApp } from './helpers.js';

describe('hbbs integration', () => {
  let t;
  let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdesk-web-hbbs-'));
    // Same schema hbbs creates in db_v2.sqlite3.
    const db = new DatabaseSync(path.join(dir, 'db_v2.sqlite3'));
    db.exec(`CREATE TABLE peer (
      guid blob primary key not null, id varchar(100) not null, uuid blob not null, pk blob not null,
      created_at datetime not null default(current_timestamp), user blob, status tinyint, note varchar(300), info text not null)`);
    const insert = db.prepare('INSERT INTO peer (guid, id, uuid, pk, created_at, info) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(Buffer.from('g1'), '100200300', Buffer.from('u'), Buffer.from('pk'), '2026-01-02 03:04:05', '{"ip":"::ffff:192.0.2.7"}');
    insert.run(Buffer.from('g2'), '400500600', Buffer.from('u'), Buffer.from('pk'), '2026-02-03 04:05:06', '{}');
    db.close();
    fs.writeFileSync(path.join(dir, 'id_ed25519.pub'), 'PUBLICKEYBASE64=\n');

    t = await startApp({ hbbsDbPath: path.join(dir, 'db_v2.sqlite3'), hbbsKeyFile: path.join(dir, 'id_ed25519.pub') });
  });
  after(async () => {
    await t.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports registered peers', async () => {
    const admin = await t.adminSession();
    const { data } = await admin.get('/api/admin/devices');
    const device = data.items.find((d) => d.id === '100200300');
    assert.ok(device);
    assert.equal(device.ip, '192.0.2.7');
    assert.equal(device.registered_at, Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(device.online, false);
    assert.equal(data.total, 2);
  });

  it('keeps fresher data from heartbeats', async () => {
    await t.request('POST', '/api/heartbeat', { body: { id: '100200300', conns: [] } });
    t.app.hbbs.sync();
    const row = t.app.store.get('SELECT ip, last_seen_at FROM devices WHERE id = ?', '100200300');
    assert.equal(row.ip, '127.0.0.1');
    assert.ok(row.last_seen_at > 0);
  });

  it('reads the public key from the key file', async () => {
    const admin = await t.adminSession();
    const { data } = await admin.get('/api/admin/settings');
    assert.equal(data.key, 'PUBLICKEYBASE64=');
    assert.equal(data.key_source, 'file');
    assert.equal(data.hbbs.peers, 2);
  });
});
