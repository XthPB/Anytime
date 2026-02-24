import "react-native-get-random-values";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { decodeBase64UrlBytes, encodeBytesBase64Url } from "../lib/base64url";

export type KeyMaterial = {
  signingPublicKey: string;
  signingSecretKey: string;
  encryptionPublicKey: string;
  encryptionSecretKey: string;
};

export function createKeyMaterial(): KeyMaterial {
  const signPair = nacl.sign.keyPair();
  const boxPair = nacl.box.keyPair();

  return {
    signingPublicKey: encodeBytesBase64Url(signPair.publicKey),
    signingSecretKey: encodeBytesBase64Url(signPair.secretKey),
    encryptionPublicKey: encodeBytesBase64Url(boxPair.publicKey),
    encryptionSecretKey: encodeBytesBase64Url(boxPair.secretKey)
  };
}

export function signChallenge(challenge: string, signingSecretKey: string): string {
  const signature = nacl.sign.detached(
    naclUtil.decodeUTF8(challenge),
    decodeBase64UrlBytes(signingSecretKey)
  );
  return encodeBytesBase64Url(signature);
}

export function encryptText(params: {
  plaintext: string;
  recipientEncryptionPublicKey: string;
  senderEncryptionSecretKey: string;
}): { ciphertext: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(
    naclUtil.decodeUTF8(params.plaintext),
    nonce,
    decodeBase64UrlBytes(params.recipientEncryptionPublicKey),
    decodeBase64UrlBytes(params.senderEncryptionSecretKey)
  );

  return {
    ciphertext: encodeBytesBase64Url(ciphertext),
    nonce: encodeBytesBase64Url(nonce)
  };
}

export function decryptText(params: {
  ciphertext: string;
  nonce: string;
  senderEncryptionPublicKey: string;
  recipientEncryptionSecretKey: string;
}): string | null {
  const plaintext = nacl.box.open(
    decodeBase64UrlBytes(params.ciphertext),
    decodeBase64UrlBytes(params.nonce),
    decodeBase64UrlBytes(params.senderEncryptionPublicKey),
    decodeBase64UrlBytes(params.recipientEncryptionSecretKey)
  );

  if (!plaintext) return null;
  return naclUtil.encodeUTF8(plaintext);
}
