import fs from 'node:fs';
import path from 'node:path';

function parseId(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Make the database directory usable before the database is opened.
 *
 * When started as root with PUID set (the Docker image sets PUID=1000/PGID=1000),
 * take ownership of the data directory and the database files, then permanently
 * drop to PUID/PGID. This makes bind mounts that Docker created as root:root work,
 * and keeps `docker exec ... cli.js` from leaving root-owned WAL files behind.
 * Outside that case nothing is changed.
 */
export function prepareDataDir(dbPath, env = process.env) {
  const dir = path.dirname(dbPath);
  const puid = parseId(env.PUID);
  const pgid = parseId(env.PGID) ?? puid;

  if (process.getuid?.() === 0 && puid !== null && puid !== 0) {
    fs.mkdirSync(dir, { recursive: true });
    const base = path.basename(dbPath);
    const targets = [dir, ...fs.readdirSync(dir).filter((f) => f.startsWith(base)).map((f) => path.join(dir, f))];
    for (const target of targets) {
      const stat = fs.statSync(target);
      if (stat.uid !== puid || stat.gid !== pgid) fs.chownSync(target, puid, pgid);
    }
    process.setgroups([pgid]);
    process.setgid(pgid);
    process.setuid(puid);
  }
}

/** Explain the usual causes when SQLite cannot open or write the database. */
export function explainOpenError(err, dbPath) {
  // Primary result codes: 14 = SQLITE_CANTOPEN, 8 = SQLITE_READONLY (extended codes share the low byte).
  const primary = (err?.errcode ?? 0) & 0xff;
  if (err?.code !== 'ERR_SQLITE_ERROR' || (primary !== 14 && primary !== 8)) return null;
  const dir = path.dirname(dbPath);
  let owner = 'unknown';
  try {
    const stat = fs.statSync(dir);
    owner = `${stat.uid}:${stat.gid}`;
  } catch {
    owner = 'does not exist';
  }
  const me = process.getuid ? `${process.getuid()}:${process.getgid()}` : 'unknown';
  return [
    `Cannot open the database at ${dbPath}: ${err.message}.`,
    `The process runs as ${me}, and ${dir} is owned by ${owner}.`,
    'Fix one of:',
    `  - make the directory writable for ${me}, e.g. on the host: sudo chown -R ${me} <your data directory>`,
    '  - in Docker, do not override the container user (--user / user:), so the image can fix ownership itself',
    '  - in Docker, set PUID/PGID to the owner of your data directory',
  ].join('\n');
}
