import path from 'node:path';

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env, overrides = {}) {
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 21114),
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'rustdesk-web.sqlite3'),
    publicDir: path.resolve(import.meta.dirname, '../public'),

    // Initial administrator, created only when the database has no users.
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',

    // Set when running behind exactly one reverse proxy that sets X-Forwarded-For/-Proto.
    trustProxy: bool(env.TRUST_PROXY, false),
    // "auto" marks the cookie Secure when the request arrived over HTTPS.
    cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),

    // Optional integration with a local hbbs instance.
    hbbsDbPath: env.HBBS_DB_PATH || '',
    hbbsKeyFile: env.HBBS_KEY_FILE || '',
    hbbsSyncSeconds: int(env.HBBS_SYNC_SECONDS, 60),

    // Defaults for the client configuration shown in the UI (overridable in Settings).
    idServer: env.ID_SERVER || '',
    relayServer: env.RELAY_SERVER || '',
    apiServer: env.API_SERVER || '',
    serverKey: env.SERVER_KEY || '',

    onlineThresholdSeconds: int(env.ONLINE_THRESHOLD_SECONDS, 60),
    clientTokenTtlDays: int(env.CLIENT_TOKEN_TTL_DAYS, 30),
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    logRetentionDays: int(env.LOG_RETENTION_DAYS, 180),
    ...overrides,
  };
}
