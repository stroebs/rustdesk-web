# Contributing

Thanks for helping out! A few ground rules keep this project easy to run and review.

## Principles

- **No runtime dependencies.** The server uses only Node.js built-ins
  (`node:http`, `node:sqlite`, `node:crypto`). The only third-party code is the
  vendored tweetnacl-js. If you need a dependency, open an issue first.
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
  wsgateway.js       /ws/id and /ws/relay proxy for browser sessions
public/
  index.html, assets/app.js, assets/app.css
  assets/pages/*.js  one module per console page
  assets/client/     browser RustDesk client: session (protocol), protobuf runtime,
                     generated schema, crypto helpers, video decoding, input mapping
  assets/vendor/     tweetnacl-js (unmodified, see the file header)
proto/               RustDesk protocol definitions (AGPL-3.0, see proto/README.md)
tools/gen-proto.mjs  generates assets/client/schema.js from proto/
testbed/             Docker environment with a real RustDesk peer
test/                node:test suites; test/e2e/ runs against testbed/
```

### Browser client

The client in `public/assets/client/` implements RustDesk's protocol for the relay-only
path a browser can use. When changing it, run `npm run e2e`: it connects to a real RustDesk
peer through hbbs/hbbr and checks login and video. Keep the code runnable in Node.js (no
DOM in `session.js`, `protobuf.js` or the crypto modules) so it stays testable.

## Pull requests

- Add or update tests for behaviour changes, especially anything in
  `routes/client.js`, since RustDesk clients depend on exact response shapes.
- Keep commits focused. Describe what you tested and which RustDesk client
  version(s) you tested against.

## Releasing

1. Bump `version` in `package.json` and merge that to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The [Release workflow](.github/workflows/release.yml) checks that the tag matches
`package.json`, runs the tests, publishes `stroebs/rustdesk-web` to Docker Hub for
`linux/amd64` and `linux/arm64` (as `0.2.0`, `0.2` and `latest`), then smoke-tests
both images. Pre-release tags such as `v0.3.0-rc.1` don't move `latest`.

It needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
