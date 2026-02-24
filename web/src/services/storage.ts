import { KeyMaterial } from "./crypto";

export type Session = {
  userId: string;
  deviceId: string;
  token: string;
};

const SESSION_KEY = "privately.web.session";
const KEYS_KEY = "privately.web.keys";
const CONTACTS_KEY = "privately.web.contacts";
const GROUPS_KEY = "privately.web.groups";
const SENT_CACHE_KEY = "privately.web.sentcache";

export function saveSession(value: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export function saveKeys(value: KeyMaterial): void {
  localStorage.setItem(KEYS_KEY, JSON.stringify(value));
}

export function loadKeys(): KeyMaterial | null {
  const raw = localStorage.getItem(KEYS_KEY);
  return raw ? (JSON.parse(raw) as KeyMaterial) : null;
}

export function clearAll(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(KEYS_KEY);
  localStorage.removeItem(CONTACTS_KEY);
  localStorage.removeItem(GROUPS_KEY);
  localStorage.removeItem(SENT_CACHE_KEY);
}

export function saveContacts<T>(value: T): void {
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(value));
}

export function loadContacts<T>(): T | null {
  const raw = localStorage.getItem(CONTACTS_KEY);
  return raw ? (JSON.parse(raw) as T) : null;
}

export function saveGroups<T>(value: T): void {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(value));
}

export function loadGroups<T>(): T | null {
  const raw = localStorage.getItem(GROUPS_KEY);
  return raw ? (JSON.parse(raw) as T) : null;
}

export function saveSentCache(value: Record<string, string>): void {
  localStorage.setItem(SENT_CACHE_KEY, JSON.stringify(value));
}

export function loadSentCache(): Record<string, string> {
  const raw = localStorage.getItem(SENT_CACHE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}
