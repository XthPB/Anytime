# Self-Hosted TURN with Coturn (Production)

This project supports first-party TURN credentials from backend (`TURN_PROVIDER=coturn`) and a self-hosted Coturn server.

## 1. What You Need

- One Linux VM with a public static IPv4 (and optional IPv6).
- A DNS record: `turn.your-domain.com` -> VM public IP.
- Firewall/security group rules:
  - `3478/tcp`
  - `3478/udp`
  - `5349/tcp` (for `turns`)
  - relay range `49160-49200/tcp`
  - relay range `49160-49200/udp`

## 2. Configure Coturn

Use the files in `infra/turn/`.

```bash
cd infra/turn
cp .env.example .env
# edit TURN_PUBLIC_IP, TURN_REALM, TURN_SHARED_SECRET
# optional: set TURN_TLS_CERT/TURN_TLS_KEY for turns://
docker compose up -d
```

## 3. Backend Configuration (Railway)

Set these env vars on `anytime-backend`:

- `TURN_PROVIDER=coturn`
- `TURN_URLS=turn:turn.your-domain.com:3478?transport=udp,turn:turn.your-domain.com:3478?transport=tcp,turns:turn.your-domain.com:5349?transport=tcp`
- `TURN_COTURN_SHARED_SECRET=<same secret used by coturn>`
- `TURN_COTURN_TTL_SECONDS=600`
- `TURN_COTURN_USER_PREFIX=u`

Then redeploy backend.

## 4. Validation

- App calls `GET /v1/calls/ice` and should return `source: "coturn"`.
- Test calls from:
  - home Wi-Fi <-> mobile hotspot
  - office/VPN <-> home
- If only same-network calls work, check opened UDP relay range and NAT/firewall rules.

## 5. Hardening Checklist

- Keep Coturn and OS patched.
- Use long random shared secret and rotate periodically.
- Prefer `turns` for privacy on restrictive networks.
- Add monitoring and alerting (CPU, network, packet loss, process restarts).
- Keep relay range narrow and documented.
