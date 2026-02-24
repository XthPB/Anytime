# API Overview

Base URL: `https://<your-backend-domain>`

## Health

- `GET /health`

## Identity

- `POST /v1/identity/register`
  - body:
    - `deviceName`
    - `deviceSigningPublicKey`
    - `deviceEncryptionPublicKey`
  - returns: `{ userId, deviceId, token, createdAt }`

- `GET /v1/identity/me` (auth)
  - returns: `{ userId, deviceId }`

- `POST /v1/identity/challenge`
  - body: `{ userId, deviceId }`
  - returns: `{ challenge, expiresInSeconds }`

- `POST /v1/identity/verify`
  - body: `{ userId, deviceId, signature }`
  - returns: `{ token }`

## Users + Contacts

Auth: `Bearer <token>`

- `GET /v1/users/:userId`
  - returns user public profile + encryption key

- `POST /v1/users/contacts`
  - body: `{ contactUserId, nickname? }`

- `GET /v1/users/contacts`

## Prekey Exchange

Auth: `Bearer <token>`

- `POST /v1/keys/prekeys/upload`
- `GET /v1/keys/prekeys/:userId`

## Messages

Auth: `Bearer <token>`

- `POST /v1/messages/send`
  - body: `{ conversationId, recipientUserId, ciphertext, nonce }`

- `GET /v1/messages/inbox?since=<ISO8601>`

- `GET /v1/messages/thread/:contactUserId`

## Calls Signaling

Auth: `Bearer <token>`

- `POST /v1/calls/session`
- `POST /v1/calls/signal`
- `GET /v1/calls/signal/pull`

## Storage Model

- Messages and signals store encrypted payload fields only.
- Decryption keys remain on client devices.
