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
# One 2560x720 screen split into two 1280x720 monitors (RandR), so the peer has
# two displays to switch between.
# -noreset: otherwise Xvfb resets (dropping the monitors below) when its last client exits.
Xvfb :99 -screen 0 2560x720x24 +extension RANDR -noreset -nolisten tcp &
until xrandr -q >/dev/null 2>&1; do sleep 0.2; done
# LEFT takes over the output's own monitor (otherwise a third, full-width one remains).
xrandr --setmonitor LEFT 1280/338x720/190+0+0 screen >/dev/null
xrandr --setmonitor RIGHT 1280/338x720/190+1280+0 none >/dev/null
xrandr --listmonitors
# Something recognisable on each: a clock and a terminal on the left, a big clock on the right.
xclock -geometry 300x300+40+40 -update 1 &
xterm -geometry 100x30+400+60 -e sh -c 'echo "rustdesk-web testbed peer $PEER_ID"; exec sh' &
xclock -analog -geometry 600x600+1620+60 -update 1 &

echo "starting rustdesk server as $PEER_ID"
exec rustdesk --server
