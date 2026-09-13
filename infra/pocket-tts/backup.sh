#!/usr/bin/env bash
# Snapshot the pocket-tts install (venv + model cache) to a restic repo.
# Skips cleanly with a syslog note when B2 creds aren't configured yet,
# so the daily timer can be enabled before creds arrive without errors.
#
# Required env vars (set in /opt/amazing-grace/.env and loaded by the timer):
#   B2_ACCOUNT_ID       Backblaze B2 account ID
#   B2_ACCOUNT_KEY      Backblaze B2 application key
#   RESTIC_PASSWORD     Encryption password for the restic repo
#
# Optional:
#   RESTIC_REPO         Override repo URL (default: b2:<bucket>:pocket-tts-vm)

set -euo pipefail
ENV_FILE=/opt/amazing-grace/.env
LOG_TAG="pocket-tts-backup"

# Load env if present
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE" || true
  set +a
fi

if [[ -z "${B2_ACCOUNT_ID:-}" || -z "${B2_ACCOUNT_KEY:-}" || -z "${RESTIC_PASSWORD:-}" ]]; then
  logger -t "$LOG_TAG" "B2 / restic creds not configured yet; skipping (set B2_ACCOUNT_ID, B2_ACCOUNT_KEY, RESTIC_PASSWORD in $ENV_FILE to enable)"
  exit 0
fi

REPO="${RESTIC_REPO:-b2:pocket-tts-backup:pocket-tts-vm}"
export AWS_ACCESS_KEY_ID="$B2_ACCOUNT_ID"
export AWS_SECRET_ACCESS_KEY="$B2_ACCOUNT_KEY"
export RESTIC_REPOSITORY="$REPO"
export RESTIC_PASSWORD

logger -t "$LOG_TAG" "starting backup -> $REPO"

# Back up: venv (everything pocket-tts needs) + model cache + this script.
# Exclude __pycache__ and pip cache to keep the snapshot small.
restic -q backup \
  --tag pocket-tts,vm \
  --exclude-caches \
  --exclude='/opt/pocket-tts/venv/**/__pycache__' \
  --exclude='/opt/pocket-tts/venv/**/*.pyc' \
  /opt/pocket-tts/venv \
  /home/ubuntu/.cache/huggingface \
  /etc/systemd/system/pocket-tts.service \
  /etc/systemd/system/pocket-tts-healthcheck.{service,timer} \
  /etc/systemd/system/pocket-tts-backup.{service,timer} \
  /opt/pocket-tts/backup.sh

# Prune to keep the repo small (cheap on B2 free tier).
restic -q forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

logger -t "$LOG_TAG" "backup complete"
