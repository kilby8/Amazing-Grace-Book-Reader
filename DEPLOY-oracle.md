# Deploying on Oracle Cloud Always Free (zero spend)

Oracle's "Always Free" tier includes a real ARM VM that's free forever
(not a trial — no charge ever). This is the recipe for hosting the
Amazing Grace Reader web app there with no recurring cost.

## What's free forever

| Resource | Free allocation |
|---|---|
| **Compute** | 2 x `VM.Standard.A1.Flex` (ARM Ampere). Total 4 OCPUs, 24 GB RAM across both. |
| **Block storage** | 200 GB total, 50 GB per volume |
| **Networking** | 10 TB egress/month, 2 load balancers |
| **Public IP** | Reserved public IPv4 (free) |

For this app: **2 OCPUs / 12 GB RAM / 50 GB disk** is more than enough.

## What's NOT free

- Egress over 10 TB/month (unlikely to hit)
- Extra block storage beyond 200 GB
- A "real" domain (~$10/yr). We use **DuckDNS** for a free subdomain.

## Total cost: $0

## Step-by-step

### 1. Sign up

Go to **cloud.oracle.com/free** and create an account. You need:
- An email
- A credit/debit card (Oracle does a ~$1 refundable authorization hold)
- A tenancy name (your cloud "home"; pick something memorable)

Approval is usually instant but can take up to 24 hours for manual review.
If approval fails ("identity verification failed"), try a different card
or contact support — it's a known annoyance.

### 2. Create a free subdomain (DuckDNS)

Skip the domain purchase. Go to **duckdns.org** and sign in with GitHub.
Pick a subdomain name (e.g. `jamesreader`). DuckDNS shows your token
on the dashboard — copy it.

The domain will be `jamesreader.duckdns.org`. Caddy will issue a real
Let's Encrypt cert for it on first request.

### 3. Provision the VM

In the Oracle Cloud console:

1. **Compute → Instances → Create instance**
2. Name: `amazing-grace` (or whatever)
3. **Image and shape → Edit**
   - Image: **Canonical Ubuntu 24.04 (aarch64)** — Always Free eligible
   - Shape: **VM.Standard.A1.Flex** with **2 OCPUs / 12 GB RAM**
