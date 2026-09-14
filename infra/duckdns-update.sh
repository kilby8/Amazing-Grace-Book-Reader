#!/usr/bin/env bash
# Keep a DuckDNS subdomain pointed at this machine's public IPv4.
#
# DuckDNS gives you a free subdomain like <name>.duckdns.org. Free, no
# payment, account via GitHub OAuth. Update API:
#   GET https://www.duckdns.org/update?domains=<name>&token=<token>&ip=<ipv4>
# Returns "OK" on success. We poll every 5 minutes via cron so the
# subdomain keeps pointing here after Oracle stop/start events (which
# can change the public IP).
#
# Configure via env or /etc/amazing-grace/duckdns.env:
#   DUCKDNS_DOMAIN=jamesreader
#   DUCKDNS_TOKEN=<from duckdns.org dashboard>
# Optional override:
#   DUCKDNS_INTERFACE=eth0        # interface to read public IP from (default)
#   DUCKDNS_API=https://www.duckdns.org/update
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/amazing-grace/duckdns.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${DUCKDNS_DOMAIN:?DUCKDNS_DOMAIN not set}"
: "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN not set}"
DUCKDNS_API="${DUCKDNS_API:-https://www.duckdns.org/update}"
DUCKDNS_INTERFACE="${DUCKDNS_INTERFACE:-eth0}"

# Read the first non-loopback IPv4. Works on Oracle Ubuntu (eth0).
ipv4=$(ip -4 -o addr show dev "$DUCKDNS_INTERFACE" 2>/dev/null \
  | awk '{print $4}' | cut -d/ -f1 | head -1)
[[ -n "$ipv4" ]] || { echo "[duckdns] no IPv4 on $DUCKDNS_INTERFACE" >&2; exit 1; }

# DuckDNS returns "OK" on success. Anything else = failure.
resp=$(curl -fsS --max-time 10 \
  "${DUCKDNS_API}?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=${ipv4}" \
  || true)
case "$resp" in
  OK)        echo "[duckdns] ${DUCKDNS_DOMAIN}.duckdns.org -> ${ipv4}" ;;
  KO|"")     echo "[duckdns] update failed: '$resp'" >&2; exit 2 ;;
  *)         echo "[duckdns] unexpected response: '$resp'" >&2; exit 3 ;;
esac
