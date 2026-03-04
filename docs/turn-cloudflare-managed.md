# Managed TURN with Cloudflare (No VPS)

This app supports Cloudflare TURN via backend-managed short-lived credentials.

## 1. Create TURN key in Cloudflare

In Cloudflare dashboard:
1. Open **Realtime > TURN Service**.
2. Create a TURN key.
3. Save:
   - `TURN Key ID`
   - `TURN Key API Token` (Bearer token)

Reference endpoint used by backend:
- `POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers`

## 2. Configure Railway backend env

Set these on `anytime-backend`:

- `TURN_PROVIDER=cloudflare`
- `CF_TURN_KEY_ID=<turn_key_id>`
- `CF_TURN_API_TOKEN=<turn_key_api_token>`
- `CF_TURN_TTL_SECONDS=86400` (or lower if preferred)

Scripted setup:

```bash
export RAILWAY_API_TOKEN=...
export CF_TURN_KEY_ID=...
export CF_TURN_API_TOKEN=...
export CF_TURN_TTL_SECONDS=86400
./scripts/configure-railway-cloudflare-turn.sh
```

## 3. Redeploy backend

Redeploy `anytime-backend` after env vars are set.

## 4. Validate

1. Login in web app.
2. Calls should fetch `GET /v1/calls/ice` and receive `source: "cloudflare"`.
3. Test calls across different networks (home Wi-Fi <-> mobile hotspot).

## Notes

- Frontend already consumes backend ICE config; no web env changes needed.
- Keep `CF_TURN_API_TOKEN` secret; do not expose it to client-side code.
