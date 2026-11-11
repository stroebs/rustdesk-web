# Contributing

Thanks for helping out! A few ground rules keep this project easy to run and review.

## Principles

- **No runtime dependencies.** The server uses only Node.js built-ins
  (`node:http`, `node:sqlite`, `node:crypto`). If you need a dependency, open an
  issue first to discuss it.
- **No build step.** The UI is plain ES modules served as-is from `public/`.
- **Never use `innerHTML`.** Build DOM with the `h()` helper from
  `public/assets/lib/dom.js` so server data is always treated as text. The CSP
  also forbids inline scripts and styles.
- **Schema changes are append-only.** Add a new entry to `MIGRATIONS` in
  `src/store.js`. Never edit one that has already been released.

## Development

```bash
npm run dev          # restarts on changes; UI at http://localhost:21114
npm test             # node:test suite (client protocol, admin API, hbbs import)
```

Set `ADMIN_PASSWORD` the first time you start against an empty `DATA_DIR`, or copy
the generated password from the log.

## Layout

```
src/
  server.js          entry point
  app.js             HTTP server, routing, maintenance timers
  routes/client.js   API used by RustDesk clients (login, address book, heartbeat, audit)
  routes/admin.js    JSON API used by the web console (/api/admin/*)
  store.js           SQLite schema and migrations
  auth.js            password hashing, tokens, rate limiting
  hbbs.js            optional read-only import from hbbs's database
  cli.js             reset-password / create-admin / list-users
public/
  index.html, assets/app.js, assets/app.css
  assets/pages/*.js  one module per console page
test/                node:test suites
```

## Pull requests

- Add or update tests for behaviour changes, especially anything in
  `routes/client.js`, since RustDesk clients depend on exact response shapes.
- Keep commits focused. Describe what you tested and which RustDesk client
  version(s) you tested against.
