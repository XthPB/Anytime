# Architecture (Cross-Platform + Privacy)

## Platforms

- Mobile app: Expo React Native for iOS + Android.
- Backend: Fastify API on Railway.
- Database: PostgreSQL.

## Identity Model

- No email/phone requirement.
- Each account has a generated `userId`.
- Each device generates local keypairs:
  - signing keypair for challenge verification
  - encryption keypair for E2EE payloads

## Messaging Model

- Client encrypts message plaintext before upload.
- Backend stores only ciphertext + nonce + routing metadata.
- Recipients decrypt locally with their device secret key.

## Contacts Model

- Contacts are added directly by `userId`.
- App fetches contact public encryption key from backend profile endpoint.

## Calls Model

- App uses backend only for encrypted signaling payload relay.
- Current MVP call join UX uses Jitsi room invite links.
- For stricter privacy, move to self-hosted SFU/turn stack and app-managed E2EE media.

## Deployment Model

- Railway deploys backend from `backend/Dockerfile`.
- Railway Postgres provides `DATABASE_URL`.
- Mobile app points to backend via `EXPO_PUBLIC_API_URL`.
