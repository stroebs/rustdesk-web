// Reconciles the connection log (from /api/audit/conn) with the connection IDs
// that devices report as open in each heartbeat. Both use the client's
// connection ID, so heartbeats tell us which logged sessions are really still
// open, and which open sessions were never logged at all (e.g. they started
// while the API server was unreachable and the client gave up retrying).

import { parseJson } from './util.js';

// A heartbeat built just before a connection opened can arrive after its "new"
// audit; don't treat a row as closed until it has had time to show up.
export const OPEN_GRACE_MS = 30 * 1000;

export function parseAlive(value) {
  const list = Array.isArray(value) ? value : parseJson(value, []);
  // Connection IDs are JSON integers; Number(null) === 0, so never coerce.
  return Array.isArray(list) ? [...new Set(list.filter(Number.isInteger))].slice(0, 1000) : [];
}

/** Apply a heartbeat's list of open connection IDs to the device's open log rows. */
export function reconcileHeartbeat(store, deviceId, alive, now = Date.now()) {
  const open = store.all('SELECT id, conn_id, started_at FROM conn_logs WHERE device_id = ? AND ended_at IS NULL', deviceId);
  for (const row of open) {
    if (alive.includes(row.conn_id)) {
      store.run('UPDATE conn_logs SET last_alive_at = ? WHERE id = ?', now, row.id);
    } else if (now - row.started_at > OPEN_GRACE_MS) {
      // The "close" audit never arrived: end it when it was last known to be open.
      store.run('UPDATE conn_logs SET ended_at = COALESCE(last_alive_at, started_at), end_inferred = 1 WHERE id = ?', row.id);
    }
  }
}

/** A log row is active only if its device is online and still reports that connection as open. */
export function isActive(row, deviceLastSeen, deviceAlive, onlineSince) {
  return row.ended_at == null && deviceLastSeen >= onlineSince && parseAlive(deviceAlive).includes(row.conn_id);
}

/** Open connections reported by online devices that have no open log row. */
export function unrecordedSessions(store, onlineSince) {
  const devices = store.all(
    "SELECT id, hostname, ip, alive_conns FROM devices WHERE last_seen_at >= ? AND alive_conns <> '[]'",
    onlineSince,
  );
  const out = [];
  for (const d of devices) {
    const alive = parseAlive(d.alive_conns);
    const logged = new Set(store.all('SELECT conn_id FROM conn_logs WHERE device_id = ? AND ended_at IS NULL', d.id).map((r) => r.conn_id));
    const count = alive.filter((id) => !logged.has(id)).length;
    if (count) out.push({ device_id: d.id, hostname: d.hostname, ip: d.ip ?? '', count });
  }
  return out;
}
