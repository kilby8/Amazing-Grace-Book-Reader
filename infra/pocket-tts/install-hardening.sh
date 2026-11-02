#!/usr/bin/env bash
# Install the hardened Pocket TTS server and the 2-minute health check on
# the voice server VM, with automatic rollback if the new server fails.
#
#   ssh ubuntu@<vm> 'curl -fsSL https://raw.githubusercontent.com/kilby8/Amazing-Grace-Book-Reader/fix/reader-keeps-playing/infra/pocket-tts/install-hardening.sh | bash'
set -euo pipefail
BRANCH="${BRANCH:-fix/reader-keeps-playing}"
RAW="https://raw.githubusercontent.com/kilby8/Amazing-Grace-Book-Reader/$BRANCH/infra/pocket-tts"
DIR=/opt/pocket-tts
STAMP=$(date +%Y%m%d-%H%M%S)

wait_healthy() {
  for _ in $(seq 1 60); do
    curl -fsS --max-time 5 http://127.0.0.1:8765/health >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

echo "== before =="
systemctl is-active pocket-tts || true
sudo journalctl -u pocket-tts -n 30 --no-pager | tail -30 || true

echo "== downloading =="
tmp=$(mktemp -d)
for f in serve_local.py pocket-tts-healthcheck.service pocket-tts-healthcheck.timer; do
  curl -fsSL "$RAW/$f" -o "$tmp/$f"
done
"$DIR/venv/bin/python" -m py_compile "$tmp/serve_local.py"

echo "== installing (backup: $DIR/serve_local.py.bak-$STAMP) =="
sudo cp "$DIR/serve_local.py" "$DIR/serve_local.py.bak-$STAMP"
sudo cp "$tmp/serve_local.py" "$DIR/serve_local.py"
sudo chown ubuntu:ubuntu "$DIR/serve_local.py"
sudo systemctl restart pocket-tts

if wait_healthy && curl -fsS --max-time 90 -o /tmp/pocket-test.wav -F text='Hello, this is a test of the reading voice.' http://127.0.0.1:8765/tts; then
  echo "new server OK ($(stat -c %s /tmp/pocket-test.wav) bytes of test audio)"
else
  echo "!! new server failed; rolling back"
  sudo cp "$DIR/serve_local.py.bak-$STAMP" "$DIR/serve_local.py"
  sudo systemctl restart pocket-tts
  wait_healthy && echo "old server restored and answering" || echo "!! old server not answering either; check: sudo journalctl -u pocket-tts -n 80"
  exit 1
fi

echo "== health check every 2 minutes, restarts the server if it stops answering =="
sudo cp "$tmp/pocket-tts-healthcheck.service" "$tmp/pocket-tts-healthcheck.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pocket-tts-healthcheck.timer
systemctl list-timers pocket-tts-healthcheck.timer --no-pager | head -3
echo "== done =="
