#!/usr/bin/env node
// Administrative commands that operate directly on the database.
//   rustdesk-web reset-password <username> [password]
//   rustdesk-web create-admin <username> [password]
//   rustdesk-web list-users
import { hashPassword, randomPassword, validatePassword } from './auth.js';
import { loadConfig } from './config.js';
import { encodeConfigString } from './serverconfig.js';
import { Store } from './store.js';

const [command, username, givenPassword] = process.argv.slice(2);
const config = loadConfig();

function usage() {
  console.log(`Usage:
  rustdesk-web reset-password <username> [password]   Set a new password (generated if omitted)
  rustdesk-web create-admin <username> [password]     Create an administrator, or promote an existing user
  rustdesk-web list-users                             List all accounts
  rustdesk-web config-string <host> [key] [api] [relay]   Print an importable client config string

Uses DB_PATH / DATA_DIR from the environment (current: ${config.dbPath}).`);
  process.exit(command ? 1 : 0);
}

async function newPassword() {
  const password = givenPassword || randomPassword();
  const problem = validatePassword(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  return { password, hash: await hashPassword(password) };
}

if (command === 'config-string') {
  const [, host = '', key = '', api = '', relay = ''] = process.argv.slice(2);
  if (!host) usage();
  console.log(encodeConfigString({ id_server: host, key, api_server: api, relay_server: relay }));
  process.exit(0);
}

if (!['reset-password', 'create-admin', 'list-users'].includes(command)) usage();

const store = new Store(config.dbPath);
const now = Date.now();

try {
  if (command === 'list-users') {
    const rows = store.all('SELECT id, username, email, is_admin, status FROM users ORDER BY username');
    for (const u of rows) {
      console.log(`${String(u.id).padStart(4)}  ${u.username.padEnd(24)} ${u.is_admin ? 'admin' : 'user '} ${u.status === 1 ? 'active  ' : 'disabled'} ${u.email}`);
    }
    if (!rows.length) console.log('No users yet. Start the server to create the initial administrator.');
  } else {
    if (!username) usage();
    const user = store.get('SELECT * FROM users WHERE username = ?', username);
    if (command === 'reset-password') {
      if (!user) throw new Error(`No user named "${username}"`);
      const { password, hash } = await newPassword();
      store.tx(() => {
        store.run('UPDATE users SET password_hash = ?, status = 1, updated_at = ? WHERE id = ?', hash, now, user.id);
        store.run('DELETE FROM tokens WHERE user_id = ?', user.id);
      });
      console.log(`Password for "${user.username}" reset${givenPassword ? '.' : `: ${password}`}`);
    } else if (user) {
      store.run('UPDATE users SET is_admin = 1, status = 1, updated_at = ? WHERE id = ?', now, user.id);
      console.log(`"${user.username}" is now an active administrator.`);
    } else {
      const { password, hash } = await newPassword();
      store.run(
        'INSERT INTO users (username, password_hash, is_admin, status, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)',
        username, hash, now, now,
      );
      console.log(`Created administrator "${username}"${givenPassword ? '.' : ` with password: ${password}`}`);
    }
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  store.close();
}
