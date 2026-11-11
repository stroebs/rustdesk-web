/**
 * Effective client configuration (ID/relay/API server and public key).
 * Precedence: value saved in Settings > environment variable > hbbs key file.
 */
export function effectiveServerConfig(app) {
  const { store, config, hbbs } = app;
  const pick = (key, envValue) => store.getSetting(key) || envValue || '';
  const savedKey = store.getSetting('key');
  const fileKey = hbbs.readKey();
  const key = savedKey || config.serverKey || fileKey;
  return {
    id_server: pick('id_server', config.idServer),
    relay_server: pick('relay_server', config.relayServer),
    api_server: pick('api_server', config.apiServer),
    key,
    key_source: savedKey ? 'settings' : config.serverKey ? 'env' : fileKey ? 'file' : '',
  };
}

/**
 * Encode the configuration string accepted by RustDesk's
 * "Settings > Network > ID/Relay server > Import server config":
 * base64url(JSON) with padding, then reversed.
 */
export function encodeConfigString({ id_server, relay_server, api_server, key }) {
  const json = JSON.stringify({ host: id_server, relay: relay_server, api: api_server, key });
  let b64 = Buffer.from(json, 'utf8').toString('base64url');
  while (b64.length % 4) b64 += '=';
  return [...b64].reverse().join('');
}

export function decodeConfigString(text) {
  const b64 = [...String(text).trim()].reverse().join('');
  const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  return { id_server: json.host ?? '', relay_server: json.relay ?? '', api_server: json.api ?? '', key: json.key ?? '' };
}

/** Windows installer file name that embeds the configuration. */
export function installerName({ id_server, relay_server, api_server, key }) {
  if (!id_server) return '';
  const parts = [`host=${id_server}`];
  if (key) parts.push(`key=${key}`);
  if (api_server) parts.push(`api=${api_server}`);
  if (relay_server) parts.push(`relay=${relay_server}`);
  return `rustdesk-${parts.join(',')}.exe`;
}
