#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "RAILWAY_API_TOKEN is required"
  exit 1
fi

if [[ -z "${CF_TURN_KEY_ID:-}" ]]; then
  echo "CF_TURN_KEY_ID is required"
  exit 1
fi

if [[ -z "${CF_TURN_API_TOKEN:-}" ]]; then
  echo "CF_TURN_API_TOKEN is required"
  exit 1
fi

BACKEND_SERVICE="${BACKEND_SERVICE:-anytime-backend}"
CF_TURN_TTL_SECONDS="${CF_TURN_TTL_SECONDS:-86400}"

railway variables --service "${BACKEND_SERVICE}" --set "TURN_PROVIDER=cloudflare"
railway variables --service "${BACKEND_SERVICE}" --set "CF_TURN_KEY_ID=${CF_TURN_KEY_ID}"
railway variables --service "${BACKEND_SERVICE}" --set "CF_TURN_API_TOKEN=${CF_TURN_API_TOKEN}"
railway variables --service "${BACKEND_SERVICE}" --set "CF_TURN_TTL_SECONDS=${CF_TURN_TTL_SECONDS}"

cat <<OUT
Set Railway backend TURN vars for service: ${BACKEND_SERVICE}
TURN_PROVIDER=cloudflare
CF_TURN_KEY_ID=${CF_TURN_KEY_ID}
CF_TURN_TTL_SECONDS=${CF_TURN_TTL_SECONDS}

Redeploy backend after setting vars.
OUT
