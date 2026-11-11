import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Append-only: never edit a migration that has shipped, add a new one instead.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE tokens (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',
    device_uuid TEXT NOT NULL DEFAULT '',
    device_info TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX tokens_user ON tokens(user_id);

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    uuid TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    os TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    cpu TEXT NOT NULL DEFAULT '',
    memory TEXT NOT NULL DEFAULT '',
    sysinfo TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip TEXT,
    active_conns INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    sysinfo_at INTEGER,
    registered_at INTEGER
  );
  CREATE INDEX devices_owner ON devices(owner_id);
  CREATE INDEX devices_last_seen ON devices(last_seen_at);

  CREATE TABLE address_books (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE conn_logs (
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    conn_id INTEGER,
    session_id TEXT NOT NULL DEFAULT '',
    peer_id TEXT NOT NULL DEFAULT '',
    peer_name TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    conn_type INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX conn_logs_device ON conn_logs(device_id, conn_id);
  CREATE INDEX conn_logs_started ON conn_logs(started_at);

  CREATE TABLE file_logs (
    id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    peer_id TEXT NOT NULL DEFAULT '',
    peer_name TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    direction INTEGER,
    path TEXT NOT NULL DEFAULT '',
    is_file INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    files TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX file_logs_created ON file_logs(created_at);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX activity_created ON activity(created_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

// node:sqlite rejects booleans and undefined as bind values.
function normalize(params) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}

export class Store {
  #statements = new Map();

  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
  }

  #migrate() {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[i]);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  #stmt(sql) {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  get(sql, ...params) {
    return this.#stmt(sql).get(...normalize(params));
  }

  all(sql, ...params) {
    return this.#stmt(sql).all(...normalize(params));
  }

  run(sql, ...params) {
    return this.#stmt(sql).run(...normalize(params));
  }

  /** Run a synchronous function inside a transaction. */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getSetting(key) {
    return this.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? '';
  }

  setSetting(key, value) {
    if (value === '' || value === null || value === undefined) {
      this.run('DELETE FROM settings WHERE key = ?', key);
    } else {
      this.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        String(value),
      );
    }
  }

  close() {
    this.db.close();
  }
}
