# Deploying Amazing Grace Reader to a public VPS

This is the recipe for running the web app on a single Ubuntu 24.04 VPS with
HTTPS via Caddy. It's tuned for personal use — single operator, a handful of
trusted users, no scaling concerns.

## What this gets you

- `https://reader.your-domain.com` serving the SPA + API
- Auto-renewed TLS via Let's Encrypt (Caddy handles it)
- Per-user login, library, uploads, ElevenLabs TTS
- Daily backups to `/var/backups/amazing-grace/` (30 days kept locally)
- Optional remote backups via restic (Backblaze B2, S3, rsync.net, …)
- systemd service that auto-restarts on crash and starts on boot
- UFW firewall only allowing 22 / 80 / 443
- Session cookies marked Secure (HTTPS-only)

## What this does NOT get you

- Multi-node scaling (single-process; if you need >1 worker swap
  `MemoryStore` → SQLite/Redis sessions)
- DDOS protection beyond the OS firewall (Cloudflare in front if needed)
- A fancy monitoring stack (journald + curl is enough for one box)
- Auto-failover (snapshot + restore on a fresh VPS takes ~10 min)

## Costs

| Item | $/month | Notes |
|---|---|---|
| Hetzner CX22 (Ashburn VA) | €3.79 | 2 vCPU / 4 GB / 40 GB SSD |
| Domain (e.g. `reader.example.com`) | ~$10/yr | Cloudflare Registrar at-cost |
| Backblaze B2 (optional) | $0 (free up to 10 GB) | restic remote backup |
| **Total** | **~$4/mo + domain** | |

## Step-by-step

### 1. Buy the domain

Pick a registrar (Cloudflare Registrar is at-cost and includes free DNS).
Buy something like `reader.your-domain.com` or `books.your-domain.com`.
You'll point it at the VPS IP in step 4.

### 2. Provision the VPS

Sign up at Hetzner Cloud (or DigitalOcean, Vultr, etc.), create a CX22
(or equivalent) in the region closest to you, with **Ubuntu 24.04**.
Set the SSH key you'll use to log in. Capture the public IPv4 address
when the box comes up.

### 3. Point DNS at the VPS

In your registrar's DNS panel, add an `A` record:

```
reader.your-domain.com.   A   <vps-ipv4>
```

Wait a couple minutes for it to propagate. Caddy will refuse to issue a
TLS cert until the A record resolves, so doing this before step 5 saves
a round trip.

### 4. First-time box setup (as the deploy user)

SSH in as your user (the one whose SSH key you uploaded):

```bash
ssh your-user@<vps-ipv4>

# Install git + sudo
sudo apt-get update -qq && sudo apt-get install -y -qq git sudo

# Clone the repo (or upload infra/ via scp if you prefer)
git clone --branch feat/pdf-pocket-tts --depth 1 \
  https://github.com/kilby8/Amazing-Grace-Book-Reader.git
cd Amazing-Grace-Book-Reader
```

### 5. Run the provisioner

```bash
CADDY_DOMAIN=reader.your-domain.com \
ELEVENLABS_API_KEY=sk_your-key-if-you-have-one \
  bash infra/setup.sh
```

The script does all of the following, in order:

1. Installs system packages and Node.js 22.
2. Configures UFW (only 22, 80, 443).
3. Installs Caddy from the official repo.
4. Clones (or updates) the repo at `/opt/amazing-grace`.
5. Runs `npm ci --omit=dev` in `web/`.
6. Creates `/opt/amazing-grace/data/` with mode 700.
7. Generates a random `SESSION_SECRET` and writes `/opt/amazing-grace/.env`.
8. If `ELEVENLABS_API_KEY` was passed, writes it to
   `/etc/amazing-grace/elevenlabs_credentials.json` (root-owned, mode 600).
9. Installs the systemd unit and starts the service.
10. Writes `/etc/caddy/Caddyfile` with your domain and reloads Caddy.

Caddy will obtain a Let's Encrypt cert on first request. The browser will
show a valid HTTPS lock within a few seconds.

### 6. Verify

From anywhere:

```bash
curl -fsSL https://reader.your-domain.com/api/me
# {"user":null}

# Sign up
curl -fsS -c cookies.txt -X POST https://reader.your-domain.com/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"you","password":"a-strong-password"}'
```

Then open the URL in a browser and sign in.

### 7. Backups

The nightly backup is opt-in. Install the cron:

```bash
sudo cp /opt/amazing-grace/infra/amazinggrace-backup.cron /etc/cron.d/amazinggrace-backup
sudo systemctl restart cron
```

Backups land in `/var/backups/amazing-grace/<timestamp>.tar.zst` and are
kept for 30 days.

