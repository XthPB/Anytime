# Privately

Cross-platform private messaging app starter built for:

- iOS + Android client (`mobile/` with Expo React Native)
- Railway-hosted backend (`backend/` with Fastify + PostgreSQL)

## What You Get

- No email/phone signup.
- Each account gets a unique `userId`.
- Device-key identity model (signing key + encryption key).
- End-to-end encrypted chat payloads (server stores ciphertext only).
- Add contacts by `userId`.
- Encrypted call signaling + in-app WebRTC audio/video calling.
- Railway deployment config for backend.

## Repo Structure

- `backend/`: API, auth, contacts, encrypted message relay, call signaling relay.
- `mobile/`: iOS/Android app UI + crypto + API integration.
- `web/`: browser testing app with same private chat and call invite flow.
- `docs/`: architecture, API, and product notes.

## Backend Local Run

1. Start PostgreSQL (example with Docker):

```bash
docker run --name privately-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=privately \
  -p 5432:5432 -d postgres:16
```

2. Configure backend env:

```bash
cd backend
cp .env.example .env
```

3. Install and run:

```bash
npm install
npm run dev
```

## Railway Deployment (Backend)

1. Push this repo to GitHub.
2. In Railway, create a new project from the repo root.
3. Add a PostgreSQL service in Railway.
4. Set backend env vars:
- `JWT_SECRET` (32+ chars)
- `CORS_ORIGINS` (your mobile/web origins or `*` for early testing)
- `MAX_INBOX_BATCH` (e.g. `200`)
- `DATABASE_URL` (from Railway Postgres)
5. Deploy. Railway uses `railway.json` + `backend/Dockerfile`.
6. Optional scripted deploy: `./scripts/deploy-railway-backend.sh`
7. Optional scripted web deploy: `./scripts/deploy-railway-web.sh`

## Mobile Run (iOS + Android)

1. Configure app env:

```bash
cd mobile
cp .env.example .env
# edit .env -> EXPO_PUBLIC_API_URL=https://<your-railway-domain>
```

2. Install and start:

```bash
npm install
npm start
```

3. Run on devices/simulators:

```bash
npm run ios
npm run android
```

## Web Run (Browser Testing)

1. Configure web env:

```bash
cd web
cp .env.example .env
# edit .env -> VITE_API_URL=https://<your-backend-domain>
# optional for reliable calls behind strict NAT/firewalls:
# VITE_TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
# VITE_TURN_USERNAME=<turn-username>
# VITE_TURN_CREDENTIAL=<turn-password>
```

2. Install and run:

```bash
npm install
npm run dev
```

3. Open:

- `http://localhost:5173`

## Security Notes

- Current chat encryption is client-side `nacl.box` (payload encrypted before upload).
- Server never receives plaintext message bodies.
- This is strong MVP security, but not yet Signal-grade.

For production-grade security you should still add:

- X3DH + Double Ratchet (forward secrecy and better compromise recovery).
- Independent security audit and penetration testing.
- Dedicated TURN + media infrastructure (for example managed Coturn/Twilio for reliable NAT traversal).
