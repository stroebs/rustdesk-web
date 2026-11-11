#!/bin/sh
# Configure and start a RustDesk peer with a fixed ID and password, pointed at
# the testbed's hbbs/hbbr. Environment: PEER_ID, PEER_PASSWORD, KEY_FILE.
set -eu

: "${PEER_ID:=123456789}"
: "${PEER_PASSWORD:=testbed-password}"
: "${KEY_FILE:=/keys/id_ed25519.pub}"

echo "waiting for hbbs key at $KEY_FILE"
while [ ! -s "$KEY_FILE" ]; do sleep 1; done
KEY=$(cat "$KEY_FILE")

CONF="$HOME/.config/rustdesk"
mkdir -p "$CONF"
cat > "$CONF/RustDesk.toml" <<EOF
id = '$PEER_ID'
password = '$PEER_PASSWORD'
EOF
cat > "$CONF/RustDesk2.toml" <<EOF
rendezvous_server = 'hbbs:21116'
nat_type = 2
serial = 0

[options]
custom-rendezvous-server = 'hbbs'
relay-server = 'hbbr'
api-server = '${API_SERVER:-http://rustdesk-web:21114}'
key = '$KEY'
verification-method = 'use-permanent-password'
approve-mode = 'password'
EOF

export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
sleep 1
# Something recognisable to look at: a clock and a terminal.
xclock -geometry 300x300+40+40 -update 1 &
xterm -geometry 100x30+400+60 -e sh -c 'echo "rustdesk-web testbed peer $PEER_ID"; exec sh' &

echo "starting rustdesk server as $PEER_ID"
exec rustdesk --server
