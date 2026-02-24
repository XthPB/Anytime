# Deployment Guide

## Backend to Railway

1. Push repo to GitHub.
2. In Railway, create new project from this repo.
3. Add PostgreSQL service.
4. Configure backend service env vars:

- `JWT_SECRET`: strong random 32+ char secret
- `CORS_ORIGINS`: allowed origins
- `MAX_INBOX_BATCH`: e.g. `200`
- `DATABASE_URL`: Postgres connection string

5. Deploy from repo root. Railway reads `railway.json` and builds `backend/Dockerfile`.
6. Confirm health endpoint:

```bash
curl https://<railway-domain>/health
```

### Optional CLI Deploy Script

You can deploy with:

```bash
./scripts/deploy-railway-backend.sh
```

Required exported variables:

- `RAILWAY_API_TOKEN`
- `JWT_SECRET`
- `DATABASE_URL`

## Web to Railway

1. Ensure backend is already deployed.
2. Export variables:

```bash
export RAILWAY_API_TOKEN=<railway-api-token>
export VITE_API_URL=https://<your-backend-domain>
```

3. Deploy web service:

```bash
./scripts/deploy-railway-web.sh
```

## Mobile Build (iOS + Android)

1. Set mobile env:

```bash
cd mobile
cp .env.example .env
# set EXPO_PUBLIC_API_URL=https://<railway-domain>
```

2. Install and validate:

```bash
npm install
npm run typecheck
```

3. Local run:

```bash
npm start
```

4. Store builds:

```bash
npx eas login
npx eas build:configure
npx eas build --platform ios
npx eas build --platform android
```
