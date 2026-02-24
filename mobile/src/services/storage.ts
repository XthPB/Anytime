import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { KeyMaterial } from "./crypto";

export type AuthSession = {
  userId: string;
  deviceId: string;
  token: string;
};

const AUTH_KEY = "privately.auth";
const KEYS_KEY = "privately.keys";
const CONTACTS_KEY = "privately.contacts";
const SENT_TEXT_CACHE_KEY = "privately.sent-text-cache";

export async function saveAuthSession(value: AuthSession): Promise<void> {
  await AsyncStorage.setItem(AUTH_KEY, JSON.stringify(value));
}

export async function loadAuthSession(): Promise<AuthSession | null> {
  const raw = await AsyncStorage.getItem(AUTH_KEY);
  return raw ? (JSON.parse(raw) as AuthSession) : null;
}

export async function clearAuthSession(): Promise<void> {
  await AsyncStorage.removeItem(AUTH_KEY);
}

export async function saveKeyMaterial(value: KeyMaterial): Promise<void> {
  await SecureStore.setItemAsync(KEYS_KEY, JSON.stringify(value));
}

export async function loadKeyMaterial(): Promise<KeyMaterial | null> {
  const raw = await SecureStore.getItemAsync(KEYS_KEY);
  return raw ? (JSON.parse(raw) as KeyMaterial) : null;
}

export async function clearKeyMaterial(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS_KEY);
}

export async function saveContacts(value: unknown): Promise<void> {
  await AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(value));
}

export async function loadContacts<T>(): Promise<T | null> {
  const raw = await AsyncStorage.getItem(CONTACTS_KEY);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function saveSentTextCache(value: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(SENT_TEXT_CACHE_KEY, JSON.stringify(value));
}

export async function loadSentTextCache(): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(SENT_TEXT_CACHE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, string>) : {};
}
