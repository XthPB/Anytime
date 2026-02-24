import naclUtil from "tweetnacl-util";

function toBase64(base64url: string): string {
  const normalized = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  return pad === 0 ? normalized : `${normalized}${"=".repeat(4 - pad)}`;
}

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return toBase64Url(naclUtil.encodeBase64(bytes));
}

export function decodeBase64Url(value: string): Uint8Array {
  return naclUtil.decodeBase64(toBase64(value));
}
