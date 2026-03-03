#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "RAILWAY_API_TOKEN is required"
  exit 1
fi

if [[ -z "${TURN_DOMAIN:-}" ]]; then
  echo "TURN_DOMAIN is required (example: turn.example.com)"
  exit 1
fi

if [[ -z "${TURN_COTURN_SHARED_SECRET:-}" ]]; then
  echo "TURN_COTURN_SHARED_SECRET is required"
  exit 1
fi

TURN_URLS="${TURN_URLS:-turn:${TURN_DOMAIN}:3478?transport=udp,turn:${TURN_DOMAIN}:3478?transport=tcp}"
TURN_COTURN_TTL_SECONDS="${TURN_COTURN_TTL_SECONDS:-600}"
TURN_COTURN_USER_PREFIX="${TURN_COTURN_USER_PREFIX:-u}"
BACKEND_SERVICE="${BACKEND_SERVICE:-anytime-backend}"

railway variables --service "${BACKEND_SERVICE}" --set "TURN_PROVIDER=coturn"
railway variables --service "${BACKEND_SERVICE}" --set "TURN_URLS=${TURN_URLS}"
railway variables --service "${BACKEND_SERVICE}" --set "TURN_COTURN_SHARED_SECRET=${TURN_COTURN_SHARED_SECRET}"
railway variables --service "${BACKEND_SERVICE}" --set "TURN_COTURN_TTL_SECONDS=${TURN_COTURN_TTL_SECONDS}"
railway variables --service "${BACKEND_SERVICE}" --set "TURN_COTURN_USER_PREFIX=${TURN_COTURN_USER_PREFIX}"

cat <<OUT
Set Railway backend TURN vars for service: ${BACKEND_SERVICE}
TURN_PROVIDER=coturn
TURN_URLS=${TURN_URLS}
TURN_COTURN_TTL_SECONDS=${TURN_COTURN_TTL_SECONDS}
TURN_COTURN_USER_PREFIX=${TURN_COTURN_USER_PREFIX}

Redeploy backend when Railway deploys are available.
OUT