4. **Networking**:
   - Create new VCN ("amazing-grace-vcn" is fine, defaults work)
   - Create new subnet ("amazing-grace-subnet", defaults work)
   - **Assign a public IPv4 address** (this is the "Assign a public IPv4
     address" checkbox in the Primary VNIC info section)
5. **SSH keys**: upload the public key you'll use to SSH in
6. **Boot volume**: 50 GB (the default is fine, must be ≤ 50 GB to stay
   in free tier)

Click **Create**. You'll see one of:
- ✅ "Available" — VM is up
- ❌ "Out of host capacity" — the region is full. Try another region
  (Ashburn, Phoenix, Frankfurt, London) or a smaller instance.

**Capacity tips:**
- Frankfurt and Phoenix tend to have more A1 capacity
- Off-peak hours (early morning US time) have more capacity
- Script to retry every few minutes until it works — Oracle's quota is
  generous, it's just per-region capacity that varies

When the instance is up, **copy the public IP** from the instance details
page. You'll need it for DNS and for SSH.

### 4. Open the right ports in Oracle's security list

Oracle blocks all inbound traffic by default. The Ubuntu image's
default iptables is permissive, but Oracle's **Network Security Group**
(or **Security List** on the subnet) is what actually controls inbound.

Quick path:
1. **Networking → Virtual Cloud Networks → your VCN → Subnets → your subnet → Security List**
2. **Add Ingress Rules**:
   - `0.0.0.0/0  TCP  22`   (SSH)
   - `0.0.0.0/0  TCP  80`   (Caddy → ACME http-01 challenge + http→https redirect)
   - `0.0.0.0/0  TCP  443`  (Caddy)

3. Save. The rules take effect within seconds.

### 5. First-time SSH (as `ubuntu`)

Oracle's Ubuntu image uses `ubuntu` as the default user. The user has
passwordless sudo. SSH in:

```bash
ssh ubuntu@<vm-public-ip>
```

If the SSH key you uploaded matches your local `~/.ssh/id_*.pub`, you're
in with no password.

### 6. Clone + provision

Same as the Hetzner flow, just with DuckDNS vars instead of a real domain:

```bash
sudo apt-get update -qq && sudo apt-get install -y -qq git sudo
cd ~
git clone --branch feat/pdf-pocket-tts --depth 1 \
  https://github.com/kilby8/Amazing-Grace-Book-Reader.git
cd Amazing-Grace-Book-Reader

DUCKDNS_DOMAIN=jamesreader \
DUCKDNS_TOKEN=your-token-from-duckdns \
ELEVENLABS_API_KEY=sk_your-key-if-you-have-one \
  bash infra/setup.sh
```

The script does the same things it does for any Ubuntu box: installs
packages, configures UFW, sets up Caddy, clones the repo at
`/opt/amazing-grace`, runs `npm ci`, generates `SESSION_SECRET`, installs
the systemd unit, and configures Caddy.

The DuckDNS-specific additions:
- Writes `/etc/amazing-grace/duckdns.env` (mode 600)
- Installs `/etc/cron.d/duckdns-update` to refresh the A record every
  5 minutes (handles Oracle's DHCP renewals / stop-start)
- Runs the DuckDNS update once so the A record points at the VM before
  Caddy asks Let's Encrypt for the cert

### 7. Verify

From anywhere:

```bash
curl -fsSL https://jamesreader.duckdns.org/api/me
# {"user":null}

# Sign up
curl -fsS -c cookies.txt -X POST https://jamesreader.duckdns.org/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"you","password":"a-strong-password"}'
```

Open `https://jamesreader.duckdns.org` in a browser — valid TLS lock,
auth screen, sign up, library, upload, read.

### 8. Backups

```bash
sudo cp /opt/amazing-grace/infra/amazinggrace-backup.cron /etc/cron.d/
sudo systemctl restart cron
```

Local backups in `/var/backups/amazing-grace/`. For off-box redundancy,
restic to Backblaze B2 (10 GB free tier) or any S3-compatible store.
See DEPLOY.md §7 for the env vars to add.

### 9. Updates

```bash
ssh ubuntu@<vm-public-ip>
cd /opt/amazing-grace
git pull --ff-only
(cd web && npm ci --omit=dev --no-audit --no-fund)
sudo systemctl restart amazinggrace
```

## Capacity gotchas (and how to live with them)

**Oracle can reclaim free-tier idle instances.** This was a real problem
in 2022-2023. As of 2024-2025 it has been mostly quiet, but:
- If you let the VM sit idle for a long time, you may get an email
  asking you to confirm you still want it. Reply yes.
- If you actually get reclaimed, you can re-provision. The data dir at
  `/opt/amazing-grace/data/` is on a separate boot volume that survives
  instance termination, but is NOT preserved across "reclaim" events
  (those destroy the volume too).
- **Always have backups off-box.** restic to B2/S3 is the answer. Don't
  rely on Oracle's local disk surviving a year.

**A1 region capacity** is the #1 friction. If "Out of host capacity" on
create:
1. Try a different region
2. Try a smaller shape (1 OCPU / 6 GB is enough for this app)
3. Try at off-peak hours (US morning)
4. Wait an hour and retry

A retry script:

```bash
# Run this from your laptop; loops until the instance comes up.
for i in {1..50}; do
  echo "Attempt $i"
  oci compute instance launch \
    --compartment-id <your-tenancy-ocid> \
    --availability-domain "<ad>" \
    --shape "VM.Standard.A1.Flex" \
    --shape-config '{"ocpus":2,"memoryInGBs":12}' \
    --image-id <ubuntu-aarch64-image-ocid> \
    --subnet-id <subnet-ocid> \
    --assign-public-ip true \
    --display-name "amazing-grace" \
    --metadata '{"ssh_authorized_keys":"ssh-rsa AAAA..."}' \
    && break
  sleep 120
done
```

## File layout after provisioning

Same as DEPLOY.md, plus:
```
/etc/amazing-grace/
├── duckdns.env                   # mode 600 (DUCKDNS_DOMAIN + DUCKDNS_TOKEN)
/etc/cron.d/
├── duckdns-update                # every 5 min, refresh A record
├── amazinggrace-backup           # nightly, if you copied the cron file
```

## Operational cheatsheet

```bash
# Service status
sudo systemctl status amazinggrace

# Live tail of app + caddy
sudo journalctl -u amazinggrace -u caddy -f

# Force-refresh the DuckDNS A record right now
sudo bash /opt/amazing-grace/infra/duckdns-update.sh

# What domain does Caddy think it's serving?
sudo cat /etc/caddy/Caddyfile | grep -v '^#' | head -3

# When did the cert last renew?
sudo journalctl -u caddy --since "30 days ago" | grep -i 'certificate'

# Storage usage
df -h / /opt/amazing-grace/data /var/backups/amazing-grace

# Active users + book count
sudo sqlite3 /opt/amazing-grace/data/library.db \
  "SELECT u.username, COUNT(b.id) FROM users u LEFT JOIN books b ON b.user_id=u.id GROUP BY u.id;"
```

## When something goes wrong

| Symptom | First thing to check |
|---|---|
| Caddy serves 502 for everything | `sudo systemctl status amazinggrace` — is the Node process running? |
| Cert never appears, browser shows "not secure" | Did the DuckDNS A record update? `dig +short jamesreader.duckdns.org` should return the VM IP |
| Domain resolves to wrong IP | `sudo bash /opt/amazing-grace/infra/duckdns-update.sh` to force refresh |
| `Connection refused` on 443 | Oracle's Security List — did you add the ingress rules? |
| Slow first request after long idle | Oracle may have stopped the VM. `sudo journalctl -u caddy -n 20` to see if it restarted |
| TTS errors 502 / 429 | Check `/etc/amazing-grace/elevenlabs_credentials.json` exists, mode 600, valid JSON |
| A1 capacity errors on (re)provision | See "Capacity gotchas" above |
| Boot volume full | Expand up to 50 GB (free tier cap) in OCI console, then `sudo resize2fs /dev/sda1` |
