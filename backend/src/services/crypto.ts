const encoder = new TextEncoder();

function decodeBase64Url(input: string): Uint8Array {
  return Uint8Array.from(Buffer.from(input, "base64url"));
}

export function isLikelyEd25519PublicKey(key: string): boolean {
  try {
    return decodeBase64Url(key).byteLength === 32;
  } catch {
    return false;
  }
}

export async function verifyEd25519Signature(params: {
  publicKeyBase64Url: string;
  message: string;
  signatureBase64Url: string;
}): Promise<boolean> {
  try {
    const publicKeyBytes = decodeBase64Url(params.publicKeyBase64Url);
    const signatureBytes = decodeBase64Url(params.signatureBase64Url);

    const key = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    return crypto.subtle.verify("Ed25519", key, signatureBytes, encoder.encode(params.message));
  } catch {
    return false;
  }
}
