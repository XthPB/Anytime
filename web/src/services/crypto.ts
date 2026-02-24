import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { decodeBase64Url, encodeBase64Url } from "../lib/base64url";

export type KeyMaterial = {
  signingPublicKey: string;
  signingSecretKey: string;
  encryptionPublicKey: string;
  encryptionSecretKey: string;
};

export function generateKeys(): KeyMaterial {
  const signPair = nacl.sign.keyPair();
  const boxPair = nacl.box.keyPair();

  return {
    signingPublicKey: encodeBase64Url(signPair.publicKey),
    signingSecretKey: encodeBase64Url(signPair.secretKey),
    encryptionPublicKey: encodeBase64Url(boxPair.publicKey),
    encryptionSecretKey: encodeBase64Url(boxPair.secretKey)
  };
}

export function encryptPayload(plaintext: string, recipientPublicKey: string, senderSecretKey: string) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(
    naclUtil.decodeUTF8(plaintext),
    nonce,
    decodeBase64Url(recipientPublicKey),
    decodeBase64Url(senderSecretKey)
  );

  return {
    ciphertext: encodeBase64Url(boxed),
    nonce: encodeBase64Url(nonce)
  };
}

export function decryptPayload(input: {
  ciphertext: string;
  nonce: string;
  senderPublicKey: string;
  recipientSecretKey: string;
}): string | null {
  const opened = nacl.box.open(
    decodeBase64Url(input.ciphertext),
    decodeBase64Url(input.nonce),
    decodeBase64Url(input.senderPublicKey),
    decodeBase64Url(input.recipientSecretKey)
  );

  return opened ? naclUtil.encodeUTF8(opened) : null;
}

export function signMessage(message: string, signingSecretKey: string): string {
  const signature = nacl.sign.detached(
    naclUtil.decodeUTF8(message),
    decodeBase64Url(signingSecretKey)
  );

  return encodeBase64Url(signature);
}
