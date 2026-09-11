#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 VPS for Amazing Grace Reader.
# Run as the deploy user (not root) from a directory you can write to.
# Idempotent: safe to re-run.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-agr}"
APP_DIR="/opt/amazing-grace"
REPO_URL="${REPO_URL:-https://github.com/kilby8/Amazing-Grace-Book-Reader.git}"
REPO_BRANCH="${REPO_BRANCH:-feat/pdf-pocket-tts}"
NODE_MAJOR="${NODE_MAJOR:-22}"

say() { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mFATAL:\033[0m %s\n" "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] && die "Run as the deploy user, not root (sudo where needed)."

# 1. System packages + firewall
say "Installing system packages"
sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl git ufw fail2ban unzip ca-certificates rsync \
  build-essential python3

# 2. Firewall: only 22, 80, 443. Caddy handles 80/443.
say "Configuring UFW"
sudo ufw --force reset
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment "ssh"
sudo ufw allow 80/tcp comment "http -> caddy"
sudo ufw allow 443/tcp comment "https -> caddy"
sudo ufw --force enable

# 3. Caddy via the official repo
if ! command -v caddy >/dev/null; then
  say "Installing Caddy"
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

# 4. Node.js via NodeSource
if ! command -v node >/dev/null || [[ "$(node -p "process.versions.node.split('.')[0]")" != "$NODE_MAJOR" ]]; then
  say "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

# 5. Application directory
say "Setting up ${APP_DIR}"
sudo mkdir -p "$APP_DIR"
sudo chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# 6. Clone / update repo
if [[ -d "$APP_DIR/.git" ]]; then
  say "Updating existing checkout"
  cd "$APP_DIR"
  git fetch --quiet
  git reset --hard "origin/${REPO_BRANCH}"
else
  say "Cloning ${REPO_BRANCH}"
  git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# 7. Install dependencies
say "Installing npm dependencies"
cd "$APP_DIR/web"
npm ci --omit=dev --no-audit --no-fund

# 8. Data directory
say "Creating data directory"
mkdir -p "$APP_DIR/data/books"
chmod 700 "$APP_DIR/data"

# 9. Generate SESSION_SECRET if not already present
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  say "Generating .env with SESSION_SECRET"
  SESSION_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))")
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=8770
HOST=127.0.0.1
SESSION_SECRET=${SESSION_SECRET}
DATA_DIR=${APP_DIR}/data
ELEVENLABS_KEY_FILE=/etc/amazing-grace/elevenlabs_credentials.json
EOF
  chmod 600 "$ENV_FILE"
  say "Edit ${ENV_FILE} if you need to override anything."
fi

# 10. ElevenLabs credentials (system location, locked down)
if [[ -n "${ELEVENLABS_API_KEY:-}" ]]; then
  say "Writing ElevenLabs credentials from ELEVENLABS_API_KEY env var"
  sudo mkdir -p /etc/amazing-grace
  sudo tee /etc/amazing-grace/elevenlabs_credentials.json >/dev/null <<EOF
{
  "_comment": "ElevenLabs API key for the Amazing Grace Reader web app.",
  "api_key": "${ELEVENLABS_API_KEY}",
  "created_at": "$(date -Iseconds)"
}
EOF
  sudo chmod 600 /etc/amazing-grace/elevenlabs_credentials.json
  sudo chown root:www-data /etc/amazing-grace/elevenlabs_credentials.json 2>/dev/null \
    || sudo chown root:root /etc/amazing-grace/elevenlabs_credentials.json
elif [[ ! -f /etc/amazing-grace/elevenlabs_credentials.json ]]; then
  say "WARNING: no ElevenLabs key found. Create /etc/amazing-grace/elevenlabs_credentials.json or set ELEVENLABS_API_KEY in ${ENV_FILE} for the TTS proxy to work."
fi

# 11. systemd service
say "Installing systemd service"
sudo tee /etc/systemd/system/amazinggrace.service >/dev/null <<EOF
[Unit]
Description=Amazing Grace Reader web app
After=network.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=${APP_DIR}/web
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${APP_DIR}/data /etc/amazing-grace
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable amazinggrace
sudo systemctl restart amazinggrace

# 12. Caddy
say "Configuring Caddy"
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDYEOF'
# Replace YOUR.DOMAIN below before running, or set CADDY_DOMAIN.
YOUR.DOMAIN {
  encode zstd gzip

  # flush_interval -1 keeps the response unbuffered so streaming audio
  # from /api/tts lands in the browser as ElevenLabs emits it.
  reverse_proxy 127.0.0.1:8770 {
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto https
    flush_interval -1
  }

  log {
    output file /var/log/caddy/access.log {
      roll_size 100MiB
      roll_keep 10
    }
  }
}
CADDYEOF

if [[ -n "${CADDY_DOMAIN:-}" && "${CADDY_DOMAIN}" != "YOUR.DOMAIN" ]]; then
  sudo sed -i "s/YOUR.DOMAIN/${CADDY_DOMAIN}/g" /etc/caddy/Caddyfile
  sudo systemctl reload caddy
else
  say "WARNING: set CADDY_DOMAIN in env or edit /etc/caddy/Caddyfile, then run: sudo systemctl reload caddy"
fi

say "Done. Health check:"
curl -fsS http://127.0.0.1:8770/api/me || true
echo
say "Service status:"
sudo systemctl --no-pager status amazinggrace || true
