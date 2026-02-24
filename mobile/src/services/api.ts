import { AuthSession } from "./storage";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

if (!API_URL) {
  console.warn("EXPO_PUBLIC_API_URL is missing. Set it in mobile/.env");
}

export type UserProfile = {
  userId: string;
  createdAt: string;
  encryptionPublicKey: string;
};

export type Contact = {
  contactUserId: string;
  nickname: string | null;
  createdAt: string;
  encryptionPublicKey: string;
};

export type EncryptedMessage = {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderPublicEncryptionKey: string;
  recipientUserId: string;
  ciphertext: string;
  nonce: string;
  sentAt: string;
};

export type SignalEnvelope = {
  signalId: string;
  callId: string;
  fromUserId: string;
  toUserId: string;
  senderPublicEncryptionKey: string;
  encryptedPayload: string;
  createdAt: string;
};

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  if (!API_URL) throw new Error("EXPO_PUBLIC_API_URL is not configured");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined)
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function registerIdentity(input: {
  deviceName: string;
  deviceSigningPublicKey: string;
  deviceEncryptionPublicKey: string;
}): Promise<AuthSession> {
  return request<AuthSession>("/v1/identity/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function lookupUser(token: string, userId: string): Promise<UserProfile> {
  return request<UserProfile>(`/v1/users/${encodeURIComponent(userId)}`, {}, token);
}

export async function addContact(token: string, input: {
  contactUserId: string;
  nickname?: string;
}): Promise<Contact> {
  return request<Contact>("/v1/users/contacts", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function listContacts(token: string): Promise<Contact[]> {
  const result = await request<{ items: Contact[] }>("/v1/users/contacts", {}, token);
  return result.items;
}

export async function sendEncryptedMessage(token: string, input: {
  conversationId: string;
  recipientUserId: string;
  ciphertext: string;
  nonce: string;
}): Promise<EncryptedMessage> {
  return request<EncryptedMessage>("/v1/messages/send", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function listThread(token: string, contactUserId: string): Promise<EncryptedMessage[]> {
  const result = await request<{ items: EncryptedMessage[] }>(
    `/v1/messages/thread/${encodeURIComponent(contactUserId)}`,
    {},
    token
  );

  return result.items;
}

export async function createCallSession(token: string, participantUserId: string): Promise<{ callId: string }> {
  return request<{ callId: string }>("/v1/calls/session", {
    method: "POST",
    body: JSON.stringify({ participants: [participantUserId] })
  }, token);
}

export async function sendCallSignal(token: string, input: {
  callId: string;
  toUserId: string;
  encryptedPayload: string;
}): Promise<void> {
  await request("/v1/calls/signal", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function pullCallSignals(token: string): Promise<SignalEnvelope[]> {
  const result = await request<{ items: SignalEnvelope[] }>("/v1/calls/signal/pull", {}, token);
  return result.items;
}
