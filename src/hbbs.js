import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { cleanIp, parseJson } from './util.js';

/** hbbs stores `created_at` as "YYYY-MM-DD HH:MM:SS" in UTC. */
function parseSqliteDate(value) {
  if (!value) return null;
  const ms = Date.parse(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Optional, read-only integration with a local hbbs instance: imports the
 * peers hbbs knows about and exposes its public key.
 */
export class Hbbs {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.status = { enabled: Boolean(config.hbbsDbPath), lastSync: null, peers: 0, error: null };
  }

  readKey() {
    if (!this.config.hbbsKeyFile) return '';
    try {
      return fs.readFileSync(this.config.hbbsKeyFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  sync() {
    if (!this.config.hbbsDbPath) return;
    let db;
    try {
      db = new DatabaseSync(this.config.hbbsDbPath, { readOnly: true });
      const rows = db.prepare('SELECT id, created_at, info FROM peer').all();
      const now = Date.now();
      this.store.tx(() => {
        for (const row of rows) {
          const id = String(row.id ?? '').trim().slice(0, 100);
          if (!id) continue;
          const ip = cleanIp(parseJson(row.info, {})?.ip) || null;
          const created = parseSqliteDate(row.created_at) ?? now;
          this.store.run(
            `INSERT INTO devices (id, first_seen_at, registered_at, ip) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET registered_at = excluded.registered_at, ip = COALESCE(devices.ip, excluded.ip)`,
            id, created, created, ip,
          );
        }
      });
      this.status = { enabled: true, lastSync: now, peers: rows.length, error: null };
    } catch (err) {
      this.status = { ...this.status, error: err.message };
    } finally {
      db?.close();
    }
  }
}
