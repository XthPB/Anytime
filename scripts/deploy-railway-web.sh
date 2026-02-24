#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "RAILWAY_API_TOKEN is required."
  exit 1
fi

if [[ -z "${VITE_API_URL:-}" ]]; then
  echo "VITE_API_URL is required (your deployed backend URL)."
  exit 1
fi

npx @railway/cli up --detach \
  --path web \
  --service privately-web

npx @railway/cli variables --set "VITE_API_URL=${VITE_API_URL}" --service privately-web

echo "Web deploy triggered."
