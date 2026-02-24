import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function generateUserId(): string {
  return `u_${randomToken(14)}`;
}

export function generateDeviceId(): string {
  return `d_${randomToken(16)}`;
}

export function generateChallenge(): string {
  return randomBytes(32).toString("base64url");
}

export function generateMessageId(): string {
  return `m_${randomToken(18)}`;
}

export function generateCallId(): string {
  return `c_${randomToken(18)}`;
}

export function generateGroupId(): string {
  return `g_${randomToken(16)}`;
}

export function generateClientMessageId(): string {
  return `cm_${randomToken(20)}`;
}
