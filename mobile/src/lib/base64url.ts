import naclUtil from "tweetnacl-util";

export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBase64(base64url: string): string {
  const normalized = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  if (padding === 0) return normalized;
  return `${normalized}${"=".repeat(4 - padding)}`;
}

export function encodeBytesBase64Url(bytes: Uint8Array): string {
  return base64ToBase64Url(naclUtil.encodeBase64(bytes));
}

export function decodeBase64UrlBytes(value: string): Uint8Array {
  return naclUtil.decodeBase64(base64UrlToBase64(value));
}
