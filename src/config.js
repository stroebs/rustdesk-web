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
    // Serve HTTPS directly (PEM files). Browsers only decode remote-session video over HTTPS.
    tlsCertFile: env.TLS_CERT_FILE || '',
    tlsKeyFile: env.TLS_KEY_FILE || '',
    dataDir,
    dbPath: env.DB_PATH || path.join(dataDir, 'rustdesk-web.sqlite3'),
    publicDir: path.resolve(import.meta.dirname, '../public'),
    // Shown in the UI as required by the AGPL; point it at your fork if you modify the code.
    sourceUrl: env.SOURCE_URL || 'https://github.com/stroebs/rustdesk-web',

    // Initial administrator, created only when the database has no users.
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',

    // Set when running behind exactly one reverse proxy that sets X-Forwarded-For/-Proto.
    trustProxy: bool(env.TRUST_PROXY, false),
    // "auto" marks the cookie Secure when the request arrived over HTTPS.
    cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),

    // Cloudflare Zero Trust (Access). Each can be overridden in Settings.
    cfEnabled: env.CF_ACCESS_ENABLED ?? '',
    cfTeamDomain: env.CF_ACCESS_TEAM_DOMAIN || '',
    cfAudience: env.CF_ACCESS_AUD || '',
    cfAutoLogin: env.CF_ACCESS_AUTO_LOGIN ?? '',
    // Take client addresses from CF-Connecting-IP (only from CF_TRUSTED_PROXIES, if set).
    cfClientIp: env.CF_CLIENT_IP ?? '',
    cfTrustedProxies: env.CF_TRUSTED_PROXIES || '',

    // Optional integration with a local hbbs instance.
    hbbsDbPath: env.HBBS_DB_PATH || '',
    hbbsKeyFile: env.HBBS_KEY_FILE || '',
    hbbsSyncSeconds: int(env.HBBS_SYNC_SECONDS, 60),

    // WebSocket endpoints the browser client is proxied to (default: ID/relay server, ports 21118/21119).
    hbbsWsUrl: env.HBBS_WS_URL || '',
    hbbrWsUrl: env.HBBR_WS_URL || '',

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
