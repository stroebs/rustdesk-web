#!/usr/bin/env node
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { explainOpenError, prepareDataDir } from './datadir.js';

const config = loadConfig();

let app;
let admin;
try {
  prepareDataDir(config.dbPath);
  app = createApp(config);
  admin = await app.bootstrap();
} catch (err) {
  const hint = explainOpenError(err, config.dbPath);
  if (!hint) throw err;
  console.error(hint);
  process.exit(1);
}

if (admin) {
  const line = '='.repeat(64);
  console.log(`\n${line}\n Created initial administrator account`);
  console.log(`   username: ${admin.username}`);
  if (admin.generated) console.log(`   password: ${admin.password}\n   (generated; set ADMIN_PASSWORD to choose one. Change it after signing in.)`);
  else console.log('   password: (from ADMIN_PASSWORD)');
  console.log(`${line}\n`);
}

const address = await app.listen();
console.log(`rustdesk-web ${app.version} listening on ${app.protocol}://${address.address}:${address.port}`);
console.log(`database: ${config.dbPath}`);
if (config.hbbsDbPath) {
  const s = app.hbbs.status;
  console.log(s.error ? `hbbs sync failed: ${s.error}` : `hbbs sync: ${s.peers} peers from ${config.hbbsDbPath}`);
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  });
}
