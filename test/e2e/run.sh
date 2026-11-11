#!/bin/sh
# End-to-end protocol test against a real RustDesk peer in Docker.
#   test/e2e/run.sh          bring up testbed/, run the session test, tear down
#   KEEP=1 test/e2e/run.sh   leave the testbed running afterwards
set -eu
cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f testbed/compose.yml"
NODE="node --disable-warning=ExperimentalWarning"

cleanup() { [ "${KEEP:-}" = 1 ] || $COMPOSE down -v >/dev/null 2>&1; }
trap cleanup EXIT

$COMPOSE up -d --build --quiet-pull hbbs hbbr peer rustdesk-web

# Ready when the peer answers a real session; "offline" just means it has not
# registered with hbbs yet.
for i in $(seq 1 60); do
  if out=$($NODE test/e2e/testbed-session.mjs 2>&1); then
    echo "$out"
    exit 0
  fi
  case "$out" in
    *"(offline)"*|*"(id_not_exist)"*|*"exec"*) sleep 2 ;;
    *) echo "$out"; $COMPOSE logs --tail 40 peer hbbs; exit 1 ;;
  esac
done
echo "peer never came online"; $COMPOSE logs --tail 60 peer hbbs; exit 1
