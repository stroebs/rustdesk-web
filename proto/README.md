# RustDesk protocol definitions

Copied unmodified from RustDesk so the browser client speaks the same protocol:

| File | Source | Commit |
|------|--------|--------|
| `rendezvous.proto` | [rustdesk/hbb_common](https://github.com/rustdesk/hbb_common/blob/bb416bc94e48fa73046017f8ce4214324146cebe/protos/rendezvous.proto) | `bb416bc94e48fa73046017f8ce4214324146cebe` |
| `message.proto` | [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk/blob/95cca3f661f635b3cc85c04935fe8d96d8f432ef/libs/base/protos/message.proto) | `95cca3f661f635b3cc85c04935fe8d96d8f432ef` |

Copyright © Purslane Ltd and RustDesk contributors, licensed under the
[GNU AGPL-3.0](https://github.com/rustdesk/rustdesk/blob/master/LICENCE).

`public/assets/client/schema.js` is generated from these files:

```bash
npm run gen-proto
```

When updating, copy the new files here, regenerate, and update the commits above.
