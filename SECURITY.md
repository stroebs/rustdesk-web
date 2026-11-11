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
- **Unauthenticated endpoints.** `/api/heartbeat`, `/api/sysinfo` and `/api/audit/*`
  are called by RustDesk clients without credentials, which is how the protocol
  works. Anyone who can reach the API can submit device telemetry and audit
  entries. Treat that data as informational, and do not expose the API server
  more widely than your hbbs server.
- Always put the console behind HTTPS (a reverse proxy with `TRUST_PROXY=true`)
  when it is reachable over an untrusted network.
