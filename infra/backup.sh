#!/usr/bin/env bash
# Back up the Amazing Grace Reader data directory.
#
# What gets backed up:
#   - SQLite database (library.db + WAL/SHM)
#   - Per-user book blobs (data/books/<id>/<filename>)
#
# Where it goes:
#   - Local:    /var/backups/amazing-grace/<timestamp>.tar.zst (30 days kept)
#   - Optional: restic to Backblaze B2 / S3 / any restic backend (see RESTIC_REPO)
#
# Run nightly via /etc/cron.d/amazinggrace-backup. Idempotent.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/opt/amazing-grace/data}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/amazing-grace}"
KEEP_LOCAL="${KEEP_LOCAL:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/${TS}.tar.zst"

say() { printf "\033[1;34m[backup]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mFATAL:\033[0m %s\n" "$*" >&2; exit 1; }

[[ -d "$DATA_DIR" ]] || die "data dir $DATA_DIR does not exist"
command -v zstd >/dev/null || sudo apt-get install -y -qq zstd
mkdir -p "$BACKUP_DIR"

# Consistent snapshot: SQLite WAL might be mid-write. sqlite3 .backup is
# the safe way - it produces a clean snapshot without locking readers out.
if command -v sqlite3 >/dev/null; then
  SNAP_DB="${BACKUP_DIR}/library.snapshot.${TS}.db"
  say "Snapshotting SQLite via sqlite3 .backup"
  sqlite3 "$DATA_DIR/library.db" ".timeout 5000" ".backup '$SNAP_DB'"
  cp -p "$DATA_DIR/library.db-wal" "$BACKUP_DIR/library.snapshot.${TS}.db-wal" 2>/dev/null || true
  cp -p "$DATA_DIR/library.db-shm" "$BACKUP_DIR/library.snapshot.${TS}.db-shm" 2>/dev/null || true
  # Tar only the snapshot, not the live DB files
  tar --use-compress-program=zstd -cf "$ARCHIVE" -C "$DATA_DIR/.." "$(basename "$DATA_DIR")/books" -C "$BACKUP_DIR" "library.snapshot.${TS}.db" "library.snapshot.${TS}.db-wal" "library.snapshot.${TS}.db-shm"
  rm -f "$SNAP_DB" "${SNAP_DB}-wal" "${SNAP_DB}-shm"
else
  say "sqlite3 CLI not found; falling back to a checkpoint+tar"
  # Without sqlite3, force a WAL checkpoint so the main DB file is consistent.
  # The app doesn't expose a checkpoint endpoint, so we just rely on the WAL
  # being merged periodically. Acceptable for a personal-scale library.
  tar --use-compress-program=zstd -cf "$ARCHIVE" -C "$DATA_DIR/.." "$(basename "$DATA_DIR")"
fi

say "wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# Local retention
say "pruning local backups older than ${KEEP_LOCAL} days"
find "$BACKUP_DIR" -maxdepth 1 -name "*.tar.zst" -mtime "+${KEEP_LOCAL}" -delete

# Optional: restic to remote
if [[ -n "${RESTIC_REPO:-}" ]]; then
  say "pushing to restic repo: $RESTIC_REPO"
  if [[ -n "${RESTIC_PASSWORD_FILE:-}" && -f "${RESTIC_PASSWORD_FILE}" ]]; then
    RESTIC_PASSWORD_FILE_VAL="--password-file ${RESTIC_PASSWORD_FILE}"
  else
    RESTIC_PASSWORD_FILE_VAL=""
  fi
  # Restic on the archive file (one snapshot per backup run, easy to prune)
  restic $RESTIC_PASSWORD_FILE_VAL -r "$RESTIC_REPO" backup "$ARCHIVE" --tag amazinggrace
  restic $RESTIC_PASSWORD_FILE_VAL -r "$RESTIC_REPO" forget --tag amazinggrace --keep-daily 14 --keep-weekly 8 --keep-monthly 6 --prune
fi
