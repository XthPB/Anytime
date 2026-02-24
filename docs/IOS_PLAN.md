# Mobile Product Plan (iOS + Android)

## Stack

- Framework: Expo React Native (single codebase).
- Crypto: TweetNaCl client-side encryption.
- Secure storage: Expo SecureStore + AsyncStorage.
- UI: Native components + gradient cards + responsive layouts.

## Core Delivered in This Repo

- Local identity generation (no email/phone).
- Unique user ID registration with backend.
- Add contacts by user ID.
- End-to-end encrypted text chat payloads.
- Encrypted call invite signaling and incoming invite modal.
- Video room join flow (Jitsi room URL).

## Next Up for Production

1. Background push delivery for chat and calls.
2. Stronger E2EE protocol (X3DH + Double Ratchet).
3. Self-hosted media stack with private TURN.
4. Multi-device sync and key rotation UX.
