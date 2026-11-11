# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository instead. Include steps to reproduce and the version you tested.
You should get an acknowledgement within a few days.

## Security model

- Passwords are hashed with scrypt. Sessions and client tokens are random 256-bit
  values stored only as SHA-256 hashes.
- The console uses an `HttpOnly`, `SameSite=Strict` cookie, requires an
  `X-Requested-With` header on state-changing requests, and sends a strict
  Content-Security-Policy. The UI never renders server data as HTML.
- Failed sign-ins are rate-limited per IP and per IP and username.
- **Cloudflare Access sign-in** (optional) trusts only JWTs signed with RS256 by the
  configured team's published keys, with the exact issuer, a configured audience, a
  valid `exp`/`nbf`/`iat` (60 s skew) and a user e-mail. The algorithm is never taken
  from the token. Identities are linked to accounts by proving them (a valid token on
  the linking request) or by an administrator. Sessions opened this way require a
  matching valid token on every request.
- **Saved device passwords** are stored per administrator as `sha256(password + salt)`,
  the same form the RustDesk client keeps. It is enough to log in to that device (while
  its password is unchanged), so protect the data directory and its backups. The browser
  never receives it: the console computes the login answer for the device's challenge.
- `CF-Connecting-IP` and `X-Forwarded-For` can be forged by anyone who reaches the
  port directly. They are only used when enabled; restrict `CF-Connecting-IP` to your
  cloudflared host(s) with `CF_TRUSTED_PROXIES`, or keep the port private.
- **Unauthenticated endpoints.** `/api/heartbeat`, `/api/sysinfo` and `/api/audit/*`
  are called by RustDesk clients without credentials, which is how the protocol
  works. Anyone who can reach the API can submit device telemetry and audit
  entries. Treat that data as informational, and do not expose the API server
  more widely than your hbbs server.
- Always put the console behind HTTPS (a reverse proxy with `TRUST_PROXY=true`)
  when it is reachable over an untrusted network.
