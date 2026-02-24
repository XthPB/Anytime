import { Session } from "./storage";

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

if (!API_URL) {
  console.warn("VITE_API_URL is missing. Set it in web/.env");
}

export type Contact = {
  contactUserId: string;
  nickname: string | null;
  createdAt: string;
  encryptionPublicKey: string;
};

export type GroupMember = {
  userId: string;
  encryptionPublicKey: string;
};

export type Group = {
  groupId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  members: GroupMember[];
};

export type UserProfile = {
  userId: string;
  createdAt: string;
  encryptionPublicKey: string;
};

export type EncryptedMessage = {
  messageId: string;
  clientMessageId?: string | null;
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  senderPublicEncryptionKey: string;
  recipientUserId: string;
  ciphertext: string;
  nonce: string;
  editedAt: string | null;
  deletedAt: string | null;
  readAt: string | null;
  sentAt: string;
};

export type TypingIndicator = {
  conversationId: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: string;
};

export type CallHistoryItem = {
  callId: string;
  createdBy: string;
  participants: string[];
  mode: "audio" | "video";
  createdAt: string;
  endedAt: string | null;
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
  if (!API_URL) throw new Error("VITE_API_URL not configured");

  const hasBody = typeof init.body !== "undefined" && init.body !== null;
  const headers: Record<string, string> = {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined)
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (response.status === 204 || text.length === 0) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

export function registerIdentity(input: {
  deviceName: string;
  deviceSigningPublicKey: string;
  deviceEncryptionPublicKey: string;
}) {
  return request<Session>("/v1/identity/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function issueIdentityChallenge(input: { userId: string; deviceId: string }) {
  return request<{ challenge: string; expiresInSeconds: number }>("/v1/identity/challenge", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function verifyIdentityChallenge(input: { userId: string; deviceId: string; signature: string }) {
  return request<{ token: string }>("/v1/identity/verify", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function lookupUser(token: string, userId: string) {
  return request<UserProfile>(`/v1/users/${encodeURIComponent(userId)}`, {}, token);
}

export function addContact(token: string, input: { contactUserId: string; nickname?: string }) {
  return request<Contact>("/v1/users/contacts", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function listContacts(token: string) {
  const res = await request<{ items: Contact[] }>("/v1/users/contacts", {}, token);
  return res.items;
}

export function updateContact(token: string, contactUserId: string, input: { nickname: string | null }) {
  return request<Contact>(`/v1/users/contacts/${encodeURIComponent(contactUserId)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }, token);
}

export function deleteContact(token: string, contactUserId: string) {
  return request<void>(`/v1/users/contacts/${encodeURIComponent(contactUserId)}`, {
    method: "DELETE"
  }, token);
}

export function createGroup(token: string, input: { name: string; memberUserIds: string[] }) {
  return request<Group>("/v1/groups", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function listGroups(token: string) {
  const res = await request<{ items: Group[] }>("/v1/groups", {}, token);
  return res.items;
}

export function sendMessage(token: string, input: {
  conversationId: string;
  clientMessageId?: string;
  recipientUserId: string;
  ciphertext: string;
  nonce: string;
}) {
  return request<EncryptedMessage>("/v1/messages/send", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function sendMessageBatch(token: string, input: {
  conversationId: string;
  clientMessageId?: string;
  items: Array<{
    recipientUserId: string;
    ciphertext: string;
    nonce: string;
  }>;
}) {
  const res = await request<{ items: EncryptedMessage[] }>("/v1/messages/send-batch", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);

  return res.items;
}

export async function listConversation(token: string, conversationId: string) {
  const res = await request<{ items: EncryptedMessage[] }>(
    `/v1/messages/conversation/${encodeURIComponent(conversationId)}`,
    {},
    token
  );
  return res.items;
}

export async function listInbox(token: string, since?: string) {
  const suffix = since ? `?since=${encodeURIComponent(since)}` : "";
  const res = await request<{ items: EncryptedMessage[] }>(`/v1/messages/inbox${suffix}`, {}, token);
  return res.items;
}

export function editMessage(token: string, messageId: string, input: { ciphertext: string; nonce: string }) {
  return request<EncryptedMessage>(`/v1/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }, token);
}

export function editMessageByClientId(token: string, clientMessageId: string, input: {
  conversationId: string;
  items: Array<{
    recipientUserId: string;
    ciphertext: string;
    nonce: string;
  }>;
}) {
  return request<{ items: EncryptedMessage[] }>(`/v1/messages/by-client/${encodeURIComponent(clientMessageId)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  }, token);
}

export function deleteMessage(token: string, messageId: string) {
  return request<void>(`/v1/messages/${encodeURIComponent(messageId)}`, {
    method: "DELETE"
  }, token);
}

export function hideMessage(token: string, messageId: string) {
  return request<void>(`/v1/messages/${encodeURIComponent(messageId)}/hide`, {
    method: "POST"
  }, token);
}

export function deleteMessageByClientId(token: string, clientMessageId: string, conversationId: string) {
  return request<{ deleted: number }>(`/v1/messages/delete-by-client/${encodeURIComponent(clientMessageId)}`, {
    method: "POST",
    body: JSON.stringify({ conversationId })
  }, token);
}

export function clearConversation(token: string, conversationId: string) {
  return request<void>("/v1/messages/conversation/clear", {
    method: "POST",
    body: JSON.stringify({ conversationId })
  }, token);
}

export function markConversationRead(token: string, conversationId: string) {
  return request<{ updated: number }>(`/v1/messages/conversation/read/${encodeURIComponent(conversationId)}`, {
    method: "POST"
  }, token);
}

export function sendTyping(token: string, input: {
  conversationId: string;
  recipientUserIds: string[];
  ttlSeconds?: number;
}) {
  return request<{ ok: boolean }>("/v1/messages/typing", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function pullTyping(token: string, conversationId: string) {
  const res = await request<{ items: TypingIndicator[] }>(
    `/v1/messages/typing/${encodeURIComponent(conversationId)}`,
    {},
    token
  );
  return res.items;
}

export function createCallSession(token: string, participants: string[], mode: "audio" | "video") {
  return request<{ callId: string; mode: "audio" | "video" }>("/v1/calls/session", {
    method: "POST",
    body: JSON.stringify({ participants, mode })
  }, token);
}

export function sendCallSignal(token: string, input: {
  callId: string;
  toUserId: string;
  encryptedPayload: string;
}) {
  return request("/v1/calls/signal", {
    method: "POST",
    body: JSON.stringify(input)
  }, token);
}

export async function pullSignals(token: string) {
  const res = await request<{ items: SignalEnvelope[] }>("/v1/calls/signal/pull", {}, token);
  return res.items;
}

export function endCall(token: string, callId: string) {
  return request<void>(`/v1/calls/${encodeURIComponent(callId)}/end`, {
    method: "POST"
  }, token);
}

export async function listCallHistory(token: string, peerUserId: string) {
  const res = await request<{ items: CallHistoryItem[] }>(`/v1/calls/history/${encodeURIComponent(peerUserId)}`, {}, token);
  return res.items;
}

export function clearCallHistory(token: string, peerUserId: string) {
  return request<void>("/v1/calls/history/clear", {
    method: "POST",
    body: JSON.stringify({ peerUserId })
  }, token);
}
