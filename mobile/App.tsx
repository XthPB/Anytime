import "react-native-get-random-values";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import {
  Contact,
  EncryptedMessage,
  addContact,
  createCallSession,
  listContacts,
  listThread,
  lookupUser,
  pullCallSignals,
  registerIdentity,
  sendCallSignal,
  sendEncryptedMessage
} from "./src/services/api";
import { KeyMaterial, createKeyMaterial, decryptText, encryptText } from "./src/services/crypto";
import {
  AuthSession,
  clearAuthSession,
  clearKeyMaterial,
  loadAuthSession,
  loadContacts,
  loadKeyMaterial,
  loadSentTextCache,
  saveAuthSession,
  saveContacts,
  saveKeyMaterial,
  saveSentTextCache
} from "./src/services/storage";

type UiMessage = {
  id: string;
  text: string;
  isMine: boolean;
  sentAt: string;
};

type IncomingInvite = {
  fromUserId: string;
  room: string;
  callId: string;
};

const POLL_MS = 4000;

export default function App() {
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string>("");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [keys, setKeys] = useState<KeyMaterial | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [thread, setThread] = useState<UiMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [addNickname, setAddNickname] = useState("");
  const [incomingInvite, setIncomingInvite] = useState<IncomingInvite | null>(null);

  const sentTextCacheRef = useRef<Record<string, string>>({});

  const ownUserId = session?.userId ?? "";

  const conversationId = useMemo(() => {
    if (!session || !selectedContact) return "";
    return [session.userId, selectedContact.contactUserId].sort().join("__");
  }, [session, selectedContact]);

  const toUiMessages = useCallback((messages: EncryptedMessage[], localKeys: KeyMaterial, localSession: AuthSession) => {
    const decoded: UiMessage[] = messages.map((item) => {
      const mine = item.senderUserId === localSession.userId;
      if (mine) {
        return {
          id: item.messageId,
          text: sentTextCacheRef.current[item.messageId] ?? "Encrypted message sent from another device",
          isMine: true,
          sentAt: item.sentAt
        };
      }

      const plaintext = decryptText({
        ciphertext: item.ciphertext,
        nonce: item.nonce,
        senderEncryptionPublicKey: item.senderPublicEncryptionKey,
        recipientEncryptionSecretKey: localKeys.encryptionSecretKey
      });

      return {
        id: item.messageId,
        text: plaintext ?? "Unable to decrypt message",
        isMine: false,
        sentAt: item.sentAt
      };
    });

    return decoded.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  }, []);

  const refreshThread = useCallback(async () => {
    if (!session || !keys || !selectedContact) return;

    try {
      const messages = await listThread(session.token, selectedContact.contactUserId);
      setThread(toUiMessages(messages, keys, session));
    } catch (error) {
      setStatusText(`Sync error: ${(error as Error).message}`);
    }
  }, [keys, selectedContact, session, toUiMessages]);

  const processSignals = useCallback(async () => {
    if (!session || !keys) return;

    try {
      const signals = await pullCallSignals(session.token);
      for (const signal of signals) {
        try {
          const wrapped = JSON.parse(signal.encryptedPayload) as {
            ciphertext: string;
            nonce: string;
          };

          const plaintext = decryptText({
            ciphertext: wrapped.ciphertext,
            nonce: wrapped.nonce,
            senderEncryptionPublicKey: signal.senderPublicEncryptionKey,
            recipientEncryptionSecretKey: keys.encryptionSecretKey
          });

          if (!plaintext) continue;

          const payload = JSON.parse(plaintext) as {
            type: string;
            room: string;
          };

          if (payload.type === "jitsi_invite") {
            setIncomingInvite({
              fromUserId: signal.fromUserId,
              room: payload.room,
              callId: signal.callId
            });
          }
        } catch {
          // Ignore malformed payload per signal.
        }
      }
    } catch {
      // Ignore malformed signal payloads in polling loop.
    }
  }, [keys, session]);

  const refreshContacts = useCallback(async () => {
    if (!session) return;
    const remote = await listContacts(session.token);
    setContacts(remote);
    await saveContacts(remote);

    if (remote.length > 0 && !selectedContact) {
      setSelectedContact(remote[0]);
    }
  }, [selectedContact, session]);

  const bootstrap = useCallback(async () => {
    setBooting(true);
    try {
      const [cachedSession, cachedKeys, cachedContacts, cachedSentMap] = await Promise.all([
        loadAuthSession(),
        loadKeyMaterial(),
        loadContacts<Contact[]>(),
        loadSentTextCache()
      ]);

      sentTextCacheRef.current = cachedSentMap;

      if (cachedSession && cachedKeys) {
        setSession(cachedSession);
        setKeys(cachedKeys);
        if (cachedContacts) setContacts(cachedContacts);
        return;
      }

      setStatusText("Creating your private identity...");
      const generatedKeys = createKeyMaterial();
      const created = await registerIdentity({
        deviceName: `${Platform.OS}-${Platform.Version}`,
        deviceSigningPublicKey: generatedKeys.signingPublicKey,
        deviceEncryptionPublicKey: generatedKeys.encryptionPublicKey
      });

      await Promise.all([
        saveKeyMaterial(generatedKeys),
        saveAuthSession(created)
      ]);

      setKeys(generatedKeys);
      setSession(created);
      setStatusText("Identity ready");
    } catch (error) {
      Alert.alert("Initialization failed", (error as Error).message);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!session) return;
    refreshContacts().catch(() => undefined);
  }, [refreshContacts, session]);

  useEffect(() => {
    if (!session || !keys) return;

    refreshThread().catch(() => undefined);
    processSignals().catch(() => undefined);

    const timer = setInterval(() => {
      refreshThread().catch(() => undefined);
      processSignals().catch(() => undefined);
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [keys, processSignals, refreshThread, session]);

  const onAddContact = useCallback(async () => {
    if (!session || !addUserId.trim()) return;

    setBusy(true);
    try {
      const targetId = addUserId.trim();
      await lookupUser(session.token, targetId);

      const created = await addContact(session.token, {
        contactUserId: targetId,
        nickname: addNickname.trim() || undefined
      });

      const next = [created, ...contacts.filter((c) => c.contactUserId !== created.contactUserId)];
      setContacts(next);
      setSelectedContact(created);
      await saveContacts(next);

      setAddUserId("");
      setAddNickname("");
      setStatusText("Contact added");
    } catch (error) {
      Alert.alert("Failed to add contact", (error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [addNickname, addUserId, contacts, session]);

  const onSend = useCallback(async () => {
    if (!session || !keys || !selectedContact || !composer.trim()) return;

    const plaintext = composer.trim();
    setComposer("");

    const encrypted = encryptText({
      plaintext,
      recipientEncryptionPublicKey: selectedContact.encryptionPublicKey,
      senderEncryptionSecretKey: keys.encryptionSecretKey
    });

    try {
      const saved = await sendEncryptedMessage(session.token, {
        conversationId,
        recipientUserId: selectedContact.contactUserId,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce
      });

      sentTextCacheRef.current = {
        ...sentTextCacheRef.current,
        [saved.messageId]: plaintext
      };
      await saveSentTextCache(sentTextCacheRef.current);

      await refreshThread();
    } catch (error) {
      Alert.alert("Send failed", (error as Error).message);
    }
  }, [composer, conversationId, keys, refreshThread, selectedContact, session]);

  const onStartCall = useCallback(async () => {
    if (!session || !keys || !selectedContact) return;

    try {
      const { callId } = await createCallSession(session.token, selectedContact.contactUserId);
      const payload = JSON.stringify({
        type: "jitsi_invite",
        room: `privately-${callId.toLowerCase()}`
      });

      const encrypted = encryptText({
        plaintext: payload,
        recipientEncryptionPublicKey: selectedContact.encryptionPublicKey,
        senderEncryptionSecretKey: keys.encryptionSecretKey
      });

      await sendCallSignal(session.token, {
        callId,
        toUserId: selectedContact.contactUserId,
        encryptedPayload: JSON.stringify(encrypted)
      });

      setStatusText("Video invite sent");
    } catch (error) {
      Alert.alert("Call invite failed", (error as Error).message);
    }
  }, [keys, selectedContact, session]);

  const onAcceptInvite = useCallback(async () => {
    if (!incomingInvite) return;
    setIncomingInvite(null);
    await WebBrowser.openBrowserAsync(`https://meet.jit.si/${incomingInvite.room}`);
  }, [incomingInvite]);

  const resetIdentity = useCallback(async () => {
    Alert.alert(
      "Reset identity",
      "This creates a new user ID and clears local keys. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            await Promise.all([
              clearAuthSession(),
              clearKeyMaterial(),
              saveContacts([]),
              saveSentTextCache({})
            ]);
            setSession(null);
            setKeys(null);
            setContacts([]);
            setThread([]);
            sentTextCacheRef.current = {};
            await bootstrap();
          }
        }
      ]
    );
  }, [bootstrap]);

  if (booting) {
    return (
      <LinearGradient colors={["#030B1A", "#0E1E3D", "#1C2D52"]} style={styles.flex}>
        <SafeAreaView style={styles.centered}>
          <ActivityIndicator color="#f3f7ff" size="large" />
          <Text style={styles.bootText}>{statusText || "Booting secure workspace..."}</Text>
        </SafeAreaView>
        <StatusBar style="light" />
      </LinearGradient>
    );
  }

  return (
    <LinearGradient colors={["#040916", "#0A1630", "#102142"]} style={styles.flex}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.flex}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={styles.flex}
        >
          <View style={styles.headerCard}>
            <View>
              <Text style={styles.brand}>Privately</Text>
              <Text style={styles.subtitle}>Your ID: {ownUserId}</Text>
            </View>
            <Pressable onPress={resetIdentity} style={styles.ghostBtn}>
              <Text style={styles.ghostBtnText}>Reset</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Add Contact by User ID</Text>
            <TextInput
              placeholder="u_ABC..."
              placeholderTextColor="#7383a6"
              value={addUserId}
              onChangeText={setAddUserId}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              placeholder="Nickname (optional)"
              placeholderTextColor="#7383a6"
              value={addNickname}
              onChangeText={setAddNickname}
              style={styles.input}
            />
            <Pressable onPress={onAddContact} style={styles.primaryBtn} disabled={busy}>
              <Text style={styles.primaryBtnText}>{busy ? "Adding..." : "Add Contact"}</Text>
            </Pressable>
          </View>

          <View style={styles.contactsRow}>
            <FlatList
              horizontal
              data={contacts}
              keyExtractor={(item) => item.contactUserId}
              contentContainerStyle={styles.contactsList}
              renderItem={({ item }) => {
                const active = selectedContact?.contactUserId === item.contactUserId;
                return (
                  <Pressable
                    style={[styles.contactChip, active && styles.contactChipActive]}
                    onPress={() => setSelectedContact(item)}
                  >
                    <Text style={styles.contactChipLabel}>{item.nickname || item.contactUserId}</Text>
                  </Pressable>
                );
              }}
            />
          </View>

          <View style={styles.chatPanel}>
            <View style={styles.chatHeader}>
              <Text style={styles.chatTitle}>
                {selectedContact ? `Chat with ${selectedContact.nickname || selectedContact.contactUserId}` : "Select a contact"}
              </Text>
              {selectedContact ? (
                <Pressable onPress={onStartCall} style={styles.secondaryBtn}>
                  <Text style={styles.secondaryBtnText}>Video Call</Text>
                </Pressable>
              ) : null}
            </View>

            <FlatList
              data={thread}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.chatList}
              renderItem={({ item }) => (
                <View style={[styles.bubble, item.isMine ? styles.mine : styles.theirs]}>
                  <Text style={styles.bubbleText}>{item.text}</Text>
                  <Text style={styles.metaText}>{new Date(item.sentAt).toLocaleTimeString()}</Text>
                </View>
              )}
              ListEmptyComponent={<Text style={styles.emptyText}>No messages yet</Text>}
            />

            <View style={styles.composerRow}>
              <TextInput
                value={composer}
                onChangeText={setComposer}
                placeholder={selectedContact ? "Type encrypted message" : "Add a contact first"}
                placeholderTextColor="#8393b8"
                editable={Boolean(selectedContact)}
                style={styles.composerInput}
                multiline
              />
              <Pressable
                onPress={onSend}
                style={[styles.primaryBtn, styles.sendBtn]}
                disabled={!selectedContact}
              >
                <Text style={styles.primaryBtnText}>Send</Text>
              </Pressable>
            </View>
          </View>

          {statusText ? <Text style={styles.statusText}>{statusText}</Text> : null}
        </KeyboardAvoidingView>
      </SafeAreaView>

      {incomingInvite ? (
        <View style={styles.inviteOverlay}>
          <View style={styles.inviteCard}>
            <Text style={styles.inviteTitle}>Incoming Secure Call</Text>
            <Text style={styles.inviteBody}>From: {incomingInvite.fromUserId}</Text>
            <View style={styles.inviteActions}>
              <Pressable style={styles.ghostBtn} onPress={() => setIncomingInvite(null)}>
                <Text style={styles.ghostBtnText}>Decline</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={onAcceptInvite}>
                <Text style={styles.primaryBtnText}>Accept</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14
  },
  bootText: {
    color: "#dfe8ff",
    fontSize: 15
  },
  headerCard: {
    marginHorizontal: 14,
    marginTop: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.11)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  brand: {
    color: "#f2f7ff",
    fontSize: 22,
    fontWeight: "700"
  },
  subtitle: {
    marginTop: 4,
    color: "#99acd4",
    fontSize: 12
  },
  panel: {
    marginHorizontal: 14,
    marginTop: 10,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "rgba(7, 15, 33, 0.88)",
    borderWidth: 1,
    borderColor: "rgba(113, 137, 186, 0.22)",
    gap: 9
  },
  panelTitle: {
    color: "#dce7ff",
    fontWeight: "600",
    fontSize: 14
  },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.14)",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: "#eaf1ff"
  },
  primaryBtn: {
    backgroundColor: "#4b78ff",
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center"
  },
  primaryBtnText: {
    color: "#f5f8ff",
    fontWeight: "700"
  },
  secondaryBtn: {
    backgroundColor: "#1f3c74",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  secondaryBtnText: {
    color: "#d7e6ff",
    fontWeight: "600",
    fontSize: 12
  },
  ghostBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(216, 228, 255, 0.3)",
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  ghostBtnText: {
    color: "#e7efff",
    fontWeight: "600",
    fontSize: 12
  },
  contactsRow: {
    marginTop: 8,
    minHeight: 54
  },
  contactsList: {
    paddingHorizontal: 14,
    gap: 8
  },
  contactChip: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.09)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)"
  },
  contactChipActive: {
    borderColor: "#7ea4ff",
    backgroundColor: "rgba(86, 130, 255, 0.22)"
  },
  contactChipLabel: {
    color: "#edf4ff",
    fontSize: 12,
    fontWeight: "600"
  },
  chatPanel: {
    flex: 1,
    marginHorizontal: 14,
    marginVertical: 12,
    borderRadius: 18,
    backgroundColor: "rgba(6, 14, 31, 0.9)",
    borderWidth: 1,
    borderColor: "rgba(114, 139, 191, 0.24)",
    padding: 12
  },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8
  },
  chatTitle: {
    color: "#ecf4ff",
    fontSize: 13,
    fontWeight: "600",
    flex: 1
  },
  chatList: {
    paddingVertical: 8,
    gap: 8,
    flexGrow: 1
  },
  bubble: {
    maxWidth: "86%",
    borderRadius: 14,
    paddingHorizontal: 11,
    paddingVertical: 9,
    gap: 6
  },
  mine: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(76, 120, 255, 0.28)",
    borderWidth: 1,
    borderColor: "rgba(126, 164, 255, 0.5)"
  },
  theirs: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255, 255, 255, 0.09)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.16)"
  },
  bubbleText: {
    color: "#eaf1ff",
    fontSize: 14,
    lineHeight: 19
  },
  metaText: {
    color: "#9db1dc",
    fontSize: 11
  },
  emptyText: {
    marginTop: 16,
    color: "#8ea2cc",
    textAlign: "center"
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginTop: 8
  },
  composerInput: {
    flex: 1,
    minHeight: 46,
    maxHeight: 120,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "#f0f6ff",
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  sendBtn: {
    minWidth: 78,
    paddingVertical: 12
  },
  statusText: {
    color: "#afc2ea",
    textAlign: "center",
    marginBottom: 10,
    fontSize: 12
  },
  inviteOverlay: {
    position: "absolute",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20
  },
  inviteCard: {
    width: "100%",
    borderRadius: 18,
    backgroundColor: "#0d1d3a",
    borderWidth: 1,
    borderColor: "rgba(157, 188, 255, 0.5)",
    padding: 16,
    gap: 10
  },
  inviteTitle: {
    color: "#e7f0ff",
    fontWeight: "700",
    fontSize: 18
  },
  inviteBody: {
    color: "#b7caf0"
  },
  inviteActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8
  }
});