**Optional — push to Backblaze B2 (or S3, rsync.net, …):**

```bash
# Install restic
sudo apt-get install -y -qq restic

# Initialize the repo (one-time)
export RESTIC_REPO=b2:your-bucket-name:amazinggrace
export B2_ACCOUNT_ID=...
export B2_ACCOUNT_KEY=...
restic init

# Add to /opt/amazing-grace/infra/backup.sh's environment (via .env or
# /etc/default/amazinggrace), e.g.:
#   RESTIC_REPO=b2:your-bucket-name:amazinggrace
#   RESTIC_PASSWORD_FILE=/etc/amazing-grace/restic-password
#   echo '<long-random-string>' > /etc/amazing-grace/restic-password
#   chmod 600 /etc/amazing-grace/restic-password
```

The `backup.sh` script will pick those up automatically and run `restic
backup` after the local tar.

### 8. Restore from backup

```bash
sudo bash /opt/amazing-grace/infra/restore.sh \
  /var/backups/amazing-grace/20260101T000000Z.tar.zst
```

Stops the service, moves the current data dir to `data.<timestamp>.quarantine/`,
extracts the archive, restarts. Verify the restored site, then
`rm -rf /opt/amazing-grace/data.<timestamp>.quarantine`.

### 9. Updates

```bash
ssh your-user@<vps-ipv4>
cd /opt/amazing-grace
git pull --ff-only
(cd web && npm ci --omit=dev --no-audit --no-fund)
sudo systemctl restart amazinggrace
```

No migration step — the schema is forward-compatible.

## File layout after provisioning

```
/opt/amazing-grace/
├── .env                          # generated, mode 600
├── data/                         # mode 700
│   ├── library.db
│   ├── library.db-wal
│   ├── library.db-shm
│   └── books/<user-id>/<filename>
├── web/                          # the cloned repo
│   ├── server.js
│   ├── app.js
│   └── ...
└── infra/
    ├── setup.sh
    ├── Caddyfile                 # installed to /etc/caddy/Caddyfile
    ├── backup.sh
    ├── restore.sh
    ├── env.example
    └── amazinggrace-backup.cron

/etc/amazing-grace/
└── elevenlabs_credentials.json  # mode 600, root-owned

/etc/systemd/system/
└── amazinggrace.service

/etc/caddy/
└── Caddyfile

/var/log/caddy/
└── access.log
```

## Operational cheatsheet

```bash
# Service logs (last 5 min)
sudo journalctl -u amazinggrace --since "5 min ago"

# Tail Caddy access logs
sudo tail -f /var/log/caddy/access.log

# Restart after config change
sudo systemctl restart amazinggrace

# Reissue cert manually if you change domains
sudo systemctl reload caddy

# Disk usage
du -sh /opt/amazing-grace/data /var/backups/amazing-grace

# Active users
sqlite3 /opt/amazing-grace/data/library.db \
  'SELECT username, datetime(created_at/1000, "unixepoch") FROM users;'

# Active books per user
sqlite3 /opt/amazing-grace/data/library.db \
  'SELECT u.username, COUNT(b.id), SUM(b.size) FROM users u LEFT JOIN books b ON b.user_id=u.id GROUP BY u.id;'
```

## Security checklist (after first deploy)

- [ ] SESSION_SECRET is set (auto-generated by setup.sh — verify it's not the dev fallback)
- [ ] `sudo ufw status` shows only 22, 80, 443 open
- [ ] `sudo fail2ban-client status sshd` shows the jail active
- [ ] `curl -fsI https://reader.your-domain.com/` returns `200 OK`
- [ ] `curl -fsI http://reader.your-domain.com/` returns `301 -> https://...`
- [ ] Cookies are `Secure` (browser devtools, Application → Cookies)
- [ ] Rate limiter is active: 6 rapid logins from one IP should return 429
- [ ] `/etc/amazing-grace/elevenlabs_credentials.json` exists, mode 600, owned by root

## When something goes wrong

| Symptom | First thing to check |
|---|---|
| 502 from Caddy | `sudo systemctl status amazinggrace` — is the Node process running? |
| Login fails with "Invalid" for a known password | Did the user get created? `sqlite3 ... 'SELECT * FROM users;'` |
| Upload fails immediately | Check `/var/log/caddy/access.log` for the upstream error; check disk space |
| ElevenLabs TTS errors | Verify the credentials file: `sudo cat /etc/amazing-grace/elevenlabs_credentials.json \| head -3` — should be the key JSON |
| Cert renewal fails | Caddy usually logs the reason; check `sudo journalctl -u caddy --since "1 day ago"` |
| Service won't start | `sudo journalctl -u amazinggrace -n 50` — usually a missing env var |
