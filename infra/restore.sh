#!/usr/bin/env bash
# Restore Amazing Grace Reader data from a backup archive.
#
# Usage:  ./restore.sh /var/backups/amazing-grace/20260101T000000Z.tar.zst
#
# The script:
#   1. Stops the service
#   2. Moves the existing data dir aside (NOT deleted - you can recover)
#   3. Extracts the archive into the data dir
#   4. Restarts the service
#
# Restoring a SQLite snapshot also brings back the matching -wal / -shm files
# so the DB is consistent.
set -euo pipefail

ARCHIVE="${1:-}"
DATA_DIR="${DATA_DIR:-/opt/amazing-grace/data}"
APP_DIR="${APP_DIR:-/opt/amazing-grace}"
SERVICE="${SERVICE:-amazinggrace}"

say() { printf "\033[1;34m[restore]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mFATAL:\033[0m %s\n" "$*" >&2; exit 1; }

[[ -n "$ARCHIVE" ]] || die "usage: $0 <archive.tar.zst>"
[[ -f "$ARCHIVE" ]] || die "archive $ARCHIVE not found"
[[ -d "$DATA_DIR" ]] || die "data dir $DATA_DIR not found"

say "Stopping service"
sudo systemctl stop "$SERVICE" || true

# Move the existing data dir aside
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
QUARANTINE="${APP_DIR}/data.${STAMP}.quarantine"
say "Moving existing data to $QUARANTINE"
sudo mv "$DATA_DIR" "$QUARANTINE"

say "Creating fresh data dir"
sudo mkdir -p "$DATA_DIR/books"
sudo chown -R "$(stat -c '%U:%G' "$QUARANTINE")" "$DATA_DIR"

say "Extracting archive"
# Archives produced by backup.sh include data/books/ at the top of the tar.
# Extract them into $APP_DIR so $DATA_DIR/books/* lands in place.
sudo tar --use-compress-program=zstd -xf "$ARCHIVE" -C "$APP_DIR"
# Move the snapshot files into the live DB location
if [[ -f "${APP_DIR}/library.snapshot."*.db ]]; then
  SHOT=$(ls "${APP_DIR}"/library.snapshot.*.db | head -1)
  sudo mv "$SHOT" "$DATA_DIR/library.db"
  sudo mv "${SHOT}-wal" "$DATA_DIR/library.db-wal" 2>/dev/null || true
  sudo mv "${SHOT}-shm" "$DATA_DIR/library.db-shm" 2>/dev/null || true
fi
sudo chown -R "$(stat -c '%U:%G' "$QUARANTINE")" "$DATA_DIR"

say "Restarting service"
sudo systemctl start "$SERVICE"

say "Health check:"
sleep 2
curl -fsS http://127.0.0.1:8770/api/me || true
echo
say "Old data lives at: $QUARANTINE (delete once you verify the restore)"
