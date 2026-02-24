#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "RAILWAY_API_TOKEN is required."
  echo "Get token from Railway account settings and export it:"
  echo "  export RAILWAY_API_TOKEN=..."
  exit 1
fi

if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "JWT_SECRET is required."
  echo "Example:"
  echo "  export JWT_SECRET=<use-a-strong-random-secret>"
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required."
  echo "Set it to your Railway PostgreSQL URL before deployment."
  exit 1
fi

export CORS_ORIGINS="${CORS_ORIGINS:-*}"
export MAX_INBOX_BATCH="${MAX_INBOX_BATCH:-200}"

npx @railway/cli up --detach \
  --path . \
  --service privately-backend

npx @railway/cli variables --set "JWT_SECRET=${JWT_SECRET}" --service privately-backend
npx @railway/cli variables --set "DATABASE_URL=${DATABASE_URL}" --service privately-backend
npx @railway/cli variables --set "CORS_ORIGINS=${CORS_ORIGINS}" --service privately-backend
npx @railway/cli variables --set "MAX_INBOX_BATCH=${MAX_INBOX_BATCH}" --service privately-backend

echo "Deploy triggered. Check status in Railway dashboard."
