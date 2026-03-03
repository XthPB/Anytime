#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  $0 --host <ssh-host> --user <ssh-user> --domain <turn.domain.com> [options]

Required:
  --host                SSH host or IP of TURN server
  --user                SSH username
  --domain              Public TURN DNS name (realm), e.g. turn.example.com

Options:
  --ssh-key <path>      SSH private key path
  --public-ip <ip>      Public IPv4 of host (auto-detected if omitted)
  --shared-secret <s>   TURN REST shared secret (auto-generated if omitted)
  --min-port <n>        Relay min port (default: 49160)
  --max-port <n>        Relay max port (default: 49200)
  --enable-ufw          Add UFW rules and enable UFW
  -h, --help            Show this help
USAGE
}

SSH_HOST=""
SSH_USER=""
TURN_DOMAIN=""
SSH_KEY=""
PUBLIC_IP=""
TURN_SHARED_SECRET=""
MIN_PORT="49160"
MAX_PORT="49200"
ENABLE_UFW="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) SSH_HOST="$2"; shift 2 ;;
    --user) SSH_USER="$2"; shift 2 ;;
    --domain) TURN_DOMAIN="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --shared-secret) TURN_SHARED_SECRET="$2"; shift 2 ;;
    --min-port) MIN_PORT="$2"; shift 2 ;;
    --max-port) MAX_PORT="$2"; shift 2 ;;
    --enable-ufw) ENABLE_UFW="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$SSH_HOST" || -z "$SSH_USER" || -z "$TURN_DOMAIN" ]]; then
  echo "Missing required arguments."
  usage
  exit 1
fi

if [[ -z "$TURN_SHARED_SECRET" ]]; then
  TURN_SHARED_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
fi

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(dig +short "$TURN_DOMAIN" A | head -n 1 || true)"
fi

if [[ -z "$PUBLIC_IP" ]]; then
  echo "Could not auto-detect public IP from DNS. Pass --public-ip explicitly."
  exit 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS+=( -i "$SSH_KEY" )
fi

REMOTE_TARGET="${SSH_USER}@${SSH_HOST}"

read -r -d '' TURN_CONF <<CONF || true
listening-port=3478
listening-ip=0.0.0.0
relay-ip=0.0.0.0
external-ip=${PUBLIC_IP}

realm=${TURN_DOMAIN}
server-name=${TURN_DOMAIN}

fingerprint
use-auth-secret
static-auth-secret=${TURN_SHARED_SECRET}
lt-cred-mech

no-cli
no-tls
no-dtls
stale-nonce=600

min-port=${MIN_PORT}
max-port=${MAX_PORT}

no-loopback-peers
no-multicast-peers
CONF

ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y coturn ufw"

ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "echo 'TURNSERVER_ENABLED=1' | sudo tee /etc/default/coturn >/dev/null"

printf '%s\n' "$TURN_CONF" | ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "sudo tee /etc/turnserver.conf >/dev/null"

if [[ "$ENABLE_UFW" == "true" ]]; then
  ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "sudo ufw allow 22/tcp && sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp && sudo ufw allow ${MIN_PORT}:${MAX_PORT}/tcp && sudo ufw allow ${MIN_PORT}:${MAX_PORT}/udp && sudo ufw --force enable"
else
  ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "sudo ufw allow 3478/tcp && sudo ufw allow 3478/udp && sudo ufw allow ${MIN_PORT}:${MAX_PORT}/tcp && sudo ufw allow ${MIN_PORT}:${MAX_PORT}/udp || true"
fi

ssh "${SSH_OPTS[@]}" "$REMOTE_TARGET" "sudo systemctl enable coturn && sudo systemctl restart coturn && sudo systemctl --no-pager --full status coturn | head -n 20"

cat <<ENV_OUT

Coturn provisioned.

Use these backend env vars:
TURN_PROVIDER=coturn
TURN_URLS=turn:${TURN_DOMAIN}:3478?transport=udp,turn:${TURN_DOMAIN}:3478?transport=tcp
TURN_COTURN_SHARED_SECRET=${TURN_SHARED_SECRET}
TURN_COTURN_TTL_SECONDS=600
TURN_COTURN_USER_PREFIX=u
ENV_OUT
