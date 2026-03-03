import { ChangeEvent, ClipboardEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CallHistoryItem,
  Contact,
  EncryptedMessage,
  Group,
  GroupMember,
  addContact,
  clearConversation,
  clearCallHistory,
  createCallSession,
    createGroup,
    deleteContact,
    deleteMessage,
    deleteMessageByClientId,
  editMessage,
  editMessageByClientId,
    endCall,
    getCallIceServers,
    hideMessage,
  issueIdentityChallenge,
  listInbox,
  listContacts,
  listCallHistory,
  listConversation,
  listGroups,
  lookupUser,
  markConversationRead,
  pullTyping,
  pullSignals,
  registerIdentity,
  sendCallSignal,
  sendMessage,
  sendMessageBatch,
  sendTyping,
  updateContact,
  verifyIdentityChallenge
} from "./services/api";
import { KeyMaterial, decryptPayload, encryptPayload, generateKeys, signMessage } from "./services/crypto";
import {
  Session,
  clearAll,
  loadContacts,
  loadGroups,
  loadKeys,
  loadSentCache,
  loadSession,
  saveContacts,
  saveGroups,
  saveKeys,
  saveSentCache,
  saveSession
} from "./services/storage";

type MessagePayload =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; caption?: string }
  | { type: "gif"; url: string }
  | { type: "audio"; dataUrl: string; durationMs: number }
  | { type: "file"; name: string; mime: string; dataUrl: string; sizeBytes: number; caption?: string };

type UiMessage = {
  id: string;
  clientMessageId: string | null;
  conversationId: string;
  senderUserId: string;
  senderLabel: string;
  mine: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  readAt: string | null;
  recipientCount: number;
  readCount: number;
  sentAt: string;
  payload: MessagePayload;
};

type TimelineItem =
  | { kind: "message"; id: string; at: string; message: UiMessage }
  | { kind: "call"; id: string; at: string; call: CallHistoryItem };

type GifResult = {
  id: string;
  url: string;
  preview: string;
  title: string;
};

type GifProvider = "giphy" | "tenor";

type PendingAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  sizeBytes: number;
  dataUrl: string;
};

type ContactRequest = {
  userId: string;
  label: string;
  senderPublicKey: string;
  preview: string;
  receivedAt: string;
  messageIds: string[];
};

type ChatTarget =
  | {
      kind: "contact";
      id: string;
      title: string;
      subtitle: string;
      encryptionPublicKey: string;
    }
  | {
      kind: "group";
      id: string;
      title: string;
      subtitle: string;
      members: GroupMember[];
    };

type CallMode = "audio" | "video";

type IncomingCall = {
  callId: string;
  fromUserId: string;
  fromLabel: string;
  senderPublicKey: string;
  mode: CallMode;
};

type ActiveCall = {
  callId: string;
  peerUserId: string;
  peerLabel: string;
  peerPublicKey: string;
  mode: CallMode;
  status: "ringing" | "connecting" | "active";
  incoming: boolean;
};

type CallQuality = "unknown" | "excellent" | "good" | "poor";

type MessageMenuState = {
  message: UiMessage;
  x: number;
  y: number;
};

type MediaPreviewKind = "image" | "audio" | "video" | "document" | "unsupported";

type MediaViewerState = {
  src: string;
  mime: string;
  title: string;
  downloadName: string;
  previewKind: MediaPreviewKind;
  caption?: string;
};

type CallSignalPayload =
  | { type: "call_invite"; mode: CallMode }
  | { type: "call_accept"; mode: CallMode }
  | { type: "call_reject" }
  | { type: "call_end" }
  | { type: "webrtc_offer"; sdp: RTCSessionDescriptionInit }
  | { type: "webrtc_answer"; sdp: RTCSessionDescriptionInit }
  | { type: "webrtc_ice"; candidate: RTCIceCandidateInit };

type DecodedSignal = {
  callId: string;
  fromUserId: string;
  senderPublicEncryptionKey: string;
  payload: CallSignalPayload;
  receivedAtMs: number;
};

const BASE_SYNC_POLL_MS = 2500;
const SIGNAL_POLL_IDLE_MS = 1400;
const SIGNAL_POLL_ACTIVE_MS = 650;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const TYPING_PULSE_MS = 2000;
const GIF_LIMIT = 18;
const GIF_API_KEY = (import.meta.env.VITE_GIPHY_API_KEY as string | undefined) ?? "dc6zaTOxFJmzC";
const TENOR_API_KEY = (import.meta.env.VITE_TENOR_API_KEY as string | undefined) ?? "LIVDSRZULELA";
const CALL_RING_TIMEOUT_MS = 45_000;
const CALL_RESTART_COOLDOWN_MS = 3_500;
const CALL_DISCONNECT_GRACE_MS = 4_000;
const CALL_AUDIO_MAX_BITRATE_BPS = 96_000;
const CALL_VIDEO_MIN_BITRATE_BPS = 320_000;
const CALL_VIDEO_START_BITRATE_BPS = 1_200_000;
const CALL_VIDEO_MAX_BITRATE_BPS = 2_800_000;
const SIGNAL_QUEUE_TTL_MS = 20_000;
const SIGNAL_QUEUE_MAX = 256;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type IdentityBackup = {
  version: 1;
  exportedAt: string;
  session: {
    userId: string;
    deviceId: string;
  };
  keys: KeyMaterial;
};

function makeClientMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `cm_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function sortedConversationId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

function parseMessagePayload(raw: string): MessagePayload {
  try {
    const parsed = JSON.parse(raw) as Partial<MessagePayload>;
    if (parsed.type === "text" && typeof parsed.text === "string") {
      return { type: "text", text: parsed.text };
    }

    if (parsed.type === "image" && typeof parsed.dataUrl === "string") {
      return {
        type: "image",
        dataUrl: parsed.dataUrl,
        caption: typeof parsed.caption === "string" ? parsed.caption : undefined
      };
    }

    if (parsed.type === "gif" && typeof parsed.url === "string") {
      return { type: "gif", url: parsed.url };
    }

    if (parsed.type === "audio" && typeof parsed.dataUrl === "string") {
      return {
        type: "audio",
        dataUrl: parsed.dataUrl,
        durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0
      };
    }

    if (
      parsed.type === "file" &&
      typeof parsed.dataUrl === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.mime === "string"
    ) {
      return {
        type: "file",
        name: parsed.name,
        mime: parsed.mime,
        dataUrl: parsed.dataUrl,
        sizeBytes: typeof parsed.sizeBytes === "number" ? parsed.sizeBytes : 0,
        caption: typeof parsed.caption === "string" ? parsed.caption : undefined
      };
    }
  } catch {
    // fallback below
  }

  return { type: "text", text: raw };
}

function payloadPreview(payload: MessagePayload): string {
  if (payload.type === "text") return payload.text;
  if (payload.type === "image") return payload.caption ? `[Photo] ${payload.caption}` : "[Photo]";
  if (payload.type === "gif") return "[GIF]";
  if (payload.type === "audio") return "[Voice message]";
  return payload.caption ? `[File] ${payload.name} · ${payload.caption}` : `[File] ${payload.name}`;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchGiphyGifs(query: string): Promise<GifResult[]> {
  const endpoint = query === "trending"
    ? `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(GIF_API_KEY)}&limit=${GIF_LIMIT}&rating=pg`
    : `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(GIF_API_KEY)}&q=${encodeURIComponent(query)}&limit=${GIF_LIMIT}&rating=pg&lang=en`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Giphy HTTP ${response.status}`);
  }

  const parsed = await response.json() as {
    data?: Array<{
      id: string;
      title: string;
      images?: {
        fixed_width_small?: { url?: string };
        original?: { url?: string };
      };
    }>;
    meta?: { msg?: string };
  };

  if (!Array.isArray(parsed.data)) {
    throw new Error(parsed.meta?.msg || "Invalid Giphy response");
  }

  return parsed.data.map((item) => ({
    id: item.id,
    title: item.title || "GIF",
    preview: item.images?.fixed_width_small?.url || item.images?.original?.url || "",
    url: item.images?.original?.url || ""
  })).filter((item) => item.preview && item.url);
}

async function fetchTenorGifs(query: string): Promise<GifResult[]> {
  const endpoint = query === "trending"
    ? `https://g.tenor.com/v1/trending?key=${encodeURIComponent(TENOR_API_KEY)}&limit=${GIF_LIMIT}&contentfilter=medium&media_filter=minimal`
    : `https://g.tenor.com/v1/search?key=${encodeURIComponent(TENOR_API_KEY)}&q=${encodeURIComponent(query)}&limit=${GIF_LIMIT}&contentfilter=medium&media_filter=minimal`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Tenor HTTP ${response.status}`);
  }

  const parsed = await response.json() as {
    results?: Array<{
      id: string;
      title?: string;
      media?: Array<{
        tinygif?: { url?: string };
        nanogif?: { url?: string };
        gif?: { url?: string };
      }>;
    }>;
  };

  if (!Array.isArray(parsed.results)) {
    throw new Error("Invalid Tenor response");
  }

  return parsed.results.map((item) => {
    const media = item.media?.[0];
    const preview = media?.tinygif?.url || media?.nanogif?.url || media?.gif?.url || "";
    const url = media?.gif?.url || preview;
    return {
      id: item.id,
      title: item.title || "GIF",
      preview,
      url
    };
  }).filter((item) => item.preview && item.url);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to encode audio"));
    reader.readAsDataURL(blob);
  });
}

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const mins = Math.floor(safe / 60).toString().padStart(2, "0");
  const secs = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function makeInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function callStatusLabel(call: ActiveCall): string {
  if (call.status === "active") return "Live";
  if (call.status === "connecting") return "Connecting";
  if (call.incoming) return "Incoming";
  return "Ringing";
}

function qualityLabel(quality: CallQuality): string {
  if (quality === "excellent") return "Excellent";
  if (quality === "good") return "Good";
  if (quality === "poor") return "Unstable";
  return "Checking";
}

type MutableRtpEncoding = RTCRtpEncodingParameters & {
  priority?: RTCPriorityType;
  networkPriority?: RTCPriorityType;
};

type MutableRtpParameters = RTCRtpSendParameters & {
  encodings?: MutableRtpEncoding[];
  degradationPreference?: RTCDegradationPreference;
};

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  return fallback;
}

function parseNumberEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.round(next)));
}

function parseIceServersFromEnv(): RTCIceServer[] {
  const json = (import.meta.env.VITE_ICE_SERVERS_JSON as string | undefined)?.trim();
  if (json) {
    try {
      const parsed = JSON.parse(json) as RTCIceServer[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((server) => {
          if (!server || typeof server !== "object") return false;
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some((url) => typeof url === "string" && url.trim().length > 0);
        });
      }
    } catch {
      // fall back to default + TURN env settings.
    }
  }

  const defaults: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ];
  const turnUrlsRaw = (import.meta.env.VITE_TURN_URLS as string | undefined) ?? "";
  const turnUrls = turnUrlsRaw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (turnUrls.length === 0) {
    return defaults;
  }

  defaults.push({
    urls: turnUrls,
    username: (import.meta.env.VITE_TURN_USERNAME as string | undefined) ?? "",
    credential: (import.meta.env.VITE_TURN_CREDENTIAL as string | undefined) ?? ""
  });
  return defaults;
}

const CALL_FORCE_RELAY = parseBooleanFlag(import.meta.env.VITE_CALL_FORCE_RELAY as string | undefined, false);
const CALL_ICE_SERVERS = parseIceServersFromEnv();
const CALL_VIDEO_MIN_TARGET_BPS = parseNumberEnv(
  import.meta.env.VITE_CALL_VIDEO_MIN_BITRATE_BPS as string | undefined,
  CALL_VIDEO_MIN_BITRATE_BPS,
  120_000,
  2_000_000
);
const CALL_VIDEO_START_TARGET_BPS = parseNumberEnv(
  import.meta.env.VITE_CALL_VIDEO_START_BITRATE_BPS as string | undefined,
  CALL_VIDEO_START_BITRATE_BPS,
  CALL_VIDEO_MIN_TARGET_BPS,
  3_500_000
);
const CALL_VIDEO_MAX_TARGET_BPS = parseNumberEnv(
  import.meta.env.VITE_CALL_VIDEO_MAX_BITRATE_BPS as string | undefined,
  CALL_VIDEO_MAX_BITRATE_BPS,
  CALL_VIDEO_START_TARGET_BPS,
  6_000_000
);

function callMediaConstraints(mode: CallMode): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1, max: 2 },
      sampleRate: { ideal: 48_000 },
      sampleSize: { ideal: 16 }
    },
    video: mode === "video"
      ? {
          width: { min: 640, ideal: 1280, max: 1920 },
          height: { min: 360, ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 },
          facingMode: "user"
        }
      : false
  };
}

function orderedCodecs(kind: "audio" | "video", capabilities: RTCRtpCapabilities): RTCRtpCodec[] {
  const preference = kind === "video"
    ? ["video/AV1", "video/VP9", "video/H264", "video/VP8"]
    : ["audio/opus", "audio/ISAC", "audio/G722", "audio/PCMU", "audio/PCMA"];

  const scored = capabilities.codecs
    .filter((codec) => !codec.mimeType.toLowerCase().includes("rtx") && !codec.mimeType.toLowerCase().includes("red"))
    .map((codec) => {
      const normalized = codec.mimeType.toUpperCase();
      const index = preference.findIndex((entry) => entry.toUpperCase() === normalized);
      return { codec, rank: index === -1 ? preference.length + 1 : index };
    });

  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((entry) => entry.codec);
}

function applyCodecPreferences(pc: RTCPeerConnection, mode: CallMode) {
  if (typeof RTCRtpReceiver === "undefined" || typeof RTCRtpReceiver.getCapabilities !== "function") {
    return;
  }

  const audioCaps = RTCRtpReceiver.getCapabilities("audio");
  const videoCaps = RTCRtpReceiver.getCapabilities("video");

  for (const transceiver of pc.getTransceivers()) {
    const kind = transceiver.sender.track?.kind;
    if (!kind) continue;
    if (kind === "video" && mode !== "video") continue;
    if (kind === "audio" && audioCaps) {
      transceiver.setCodecPreferences(orderedCodecs("audio", audioCaps));
    }
    if (kind === "video" && videoCaps) {
      transceiver.setCodecPreferences(orderedCodecs("video", videoCaps));
    }
  }
}

async function tuneSenderForCall(sender: RTCRtpSender, mode: CallMode, videoTargetBps: number): Promise<void> {
  const track = sender.track;
  if (!track) return;

  const params = sender.getParameters() as MutableRtpParameters;
  const encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{}];

  if (track.kind === "audio") {
    encodings[0].maxBitrate = CALL_AUDIO_MAX_BITRATE_BPS;
    encodings[0].priority = "high";
    encodings[0].networkPriority = "high";
  } else if (track.kind === "video" && mode === "video") {
    encodings[0].maxBitrate = videoTargetBps;
    encodings[0].maxFramerate = 30;
    encodings[0].priority = "high";
    encodings[0].networkPriority = "high";
    params.degradationPreference = "maintain-framerate";
  }

  params.encodings = encodings;
  await sender.setParameters(params).catch(() => undefined);
}

type HeaderActionButtonProps = {
  title: string;
  children: ReactNode;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
};

function HeaderActionButton({
  title,
  children,
  onClick,
  danger,
  active,
  disabled,
  badge
}: HeaderActionButtonProps) {
  return (
    <button
      className={`header-icon-btn ${danger ? "danger" : ""} ${active ? "active" : ""}`}
      onClick={() => {
        void onClick();
      }}
      title={title}
      aria-label={title}
      disabled={disabled}
    >
      {children}
      {typeof badge === "number" && badge > 0 ? <span className="btn-badge">{badge}</span> : null}
      <span className="sr-only">{title}</span>
    </button>
  );
}

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x, y };
  const width = 198;
  const height = 162;
  return {
    x: Math.max(10, Math.min(x, window.innerWidth - width)),
    y: Math.max(10, Math.min(y, window.innerHeight - height))
  };
}

function canEditMessageContent(message: UiMessage): boolean {
  if (!message.mine || Boolean(message.deletedAt)) return false;
  return message.payload.type === "text" || message.payload.type === "image" || message.payload.type === "gif";
}

function inferMediaPreviewKind(mime: string, src: string): MediaPreviewKind {
  const normalizedMime = mime.toLowerCase();
  const normalizedSrc = src.toLowerCase();
  if (normalizedMime.startsWith("image/")) return "image";
  if (normalizedMime.startsWith("audio/")) return "audio";
  if (normalizedMime.startsWith("video/")) return "video";
  if (
    normalizedMime === "application/pdf" ||
    normalizedMime.startsWith("text/") ||
    normalizedMime.includes("json") ||
    normalizedMime.includes("xml")
  ) {
    return "document";
  }

  if (normalizedSrc.startsWith("data:image/")) return "image";
  if (normalizedSrc.startsWith("data:audio/")) return "audio";
  if (normalizedSrc.startsWith("data:video/")) return "video";
  if (normalizedSrc.startsWith("data:application/pdf")) return "document";

  if (normalizedSrc.includes(".gif") || normalizedSrc.includes("giphy.com") || normalizedSrc.includes("tenor.com")) {
    return "image";
  }

  return "unsupported";
}

function pruneSignalQueue(queue: DecodedSignal[]): DecodedSignal[] {
  const cutoff = Date.now() - SIGNAL_QUEUE_TTL_MS;
  const fresh = queue.filter((item) => item.receivedAtMs >= cutoff);
  if (fresh.length <= SIGNAL_QUEUE_MAX) return fresh;
  return fresh.slice(fresh.length - SIGNAL_QUEUE_MAX);
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [keys, setKeys] = useState<KeyMaterial | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("Initializing secure workspace...");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedChat, setSelectedChat] = useState<ChatTarget | null>(null);
  const [search, setSearch] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);

  const [contactUserIdInput, setContactUserIdInput] = useState("");
  const [contactNicknameInput, setContactNicknameInput] = useState("");
  const [groupNameInput, setGroupNameInput] = useState("");
  const [groupMembersInput, setGroupMembersInput] = useState<string[]>([]);
  const [showContactForm, setShowContactForm] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);

  const [composer, setComposer] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [gifQuery, setGifQuery] = useState("trending");
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifProvider, setGifProvider] = useState<GifProvider>("giphy");
  const [gifError, setGifError] = useState("");
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    () => ("Notification" in window ? Notification.permission : "default")
  );
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [contactRequests, setContactRequests] = useState<ContactRequest[]>([]);
  const [messageMenu, setMessageMenu] = useState<MessageMenuState | null>(null);
  const [mediaViewer, setMediaViewer] = useState<MediaViewerState | null>(null);

  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callVideoOff, setCallVideoOff] = useState(false);
  const [callDurationSec, setCallDurationSec] = useState(0);
  const [callQuality, setCallQuality] = useState<CallQuality>("unknown");
  const [remoteVideoReady, setRemoteVideoReady] = useState(false);
  const [localVideoReady, setLocalVideoReady] = useState(false);

  const sentPayloadCacheRef = useRef<Record<string, string>>({});
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const backupInputRef = useRef<HTMLInputElement | null>(null);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaRecordChunksRef = useRef<Blob[]>([]);
  const mediaRecordStartRef = useRef<number>(0);
  const mediaRecordTimerRef = useRef<number | null>(null);
  const lastTypingPulseRef = useRef<number>(0);
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const inboxCursorRef = useRef<string | undefined>(undefined);
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const callStartAtRef = useRef<number | null>(null);
  const callDurationTimerRef = useRef<number | null>(null);
  const outgoingRingTimeoutRef = useRef<number | null>(null);
  const lastRestartAttemptAtRef = useRef<number>(0);
  const disconnectRecoveryTimerRef = useRef<number | null>(null);
  const adaptiveVideoBitrateRef = useRef<number>(CALL_VIDEO_START_TARGET_BPS);
  const lastVideoBytesSentRef = useRef<number | null>(null);
  const lastVideoTimestampMsRef = useRef<number | null>(null);
  const processingSignalsRef = useRef(false);
  const pendingSignalQueueRef = useRef<DecodedSignal[]>([]);
  const callIceCacheRef = useRef<{ expiresAtMs: number; iceServers: RTCIceServer[] } | null>(null);

  const ownUserId = session?.userId ?? "";

  const contactByUserId = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const contact of contacts) {
      map.set(contact.contactUserId, contact);
    }
    return map;
  }, [contacts]);

  const keyByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const contact of contacts) {
      map.set(contact.contactUserId, contact.encryptionPublicKey);
    }

    for (const group of groups) {
      for (const member of group.members) {
        map.set(member.userId, member.encryptionPublicKey);
      }
    }

    return map;
  }, [contacts, groups]);

  const chatTargets = useMemo<ChatTarget[]>(() => {
    const normalizedSearch = search.trim().toLowerCase();

    const contactTargets: ChatTarget[] = contacts.map((contact) => ({
      kind: "contact",
      id: contact.contactUserId,
      title: contact.nickname || contact.contactUserId,
      subtitle: contact.contactUserId,
      encryptionPublicKey: contact.encryptionPublicKey
    }));

    const groupTargets: ChatTarget[] = groups.map((group) => ({
      kind: "group",
      id: group.groupId,
      title: group.name,
      subtitle: `${group.members.length} members`,
      members: group.members
    }));

    const allTargets = [...contactTargets, ...groupTargets];
    if (!normalizedSearch) return allTargets;

    return allTargets.filter((target) => {
      const hay = `${target.title} ${target.subtitle}`.toLowerCase();
      return hay.includes(normalizedSearch);
    });
  }, [contacts, groups, search]);

  const selectedConversationId = useMemo(() => {
    if (!selectedChat || !session) return "";
    if (selectedChat.kind === "group") return selectedChat.id;
    return sortedConversationId(session.userId, selectedChat.id);
  }, [selectedChat, session]);

  const typingRecipientUserIds = useMemo(() => {
    if (!selectedChat || !session) return [];
    if (selectedChat.kind === "contact") return [selectedChat.id];
    return selectedChat.members
      .map((member) => member.userId)
      .filter((memberId) => memberId !== session.userId);
  }, [selectedChat, session]);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    setContactRequests((current) => current.filter((item) => (
      item.userId !== ownUserId && !contactByUserId.has(item.userId)
    )));
  }, [contactByUserId, ownUserId]);

  const activeCallStatusLabel = useMemo(() => {
    if (!activeCall) return "";
    return callStatusLabel(activeCall);
  }, [activeCall]);

  const activeCallQualityLabel = useMemo(() => qualityLabel(callQuality), [callQuality]);
  const signalPollMs = useMemo(() => (
    activeCall || incomingCall ? SIGNAL_POLL_ACTIVE_MS : SIGNAL_POLL_IDLE_MS
  ), [activeCall, incomingCall]);

  const resolveUserLabel = useCallback((userId: string): string => {
    if (session && userId === session.userId) return "You";
    const contact = contactByUserId.get(userId);
    if (contact) return contact.nickname || contact.contactUserId;
    return userId;
  }, [contactByUserId, session]);

  const upsertContactRequest = useCallback((input: {
    userId: string;
    senderPublicKey: string;
    preview: string;
    receivedAt: string;
    messageId: string;
  }) => {
    if (input.userId === ownUserId) return;
    if (contactByUserId.has(input.userId)) return;

    setContactRequests((current) => {
      const existing = current.find((item) => item.userId === input.userId);
      if (!existing) {
        return [{
          userId: input.userId,
          label: resolveUserLabel(input.userId),
          senderPublicKey: input.senderPublicKey,
          preview: input.preview,
          receivedAt: input.receivedAt,
          messageIds: [input.messageId]
        }, ...current];
      }

      const messageIds = existing.messageIds.includes(input.messageId)
        ? existing.messageIds
        : [...existing.messageIds, input.messageId];

      const next = current.map((item) => (
        item.userId === input.userId
          ? {
              ...item,
              preview: input.preview || item.preview,
              senderPublicKey: input.senderPublicKey || item.senderPublicKey,
              receivedAt: Date.parse(input.receivedAt) > Date.parse(item.receivedAt) ? input.receivedAt : item.receivedAt,
              messageIds
            }
          : item
      ));

      return next.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    });
  }, [contactByUserId, ownUserId, resolveUserLabel]);

  const decodeConversation = useCallback((items: EncryptedMessage[]): UiMessage[] => {
    if (!session || !keys) return [];

    const byKey = new Map<string, UiMessage>();

    for (const item of items) {
      const mine = item.senderUserId === session.userId;
      const dedupeKey = mine && item.clientMessageId ? `mine:${item.clientMessageId}` : `row:${item.messageId}`;
      let payload: MessagePayload;

      if (item.deletedAt) {
        payload = { type: "text", text: "This message was deleted" };
      } else if (mine) {
        const cacheKey = item.clientMessageId ?? item.messageId;
        const cached = sentPayloadCacheRef.current[cacheKey];
        payload = cached
          ? parseMessagePayload(cached)
          : { type: "text", text: item.editedAt ? "Edited message from another device" : "Sent message from another device" };
      } else {
        const plain = decryptPayload({
          ciphertext: item.ciphertext,
          nonce: item.nonce,
          senderPublicKey: item.senderPublicEncryptionKey,
          recipientSecretKey: keys.encryptionSecretKey
        });

        payload = plain ? parseMessagePayload(plain) : { type: "text", text: "Unable to decrypt message" };
      }

      const existing = byKey.get(dedupeKey);
      if (existing) {
        existing.recipientCount += 1;
        if (item.readAt) {
          existing.readCount += 1;
          existing.readAt = existing.readAt ?? item.readAt;
        }
        if (!existing.deletedAt && item.deletedAt) {
          existing.deletedAt = item.deletedAt;
          existing.payload = { type: "text", text: "This message was deleted" };
        }
        if (!existing.editedAt && item.editedAt) {
          existing.editedAt = item.editedAt;
        }
        continue;
      }

      byKey.set(dedupeKey, {
        id: item.messageId,
        clientMessageId: item.clientMessageId ?? null,
        conversationId: item.conversationId,
        senderUserId: item.senderUserId,
        senderLabel: resolveUserLabel(item.senderUserId),
        mine,
        editedAt: item.editedAt ?? null,
        deletedAt: item.deletedAt ?? null,
        readAt: item.readAt ?? null,
        recipientCount: 1,
        readCount: item.readAt ? 1 : 0,
        sentAt: item.sentAt,
        payload
      });
    }

    return Array.from(byKey.values()).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
  }, [keys, resolveUserLabel, session]);

  const refreshContacts = useCallback(async () => {
    if (!session) return;
    const items = await listContacts(session.token);
    setContacts(items);
    saveContacts(items);
  }, [session]);

  const refreshGroups = useCallback(async () => {
    if (!session) return;
    const items = await listGroups(session.token);
    setGroups(items);
    saveGroups(items);
  }, [session]);

  const refreshCallHistory = useCallback(async () => {
    if (!session || !selectedChat || selectedChat.kind !== "contact") {
      setCallHistory([]);
      return;
    }
    const items = await listCallHistory(session.token, selectedChat.id);
    setCallHistory(items);
  }, [selectedChat, session]);

  const refreshConversation = useCallback(async () => {
    if (!session || !keys || !selectedConversationId) return;
    await markConversationRead(session.token, selectedConversationId).catch(() => undefined);
    const items = await listConversation(session.token, selectedConversationId);
    const decoded = decodeConversation(items);
    setMessages(decoded);

    const typing = await pullTyping(session.token, selectedConversationId).catch(() => []);
    setTypingUsers(typing.map((item) => item.fromUserId));

    if (notificationPermission === "granted") {
      const now = Date.now();
      for (const message of decoded) {
        if (message.mine) {
          knownMessageIdsRef.current.add(message.id);
          continue;
        }

        const known = knownMessageIdsRef.current.has(message.id);
        knownMessageIdsRef.current.add(message.id);
        if (known) continue;
        if ((now - Date.parse(message.sentAt)) > 15_000) continue;

        if (document.hidden || !selectedChat) {
          new Notification(`${message.senderLabel}`, {
            body: payloadPreview(message.payload),
            tag: `msg-${message.id}`
          });
        }
      }
    }
  }, [decodeConversation, keys, notificationPermission, selectedChat, selectedConversationId, session]);

  const pollInboxNotifications = useCallback(async () => {
    if (!session || !keys) return;

    const inbox = await listInbox(session.token, inboxCursorRef.current);
    if (inbox.length === 0) return;

    inboxCursorRef.current = inbox[inbox.length - 1]?.sentAt ?? inboxCursorRef.current;

    for (const item of inbox) {
      if (item.senderUserId === session.userId) continue;
      if (item.deletedAt) continue;
      if (knownMessageIdsRef.current.has(item.messageId)) continue;

      knownMessageIdsRef.current.add(item.messageId);

      const plain = decryptPayload({
        ciphertext: item.ciphertext,
        nonce: item.nonce,
        senderPublicKey: item.senderPublicEncryptionKey,
        recipientSecretKey: keys.encryptionSecretKey
      });
      if (!plain) continue;

      const payload = parseMessagePayload(plain);
      const preview = payloadPreview(payload);
      const directConversationId = sortedConversationId(session.userId, item.senderUserId);
      if (!contactByUserId.has(item.senderUserId) && item.conversationId === directConversationId) {
        upsertContactRequest({
          userId: item.senderUserId,
          senderPublicKey: item.senderPublicEncryptionKey,
          preview,
          receivedAt: item.sentAt,
          messageId: item.messageId
        });
      }

      if (notificationPermission === "granted") {
        new Notification(resolveUserLabel(item.senderUserId), {
          body: preview,
          tag: `inbox-${item.messageId}`
        });
      }
    }
  }, [contactByUserId, keys, notificationPermission, resolveUserLabel, session, upsertContactRequest]);

  const sendEncryptedSignal = useCallback(async (input: {
    toUserId: string;
    toPublicKey: string;
    callId: string;
    payload: CallSignalPayload;
  }) => {
    if (!session || !keys) return;

    const encrypted = encryptPayload(
      JSON.stringify(input.payload),
      input.toPublicKey,
      keys.encryptionSecretKey
    );

    await sendCallSignal(session.token, {
      callId: input.callId,
      toUserId: input.toUserId,
      encryptedPayload: JSON.stringify(encrypted)
    });
  }, [keys, session]);

  const resolveCallIceServers = useCallback(async (): Promise<RTCIceServer[]> => {
    const cached = callIceCacheRef.current;
    if (cached && cached.expiresAtMs > (Date.now() + 15_000)) {
      return cached.iceServers;
    }

    if (!session) {
      return CALL_ICE_SERVERS;
    }

    try {
      const result = await getCallIceServers(session.token);
      if (!Array.isArray(result.iceServers) || result.iceServers.length === 0) {
        return CALL_ICE_SERVERS;
      }
      const ttlMs = Math.max(60_000, Math.min(86_400_000, (result.ttlSeconds || 600) * 1000));
      callIceCacheRef.current = {
        iceServers: result.iceServers,
        expiresAtMs: Date.now() + ttlMs
      };
      return result.iceServers;
    } catch {
      return CALL_ICE_SERVERS;
    }
  }, [session]);

  const flushPendingIceCandidates = useCallback(async () => {
    const pc = peerConnectionRef.current;
    if (!pc || !pc.remoteDescription) return;

    if (pendingIceCandidatesRef.current.length === 0) return;
    const queued = [...pendingIceCandidatesRef.current];
    pendingIceCandidatesRef.current = [];

    for (const candidate of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => undefined);
    }
  }, []);

  const restartCallTransport = useCallback(async (reason: "manual" | "auto") => {
    const call = activeCallRef.current;
    const pc = peerConnectionRef.current;
    if (!call || !pc) return;

    const now = Date.now();
    if ((now - lastRestartAttemptAtRef.current) < CALL_RESTART_COOLDOWN_MS) {
      return;
    }
    lastRestartAttemptAtRef.current = now;

    try {
      applyCodecPreferences(pc, call.mode);
      await Promise.all(pc.getSenders().map((sender) => (
        tuneSenderForCall(sender, call.mode, adaptiveVideoBitrateRef.current)
      )));
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await sendEncryptedSignal({
        toUserId: call.peerUserId,
        toPublicKey: call.peerPublicKey,
        callId: call.callId,
        payload: { type: "webrtc_offer", sdp: offer }
      });
      setStatus(reason === "manual" ? "Reconnecting call..." : "Connection unstable, recovering...");
      setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
    } catch (error) {
      setStatus(`Reconnect failed: ${(error as Error).message}`);
    }
  }, [sendEncryptedSignal]);

  const cleanupCall = useCallback((sendEndSignal: boolean) => {
    (async () => {
      if (activeCall && session) {
        await endCall(session.token, activeCall.callId).catch(() => undefined);
      }

      if (sendEndSignal && activeCall && session && keys) {
        try {
          await sendEncryptedSignal({
            toUserId: activeCall.peerUserId,
            toPublicKey: activeCall.peerPublicKey,
            callId: activeCall.callId,
            payload: { type: "call_end" }
          });
        } catch {
          // Best-effort signal.
        }
      }

      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
        localStreamRef.current = null;
      }

      if (remoteStreamRef.current) {
        for (const track of remoteStreamRef.current.getTracks()) {
          track.stop();
        }
        remoteStreamRef.current = null;
      }

      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

      if (callDurationTimerRef.current) {
        window.clearInterval(callDurationTimerRef.current);
        callDurationTimerRef.current = null;
      }
      if (outgoingRingTimeoutRef.current) {
        window.clearTimeout(outgoingRingTimeoutRef.current);
        outgoingRingTimeoutRef.current = null;
      }
      if (disconnectRecoveryTimerRef.current) {
        window.clearTimeout(disconnectRecoveryTimerRef.current);
        disconnectRecoveryTimerRef.current = null;
      }
      callStartAtRef.current = null;
      pendingIceCandidatesRef.current = [];
      lastRestartAttemptAtRef.current = 0;
      adaptiveVideoBitrateRef.current = CALL_VIDEO_START_TARGET_BPS;
      lastVideoBytesSentRef.current = null;
      lastVideoTimestampMsRef.current = null;
      pendingSignalQueueRef.current = [];

      setActiveCall(null);
      setIncomingCall(null);
      setCallMuted(false);
      setCallVideoOff(false);
      setCallDurationSec(0);
      setCallQuality("unknown");
      setRemoteVideoReady(false);
      setLocalVideoReady(false);
      await refreshCallHistory().catch(() => undefined);
    })().catch(() => undefined);
  }, [activeCall, keys, refreshCallHistory, sendEncryptedSignal, session]);

  const setupPeerConnection = useCallback(async (params: {
    callId: string;
    toUserId: string;
    toPublicKey: string;
    mode: CallMode;
  }) => {
    peerConnectionRef.current?.close();
    pendingIceCandidatesRef.current = [];
    adaptiveVideoBitrateRef.current = CALL_VIDEO_START_TARGET_BPS;
    lastVideoBytesSentRef.current = null;
    lastVideoTimestampMsRef.current = null;
    if (disconnectRecoveryTimerRef.current) {
      window.clearTimeout(disconnectRecoveryTimerRef.current);
      disconnectRecoveryTimerRef.current = null;
    }
    setRemoteVideoReady(false);
    setLocalVideoReady(false);
    const runtimeIceServers = await resolveCallIceServers();

    const pc = new RTCPeerConnection({
      iceServers: runtimeIceServers.length > 0 ? runtimeIceServers : CALL_ICE_SERVERS,
      iceTransportPolicy: CALL_FORCE_RELAY ? "relay" : "all",
      iceCandidatePoolSize: 10,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendEncryptedSignal({
        toUserId: params.toUserId,
        toPublicKey: params.toPublicKey,
        callId: params.callId,
        payload: { type: "webrtc_ice", candidate: event.candidate.toJSON() }
      }).catch(() => undefined);
    };

    pc.ontrack = (event) => {
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream();
      }

      remoteStreamRef.current.addTrack(event.track);
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStreamRef.current;
        remoteAudioRef.current.play().catch(() => undefined);
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
        remoteVideoRef.current.play().catch(() => undefined);
      }

      if (event.track.kind === "video") {
        setRemoteVideoReady(true);
        event.track.onended = () => setRemoteVideoReady(false);
      }

      setActiveCall((prev) => (prev ? { ...prev, status: "active" } : prev));
      if (!callStartAtRef.current) {
        callStartAtRef.current = Date.now();
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const scheduleRecovery = () => {
        if (disconnectRecoveryTimerRef.current) return;
        disconnectRecoveryTimerRef.current = window.setTimeout(() => {
          disconnectRecoveryTimerRef.current = null;
          const currentPc = peerConnectionRef.current;
          if (!currentPc) return;
          if (currentPc.connectionState === "connected" || currentPc.iceConnectionState === "connected" || currentPc.iceConnectionState === "completed") {
            return;
          }
          setStatus("Recovering call connection...");
          setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
          restartCallTransport("auto").catch(() => undefined);
        }, CALL_DISCONNECT_GRACE_MS);
      };
      const clearRecoveryTimer = () => {
        if (!disconnectRecoveryTimerRef.current) return;
        window.clearTimeout(disconnectRecoveryTimerRef.current);
        disconnectRecoveryTimerRef.current = null;
      };

      if (state === "connected") {
        clearRecoveryTimer();
        setActiveCall((prev) => (prev ? { ...prev, status: "active" } : prev));
        if (!callStartAtRef.current) {
          callStartAtRef.current = Date.now();
        }
      } else if (state === "connecting") {
        setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
      } else if (state === "disconnected") {
        setStatus("Call connection unstable");
        setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
        scheduleRecovery();
      } else if (state === "failed") {
        clearRecoveryTimer();
        setStatus("Call connection failed, retrying...");
        setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
        restartCallTransport("auto").catch(() => undefined);
      } else if (state === "closed") {
        clearRecoveryTimer();
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "connected" || state === "completed") {
        if (disconnectRecoveryTimerRef.current) {
          window.clearTimeout(disconnectRecoveryTimerRef.current);
          disconnectRecoveryTimerRef.current = null;
        }
        return;
      }
      if (state === "failed") {
        if (disconnectRecoveryTimerRef.current) {
          window.clearTimeout(disconnectRecoveryTimerRef.current);
          disconnectRecoveryTimerRef.current = null;
        }
        restartCallTransport("auto").catch(() => undefined);
        return;
      }
      if (state === "disconnected" && !disconnectRecoveryTimerRef.current) {
        disconnectRecoveryTimerRef.current = window.setTimeout(() => {
          disconnectRecoveryTimerRef.current = null;
          restartCallTransport("auto").catch(() => undefined);
        }, CALL_DISCONNECT_GRACE_MS);
      }
    };

    let localStream: MediaStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia(callMediaConstraints(params.mode));
    } catch {
      // Fall back to broad constraints if fine-grained constraints are unsupported.
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: params.mode === "video"
      });
    }

    for (const audioTrack of localStream.getAudioTracks()) {
      audioTrack.contentHint = "speech";
    }
    for (const videoTrack of localStream.getVideoTracks()) {
      videoTrack.contentHint = "motion";
    }

    localStreamRef.current = localStream;
    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }
    applyCodecPreferences(pc, params.mode);
    await Promise.all(pc.getSenders().map((sender) => (
      tuneSenderForCall(sender, params.mode, adaptiveVideoBitrateRef.current)
    )));

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
      localVideoRef.current.muted = true;
      if (params.mode === "video") {
        await localVideoRef.current.play().catch(() => undefined);
        setLocalVideoReady(true);
      } else {
        setLocalVideoReady(false);
      }
    }

    peerConnectionRef.current = pc;
  }, [resolveCallIceServers, restartCallTransport, sendEncryptedSignal]);

  const processSignals = useCallback(async () => {
    if (!session || !keys) return;
    if (processingSignalsRef.current) return;
    processingSignalsRef.current = true;

    try {
      const pulled = await pullSignals(session.token);
      const decodedSignals: DecodedSignal[] = [];

      for (const signal of pulled) {
        try {
          const wrapper = JSON.parse(signal.encryptedPayload) as { ciphertext: string; nonce: string };
          const plain = decryptPayload({
            ciphertext: wrapper.ciphertext,
            nonce: wrapper.nonce,
            senderPublicKey: signal.senderPublicEncryptionKey,
            recipientSecretKey: keys.encryptionSecretKey
          });
          if (!plain) continue;
          decodedSignals.push({
            callId: signal.callId,
            fromUserId: signal.fromUserId,
            senderPublicEncryptionKey: signal.senderPublicEncryptionKey,
            payload: JSON.parse(plain) as CallSignalPayload,
            receivedAtMs: Date.now()
          });
        } catch {
          continue;
        }
      }

      const workQueue = pruneSignalQueue([...pendingSignalQueueRef.current, ...decodedSignals]);
      const requeue: DecodedSignal[] = [];
      pendingSignalQueueRef.current = [];

      for (const signal of workQueue) {
        const call = activeCallRef.current;

        if (signal.payload.type === "call_invite") {
          if (call) {
            await sendEncryptedSignal({
              toUserId: signal.fromUserId,
              toPublicKey: signal.senderPublicEncryptionKey,
              callId: signal.callId,
              payload: { type: "call_reject" }
            });
            continue;
          }

          setIncomingCall({
            callId: signal.callId,
            fromUserId: signal.fromUserId,
            fromLabel: resolveUserLabel(signal.fromUserId),
            senderPublicKey: signal.senderPublicEncryptionKey,
            mode: signal.payload.mode
          });
          if (notificationPermission === "granted") {
            new Notification("Incoming call", {
              body: `${resolveUserLabel(signal.fromUserId)} is calling (${signal.payload.mode})`,
              tag: `call-${signal.callId}`
            });
          }
          continue;
        }

        if (signal.payload.type === "call_reject") {
          if (call && call.callId === signal.callId) {
            setStatus(`${resolveUserLabel(signal.fromUserId)} rejected the call`);
            cleanupCall(false);
          }
          continue;
        }

        if (signal.payload.type === "call_end") {
          if (call && call.callId === signal.callId) {
            setStatus(`${resolveUserLabel(signal.fromUserId)} ended the call`);
            cleanupCall(false);
          }
          continue;
        }

        if (!call || call.callId !== signal.callId) {
          requeue.push(signal);
          continue;
        }

        const pc = peerConnectionRef.current;
        if (!pc) {
          requeue.push(signal);
          continue;
        }

        if (signal.payload.type === "call_accept") {
          if (call.incoming) continue;

          if (outgoingRingTimeoutRef.current) {
            window.clearTimeout(outgoingRingTimeoutRef.current);
            outgoingRingTimeoutRef.current = null;
          }

          applyCodecPreferences(pc, call.mode);
          await Promise.all(pc.getSenders().map((sender) => (
            tuneSenderForCall(sender, call.mode, adaptiveVideoBitrateRef.current)
          )));
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          await sendEncryptedSignal({
            toUserId: call.peerUserId,
            toPublicKey: call.peerPublicKey,
            callId: call.callId,
            payload: { type: "webrtc_offer", sdp: offer }
          });

          setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
          continue;
        }

        if (signal.payload.type === "webrtc_offer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp));
          await flushPendingIceCandidates();
          applyCodecPreferences(pc, call.mode);
          await Promise.all(pc.getSenders().map((sender) => (
            tuneSenderForCall(sender, call.mode, adaptiveVideoBitrateRef.current)
          )));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          await sendEncryptedSignal({
            toUserId: call.peerUserId,
            toPublicKey: call.peerPublicKey,
            callId: call.callId,
            payload: { type: "webrtc_answer", sdp: answer }
          });

          setActiveCall((prev) => (prev ? { ...prev, status: "connecting" } : prev));
          continue;
        }

        if (signal.payload.type === "webrtc_answer") {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp));
          await flushPendingIceCandidates();
          continue;
        }

        if (!pc.remoteDescription) {
          pendingIceCandidatesRef.current.push(signal.payload.candidate);
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(signal.payload.candidate)).catch(() => undefined);
        }
      }

      pendingSignalQueueRef.current = pruneSignalQueue(requeue);
    } finally {
      processingSignalsRef.current = false;
    }
  }, [cleanupCall, flushPendingIceCandidates, keys, notificationPermission, resolveUserLabel, sendEncryptedSignal, session]);

  const refreshSessionToken = useCallback(async (baseSession: Session, baseKeys: KeyMaterial): Promise<string> => {
    const { challenge } = await issueIdentityChallenge({
      userId: baseSession.userId,
      deviceId: baseSession.deviceId
    });

    const signature = signMessage(challenge, baseKeys.signingSecretKey);
    const verified = await verifyIdentityChallenge({
      userId: baseSession.userId,
      deviceId: baseSession.deviceId,
      signature
    });

    return verified.token;
  }, []);

  const backupIdentityAction = useCallback(() => {
    if (!session || !keys) return;

    const payload: IdentityBackup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        userId: session.userId,
        deviceId: session.deviceId
      },
      keys
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `anytime-identity-${session.userId}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus("Identity backup downloaded");
  }, [keys, session]);

  const restoreIdentityAction = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      setLoading(true);
      setStatus("Restoring identity from backup...");

      const raw = await file.text();
      const parsed = JSON.parse(raw) as Partial<IdentityBackup>;

      if (
        parsed.version !== 1 ||
        !parsed.session?.userId ||
        !parsed.session?.deviceId ||
        !parsed.keys?.signingSecretKey ||
        !parsed.keys?.signingPublicKey ||
        !parsed.keys?.encryptionSecretKey ||
        !parsed.keys?.encryptionPublicKey
      ) {
        throw new Error("Invalid backup file");
      }

      const restoredKeys: KeyMaterial = parsed.keys;
      const token = await refreshSessionToken(
        {
          userId: parsed.session.userId,
          deviceId: parsed.session.deviceId,
          token: ""
        },
        restoredKeys
      );

      const restoredSession: Session = {
        userId: parsed.session.userId,
        deviceId: parsed.session.deviceId,
        token
      };

      saveSession(restoredSession);
      saveKeys(restoredKeys);

      const [serverContacts, serverGroups] = await Promise.all([
        listContacts(restoredSession.token),
        listGroups(restoredSession.token)
      ]);

      saveContacts(serverContacts);
      saveGroups(serverGroups);

      setSession(restoredSession);
      setKeys(restoredKeys);
      setContacts(serverContacts);
      setGroups(serverGroups);
      setSelectedChat(null);
      setMessages([]);
      setStatus("Identity restored. Data synced.");
    } catch (error) {
      setStatus(`Restore failed: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [refreshSessionToken]);

  useEffect(() => {
    (async () => {
      try {
        const existingSession = loadSession();
        const existingKeys = loadKeys();
        const existingContacts = loadContacts<Contact[]>();
        const existingGroups = loadGroups<Group[]>();
        sentPayloadCacheRef.current = loadSentCache();

        if (existingSession && existingKeys) {
          let restoredSession = existingSession;
          try {
            const token = await refreshSessionToken(existingSession, existingKeys);
            restoredSession = { ...existingSession, token };
            saveSession(restoredSession);
          } catch {
            // Keep prior token if challenge refresh fails.
          }

          setSession(restoredSession);
          setKeys(existingKeys);
          if (existingContacts) setContacts(existingContacts);
          if (existingGroups) setGroups(existingGroups);
          setStatus("Session restored");
          return;
        }

        const generated = generateKeys();
        setStatus("Creating unique private ID...");

        const created = await registerIdentity({
          deviceName: "web-client",
          deviceSigningPublicKey: generated.signingPublicKey,
          deviceEncryptionPublicKey: generated.encryptionPublicKey
        });

        saveSession(created);
        saveKeys(generated);

        setSession(created);
        setKeys(generated);
        setStatus("Identity created. Share your ID to connect.");
      } catch (error) {
        setStatus(`Failed to initialize: ${(error as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshSessionToken]);

  useEffect(() => {
    if (!session) return;

    (async () => {
      try {
        await Promise.all([refreshContacts(), refreshGroups()]);
      } catch (error) {
        setStatus(`Sync failed: ${(error as Error).message}`);
      }
    })();
  }, [refreshContacts, refreshGroups, session]);

  useEffect(() => {
    inboxCursorRef.current = undefined;
    knownMessageIdsRef.current = new Set();
    setContactRequests([]);
    setPendingAttachments([]);
    callIceCacheRef.current = null;
  }, [session?.userId]);

  useEffect(() => {
    if (!selectedChat) {
      setMessages([]);
      setCallHistory([]);
      setTypingUsers([]);
      setPendingAttachments([]);
      setSelectionMode(false);
      setSelectedMessageIds([]);
      setMessageMenu(null);
      setMediaViewer(null);
      return;
    }

    setPendingAttachments([]);
    setSelectionMode(false);
    setSelectedMessageIds([]);
    setMessageMenu(null);
    setMediaViewer(null);

    Promise.all([
      refreshConversation(),
      refreshCallHistory()
    ]).catch((error) => {
      setStatus(`Conversation load failed: ${(error as Error).message}`);
    });
  }, [refreshCallHistory, refreshConversation, selectedChat]);

  useEffect(() => {
    if (!messageMenu) return;

    const closeMenu = () => setMessageMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [messageMenu]);

  useEffect(() => {
    if (!mediaViewer) return;

    const closeViewer = () => setMediaViewer(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeViewer();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeViewer);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeViewer);
    };
  }, [mediaViewer]);

  useEffect(() => {
    if (!session || !keys) return;

    const timer = window.setInterval(() => {
      refreshConversation().catch(() => undefined);
      refreshCallHistory().catch(() => undefined);
      pollInboxNotifications().catch(() => undefined);
    }, BASE_SYNC_POLL_MS);

    pollInboxNotifications().catch(() => undefined);

    return () => {
      window.clearInterval(timer);
    };
  }, [keys, pollInboxNotifications, refreshCallHistory, refreshConversation, session]);

  useEffect(() => {
    if (!session || !keys) return;

    const timer = window.setInterval(() => {
      processSignals().catch(() => undefined);
    }, signalPollMs);

    processSignals().catch(() => undefined);

    return () => {
      window.clearInterval(timer);
    };
  }, [keys, processSignals, session, signalPollMs]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };

    const onInstalled = () => {
      setInstallPromptEvent(null);
      setStatus("App installed successfully");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!activeCall) {
      setCallDurationSec(0);
      if (callDurationTimerRef.current) {
        window.clearInterval(callDurationTimerRef.current);
        callDurationTimerRef.current = null;
      }
      return;
    }
    if (activeCall.status !== "active") {
      if (callDurationTimerRef.current) {
        window.clearInterval(callDurationTimerRef.current);
        callDurationTimerRef.current = null;
      }
      return;
    }
    if (!callStartAtRef.current) {
      callStartAtRef.current = Date.now();
    }

    setCallDurationSec(Math.floor((Date.now() - (callStartAtRef.current ?? Date.now())) / 1000));
    callDurationTimerRef.current = window.setInterval(() => {
      const started = callStartAtRef.current;
      if (!started) return;
      setCallDurationSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);

    return () => {
      if (callDurationTimerRef.current) {
        window.clearInterval(callDurationTimerRef.current);
        callDurationTimerRef.current = null;
      }
    };
  }, [activeCall]);

  useEffect(() => {
    if (!activeCall || activeCall.status !== "active") {
      setCallQuality("unknown");
      return;
    }
    const pc = peerConnectionRef.current;
    if (!pc) return;
    let cancelled = false;

    const sampleAndAdapt = async () => {
      try {
        const stats = await pc.getStats();
        let rttMs: number | null = null;
        let jitterMs: number | null = null;
        let lossRate: number | null = null;
        let videoBytesSent: number | null = null;
        let videoTimestampMs: number | null = null;

        stats.forEach((report) => {
          if (report.type === "candidate-pair") {
            const pair = report as RTCStats & { state?: string; currentRoundTripTime?: number };
            if (pair.state === "succeeded" && typeof pair.currentRoundTripTime === "number") {
              const candidateRtt = pair.currentRoundTripTime * 1000;
              rttMs = rttMs === null ? candidateRtt : Math.max(rttMs, candidateRtt);
            }
            return;
          }

          if (report.type === "remote-inbound-rtp") {
            const remote = report as RTCStats & {
              kind?: string;
              roundTripTime?: number;
              jitter?: number;
              packetsLost?: number;
              packetsReceived?: number;
            };
            if (typeof remote.roundTripTime === "number") {
              const remoteRtt = remote.roundTripTime * 1000;
              rttMs = rttMs === null ? remoteRtt : Math.max(rttMs, remoteRtt);
            }
            if (typeof remote.jitter === "number") {
              const jitterValue = remote.jitter * 1000;
              jitterMs = jitterMs === null ? jitterValue : Math.max(jitterMs, jitterValue);
            }
            if (typeof remote.packetsLost === "number" && typeof remote.packetsReceived === "number") {
              const total = remote.packetsLost + remote.packetsReceived;
              if (total > 0) {
                const ratio = remote.packetsLost / total;
                lossRate = lossRate === null ? ratio : Math.max(lossRate, ratio);
              }
            }
            return;
          }

          if (report.type === "outbound-rtp") {
            const outbound = report as RTCStats & {
              kind?: string;
              bytesSent?: number;
              timestamp?: number;
            };
            if (outbound.kind === "video" && typeof outbound.bytesSent === "number") {
              videoBytesSent = outbound.bytesSent;
              if (typeof outbound.timestamp === "number") {
                videoTimestampMs = outbound.timestamp;
              }
            }
          }
        });

        if (cancelled) return;
        const effectiveLoss = lossRate ?? 0;
        const effectiveJitter = jitterMs ?? 0;
        const effectiveRtt = rttMs ?? Number.POSITIVE_INFINITY;

        if (!Number.isFinite(effectiveRtt)) {
          setCallQuality("unknown");
        } else if (effectiveRtt < 120 && effectiveLoss < 0.03 && effectiveJitter < 24) {
          setCallQuality("excellent");
        } else if (effectiveRtt < 280 && effectiveLoss < 0.08 && effectiveJitter < 48) {
          setCallQuality("good");
        } else {
          setCallQuality("poor");
        }

        if (activeCall.mode !== "video") return;
        const videoSender = pc.getSenders().find((sender) => sender.track?.kind === "video");
        if (!videoSender) return;

        const previousBytes = lastVideoBytesSentRef.current;
        const previousTs = lastVideoTimestampMsRef.current;
        if (videoBytesSent !== null && videoTimestampMs !== null) {
          lastVideoBytesSentRef.current = videoBytesSent;
          lastVideoTimestampMsRef.current = videoTimestampMs;
        }

        let measuredVideoBps = 0;
        if (
          videoBytesSent !== null &&
          videoTimestampMs !== null &&
          previousBytes !== null &&
          previousTs !== null &&
          videoTimestampMs > previousTs &&
          videoBytesSent >= previousBytes
        ) {
          measuredVideoBps = ((videoBytesSent - previousBytes) * 8 * 1000) / (videoTimestampMs - previousTs);
        }

        const currentTarget = adaptiveVideoBitrateRef.current;
        const weakNetwork = effectiveRtt > 340 || effectiveLoss > 0.12 || effectiveJitter > 60;
        const healthyNetwork = effectiveRtt < 160 && effectiveLoss < 0.04 && effectiveJitter < 30;
        const saturated = measuredVideoBps > 0 && measuredVideoBps < currentTarget * 0.62;
        const spareHeadroom = measuredVideoBps > currentTarget * 0.78 || measuredVideoBps === 0;

        let nextTarget = currentTarget;
        if (weakNetwork || saturated) {
          nextTarget = Math.max(CALL_VIDEO_MIN_TARGET_BPS, Math.round(currentTarget * 0.78));
        } else if (healthyNetwork && spareHeadroom) {
          nextTarget = Math.min(CALL_VIDEO_MAX_TARGET_BPS, Math.round(currentTarget * 1.12));
        }

        if (Math.abs(nextTarget - currentTarget) >= 70_000) {
          adaptiveVideoBitrateRef.current = nextTarget;
          await tuneSenderForCall(videoSender, "video", nextTarget);
        }
      } catch {
        if (!cancelled) setCallQuality("unknown");
      }
    };

    void sampleAndAdapt();
    const timer = window.setInterval(() => {
      void sampleAndAdapt();
    }, 3500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeCall]);

  useEffect(() => {
    if (!activeCall) return;

    const onOnline = () => {
      if (activeCallRef.current?.status !== "active") {
        restartCallTransport("manual").catch(() => undefined);
      }
    };

    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
    };
  }, [activeCall, restartCallTransport]);

  const addContactAction = useCallback(async () => {
    if (!session || !contactUserIdInput.trim()) return;

    const contactUserId = contactUserIdInput.trim();
    if (contactUserId === ownUserId) {
      setStatus("You cannot add yourself as a contact");
      return;
    }

    try {
      await lookupUser(session.token, contactUserId);
      const created = await addContact(session.token, {
        contactUserId,
        nickname: contactNicknameInput.trim() || undefined
      });

      const next = [created, ...contacts.filter((c) => c.contactUserId !== created.contactUserId)];
      setContacts(next);
      saveContacts(next);

      setSelectedChat({
        kind: "contact",
        id: created.contactUserId,
        title: created.nickname || created.contactUserId,
        subtitle: created.contactUserId,
        encryptionPublicKey: created.encryptionPublicKey
      });

      setContactUserIdInput("");
      setContactNicknameInput("");
      setShowContactForm(false);
      setStatus("Contact added");
    } catch (error) {
      setStatus(`Add contact failed: ${(error as Error).message}`);
    }
  }, [contactNicknameInput, contactUserIdInput, contacts, ownUserId, session]);

  const acceptContactRequestAction = useCallback(async (request: ContactRequest) => {
    if (!session) return;

    const nicknameValue = window.prompt("Save contact name (optional)", request.label === request.userId ? "" : request.label);
    if (nicknameValue === null) return;

    try {
      const created = await addContact(session.token, {
        contactUserId: request.userId,
        nickname: nicknameValue.trim() || undefined
      });

      const nextContacts = [created, ...contacts.filter((item) => item.contactUserId !== created.contactUserId)];
      setContacts(nextContacts);
      saveContacts(nextContacts);
      setContactRequests((current) => current.filter((item) => item.userId !== request.userId));
      setSelectedChat({
        kind: "contact",
        id: created.contactUserId,
        title: created.nickname || created.contactUserId,
        subtitle: created.contactUserId,
        encryptionPublicKey: created.encryptionPublicKey
      });
      setStatus(`${created.nickname || created.contactUserId} added to contacts`);
    } catch (error) {
      setStatus(`Add contact failed: ${(error as Error).message}`);
    }
  }, [contacts, session]);

  const eraseContactRequestAction = useCallback(async (request: ContactRequest) => {
    if (!session) return;
    if (!window.confirm(`Erase messages from ${request.label} and dismiss contact request?`)) return;

    try {
      const conversationId = sortedConversationId(session.userId, request.userId);
      const items = await listConversation(session.token, conversationId).catch(() => []);
      const messageIds = new Set([
        ...request.messageIds,
        ...items
          .filter((item) => item.senderUserId === request.userId && !item.deletedAt)
          .map((item) => item.messageId)
      ]);

      await Promise.all(Array.from(messageIds).map((messageId) => hideMessage(session.token, messageId).catch(() => undefined)));

      setContactRequests((current) => current.filter((item) => item.userId !== request.userId));
      if (selectedConversationId === conversationId) {
        await refreshConversation().catch(() => undefined);
      }
      setStatus("Contact request erased");
    } catch (error) {
      setStatus(`Erase request failed: ${(error as Error).message}`);
    }
  }, [refreshConversation, selectedConversationId, session]);

  const toggleGroupMember = useCallback((userId: string) => {
    setGroupMembersInput((current) => {
      if (current.includes(userId)) {
        return current.filter((id) => id !== userId);
      }
      return [...current, userId];
    });
  }, []);

  const createGroupAction = useCallback(async () => {
    if (!session) return;

    const name = groupNameInput.trim();
    if (!name) {
      setStatus("Group name is required");
      return;
    }

    if (groupMembersInput.length === 0) {
      setStatus("Select at least one member");
      return;
    }

    try {
      const created = await createGroup(session.token, {
        name,
        memberUserIds: groupMembersInput
      });

      const next = [created, ...groups.filter((g) => g.groupId !== created.groupId)];
      setGroups(next);
      saveGroups(next);

      setSelectedChat({
        kind: "group",
        id: created.groupId,
        title: created.name,
        subtitle: `${created.members.length} members`,
        members: created.members
      });

      setGroupNameInput("");
      setGroupMembersInput([]);
      setShowGroupForm(false);
      setStatus("Group created");
    } catch (error) {
      setStatus(`Create group failed: ${(error as Error).message}`);
    }
  }, [groupMembersInput, groupNameInput, groups, session]);

  const editSelectedContactAction = useCallback(async () => {
    if (!session || !selectedChat || selectedChat.kind !== "contact") return;
    const value = window.prompt("Update nickname (leave blank to clear)", selectedChat.title);
    if (value === null) return;

    try {
      const updated = await updateContact(session.token, selectedChat.id, {
        nickname: value.trim() ? value.trim() : null
      });
      const next = contacts.map((contact) =>
        contact.contactUserId === updated.contactUserId ? updated : contact
      );
      setContacts(next);
      saveContacts(next);
      setSelectedChat((current) => {
        if (!current || current.kind !== "contact" || current.id !== updated.contactUserId) return current;
        return {
          kind: "contact",
          id: updated.contactUserId,
          title: updated.nickname || updated.contactUserId,
          subtitle: updated.contactUserId,
          encryptionPublicKey: updated.encryptionPublicKey
        };
      });
      setStatus("Contact updated");
    } catch (error) {
      setStatus(`Edit contact failed: ${(error as Error).message}`);
    }
  }, [contacts, selectedChat, session]);

  const deleteSelectedContactAction = useCallback(async () => {
    if (!session || !selectedChat || selectedChat.kind !== "contact") return;
    if (!window.confirm(`Delete ${selectedChat.title} from contacts?`)) return;

    try {
      await deleteContact(session.token, selectedChat.id);
      const next = contacts.filter((contact) => contact.contactUserId !== selectedChat.id);
      setContacts(next);
      saveContacts(next);
      setSelectedChat(null);
      setMessages([]);
      setStatus("Contact deleted");
    } catch (error) {
      setStatus(`Delete contact failed: ${(error as Error).message}`);
    }
  }, [contacts, selectedChat, session]);

  const clearChatAction = useCallback(async () => {
    if (!session || !selectedConversationId || !selectedChat) return;
    if (!window.confirm(`Delete this chat for you? This clears messages, files, media, and call history with ${selectedChat.title}.`)) return;

    try {
      await clearConversation(session.token, selectedConversationId);
      if (selectedChat.kind === "contact") {
        await clearCallHistory(session.token, selectedChat.id);
      }
      setMessages([]);
      setCallHistory([]);
      setPendingAttachments([]);
      setStatus("Chat cleared");
    } catch (error) {
      setStatus(`Clear chat failed: ${(error as Error).message}`);
    }
  }, [selectedChat, selectedConversationId, session]);

  const requestNotificationsAction = useCallback(async () => {
    if (!("Notification" in window)) {
      setStatus("Notifications are not supported in this browser");
      return;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
    setStatus(result === "granted" ? "Notifications enabled" : "Notifications not enabled");
  }, []);

  const installAppAction = useCallback(async () => {
    if (!installPromptEvent) return;
    await installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice;
    setInstallPromptEvent(null);
    setStatus(choice.outcome === "accepted" ? "Install accepted" : "Install dismissed");
  }, [installPromptEvent]);

  const sendPayload = useCallback(async (payload: MessagePayload) => {
    if (!session || !keys || !selectedChat) return;

    const plaintext = JSON.stringify(payload);
    const clientMessageId = makeClientMessageId();

    try {
      if (selectedChat.kind === "contact") {
        const encrypted = encryptPayload(
          plaintext,
          selectedChat.encryptionPublicKey,
          keys.encryptionSecretKey
        );

        await sendMessage(session.token, {
          conversationId: sortedConversationId(session.userId, selectedChat.id),
          clientMessageId,
          recipientUserId: selectedChat.id,
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce
        });
      } else {
        const recipients = selectedChat.members.filter((member) => member.userId !== session.userId);

        const items = recipients.map((recipient) => {
          const encrypted = encryptPayload(
            plaintext,
            recipient.encryptionPublicKey,
            keys.encryptionSecretKey
          );

          return {
            recipientUserId: recipient.userId,
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce
          };
        });

        if (items.length === 0) {
          setStatus("No recipients available in this group");
          return;
        }

        await sendMessageBatch(session.token, {
          conversationId: selectedChat.id,
          clientMessageId,
          items
        });
      }

      sentPayloadCacheRef.current = {
        ...sentPayloadCacheRef.current,
        [clientMessageId]: plaintext
      };
      saveSentCache(sentPayloadCacheRef.current);

      await refreshConversation();
    } catch (error) {
      setStatus(`Send failed: ${(error as Error).message}`);
    }
  }, [keys, refreshConversation, selectedChat, session]);

  const sendTypingPulse = useCallback(async () => {
    if (!session || !selectedConversationId || typingRecipientUserIds.length === 0) return;
    const now = Date.now();
    if ((now - lastTypingPulseRef.current) < TYPING_PULSE_MS) return;
    lastTypingPulseRef.current = now;

    await sendTyping(session.token, {
      conversationId: selectedConversationId,
      recipientUserIds: typingRecipientUserIds,
      ttlSeconds: 8
    }).catch(() => undefined);
  }, [selectedConversationId, session, typingRecipientUserIds]);

  useEffect(() => {
    if (!composer.trim()) return;
    const timer = window.setInterval(() => {
      sendTypingPulse().catch(() => undefined);
    }, TYPING_PULSE_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [composer, sendTypingPulse]);

  const editMessageAction = useCallback(async (message: UiMessage) => {
    if (!session || !keys || !selectedChat || !message.mine || message.deletedAt) return;

    let nextPayload: MessagePayload | null = null;

    if (message.payload.type === "text") {
      const text = window.prompt("Edit message", message.payload.text);
      if (text === null) return;
      nextPayload = { type: "text", text };
    } else if (message.payload.type === "image") {
      const caption = window.prompt("Edit photo caption", message.payload.caption ?? "");
      if (caption === null) return;
      nextPayload = { ...message.payload, caption: caption || undefined };
    } else if (message.payload.type === "gif") {
      const url = window.prompt("Edit GIF URL", message.payload.url);
      if (url === null) return;
      nextPayload = { type: "gif", url };
    } else {
      setStatus("This message type cannot be edited");
      return;
    }

    const plaintext = JSON.stringify(nextPayload);

    try {
      if (selectedChat.kind === "contact") {
        const encrypted = encryptPayload(
          plaintext,
          selectedChat.encryptionPublicKey,
          keys.encryptionSecretKey
        );
        await editMessage(session.token, message.id, {
          ciphertext: encrypted.ciphertext,
          nonce: encrypted.nonce
        });
      } else {
        if (!message.clientMessageId) {
          setStatus("Cannot edit this group message");
          return;
        }
        const recipients = selectedChat.members.filter((member) => member.userId !== session.userId);
        const items = recipients.map((recipient) => {
          const encrypted = encryptPayload(plaintext, recipient.encryptionPublicKey, keys.encryptionSecretKey);
          return {
            recipientUserId: recipient.userId,
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce
          };
        });

        await editMessageByClientId(session.token, message.clientMessageId, {
          conversationId: selectedChat.id,
          items
        });
      }

      const cacheKey = message.clientMessageId ?? message.id;
      sentPayloadCacheRef.current = {
        ...sentPayloadCacheRef.current,
        [cacheKey]: plaintext
      };
      saveSentCache(sentPayloadCacheRef.current);
      await refreshConversation();
      setStatus("Message edited");
    } catch (error) {
      setStatus(`Edit failed: ${(error as Error).message}`);
    }
  }, [keys, refreshConversation, selectedChat, session]);

  const deleteMessageAction = useCallback(async (message: UiMessage) => {
    if (!session || !selectedChat || message.deletedAt) return;
    if (!window.confirm("Delete this message?")) return;

    try {
      if (message.mine) {
        if (selectedChat.kind === "group" && message.clientMessageId) {
          await deleteMessageByClientId(session.token, message.clientMessageId, selectedChat.id);
        } else {
          await deleteMessage(session.token, message.id);
        }
      } else {
        await hideMessage(session.token, message.id);
      }
      await refreshConversation();
      setStatus("Message deleted");
    } catch (error) {
      setStatus(`Delete failed: ${(error as Error).message}`);
    }
  }, [refreshConversation, selectedChat, session]);

  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds((current) => (
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId]
    ));
  }, []);

  const openMediaViewer = useCallback((input: {
    src: string;
    mime: string;
    title: string;
    downloadName: string;
    caption?: string;
  }) => {
    setMediaViewer({
      src: input.src,
      mime: input.mime,
      title: input.title,
      downloadName: input.downloadName,
      caption: input.caption,
      previewKind: inferMediaPreviewKind(input.mime, input.src)
    });
  }, []);

  const openMessageMenu = useCallback((event: ReactMouseEvent<HTMLElement>, message: UiMessage) => {
    event.preventDefault();
    setMessageMenu({
      message,
      x: event.clientX,
      y: event.clientY
    });
  }, []);

  const deleteSelectedMessagesAction = useCallback(async () => {
    if (!session || !selectedChat || selectedMessageIds.length === 0) return;
    if (!window.confirm(`Delete ${selectedMessageIds.length} selected message(s)?`)) return;

    try {
      const targets = messages.filter((message) => selectedMessageIds.includes(message.id));
      for (const message of targets) {
        if (message.mine) {
          if (selectedChat.kind === "group" && message.clientMessageId) {
            await deleteMessageByClientId(session.token, message.clientMessageId, selectedChat.id);
          } else {
            await deleteMessage(session.token, message.id);
          }
        } else {
          await hideMessage(session.token, message.id);
        }
      }
      setSelectedMessageIds([]);
      setSelectionMode(false);
      await refreshConversation();
      setStatus("Selected messages deleted");
    } catch (error) {
      setStatus(`Bulk delete failed: ${(error as Error).message}`);
    }
  }, [messages, refreshConversation, selectedChat, selectedMessageIds, session]);

  const sendTextAction = useCallback(async () => {
    const text = composer.trim();
    if (!text && pendingAttachments.length === 0) return;

    setComposer("");
    const attachments = [...pendingAttachments];
    setPendingAttachments([]);

    if (attachments.length === 0) {
      await sendPayload({ type: "text", text });
      return;
    }

    for (const [index, attachment] of attachments.entries()) {
      if (attachment.kind === "image") {
        await sendPayload({
          type: "image",
          dataUrl: attachment.dataUrl,
          caption: index === 0 && text ? text : undefined
        });
      } else {
        await sendPayload({
          type: "file",
          name: attachment.name,
          mime: attachment.mime,
          dataUrl: attachment.dataUrl,
          sizeBytes: attachment.sizeBytes,
          caption: index === 0 && text ? text : undefined
        });
      }
    }
  }, [composer, pendingAttachments, sendPayload]);

  const onComposerChange = useCallback((value: string) => {
    setComposer(value);
    if (value.trim().length > 0) {
      sendTypingPulse().catch(() => undefined);
    }
  }, [sendTypingPulse]);

  const onComposerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void sendTextAction();
  }, [sendTextAction]);

  const queueAttachments = useCallback(async (files: File[]) => {
    if (!selectedChat) {
      setStatus("Select a chat before adding attachments");
      return;
    }

    const next: PendingAttachment[] = [];
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      if (isImage && file.size > MAX_IMAGE_BYTES) {
        setStatus(`Image too large (${file.name}). Max 2 MB`);
        continue;
      }
      if (!isImage && file.size > MAX_FILE_BYTES) {
        setStatus(`File too large (${file.name}). Max 8 MB`);
        continue;
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        next.push({
          id: makeClientMessageId(),
          kind: isImage ? "image" : "file",
          name: file.name || `file-${Date.now()}`,
          mime: file.type || "application/octet-stream",
          sizeBytes: file.size,
          dataUrl
        });
      } catch {
        setStatus(`Failed to read ${file.name || "pasted file"}`);
      }
    }

    if (next.length > 0) {
      setPendingAttachments((current) => [...current, ...next]);
      setStatus(`${next.length} attachment${next.length > 1 ? "s" : ""} ready to send`);
    }
  }, [selectedChat]);

  const onComposerPaste = useCallback(async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (files.length === 0) return;

    event.preventDefault();
    await queueAttachments(files);
  }, [queueAttachments]);

  const removePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) => current.filter((item) => item.id !== attachmentId));
  }, []);

  const onSelectImage = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) return;
    await queueAttachments(files);
  }, [queueAttachments]);

  const onSelectFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) return;
    await queueAttachments(files);
  }, [queueAttachments]);

  const sendGifAction = useCallback(async () => {
    setGifError("");
    setShowGifPicker((current) => !current);
  }, []);

  const sendGifFromPicker = useCallback(async (gif: GifResult) => {
    await sendPayload({ type: "gif", url: gif.url });
    setShowGifPicker(false);
  }, [sendPayload]);

  useEffect(() => {
    if (!showGifPicker) return;

    const q = gifQuery.trim();
    const query = q.length > 0 ? q : "trending";

    const timer = window.setTimeout(async () => {
      setGifLoading(true);
      setGifError("");
      try {
        const giphyItems = await fetchGiphyGifs(query);
        setGifResults(giphyItems);
        setGifProvider("giphy");
      } catch (error) {
        try {
          const tenorItems = await fetchTenorGifs(query);
          setGifResults(tenorItems);
          setGifProvider("tenor");
          setGifError("Giphy unavailable, showing Tenor results.");
        } catch (tenorError) {
          setGifResults([]);
          setGifError(`GIF search unavailable (${(tenorError as Error).message}).`);
          setStatus(`GIF search failed: ${(error as Error).message}`);
        }
      } finally {
        setGifLoading(false);
      }
    }, 320);

    return () => {
      window.clearTimeout(timer);
    };
  }, [gifQuery, showGifPicker]);

  const startRecording = useCallback(async () => {
    if (recording) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

      mediaRecordChunksRef.current = [];
      mediaRecordStartRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          mediaRecordChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const durationMs = Date.now() - mediaRecordStartRef.current;
        const blob = new Blob(mediaRecordChunksRef.current, { type: "audio/webm" });
        const dataUrl = await blobToDataUrl(blob);

        for (const track of stream.getTracks()) {
          track.stop();
        }

        await sendPayload({ type: "audio", dataUrl, durationMs });
      };

      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);

      mediaRecordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      setStatus(`Mic access failed: ${(error as Error).message}`);
    }
  }, [recording, sendPayload]);

  const stopRecording = useCallback(() => {
    if (!recording || !mediaRecorderRef.current) return;

    mediaRecorderRef.current.stop();
    mediaRecorderRef.current = null;

    if (mediaRecordTimerRef.current) {
      window.clearInterval(mediaRecordTimerRef.current);
      mediaRecordTimerRef.current = null;
    }

    setRecording(false);
    setRecordSeconds(0);
  }, [recording]);

  const startCall = useCallback(async (mode: CallMode) => {
    if (!session || !keys || !selectedChat || selectedChat.kind !== "contact") return;

    try {
      const { callId } = await createCallSession(session.token, [selectedChat.id], mode);

      await setupPeerConnection({
        callId,
        toUserId: selectedChat.id,
        toPublicKey: selectedChat.encryptionPublicKey,
        mode
      });

      callStartAtRef.current = null;
      setCallDurationSec(0);
      setCallQuality("unknown");

      setActiveCall({
        callId,
        peerUserId: selectedChat.id,
        peerLabel: selectedChat.title,
        peerPublicKey: selectedChat.encryptionPublicKey,
        mode,
        status: "ringing",
        incoming: false
      });

      if (outgoingRingTimeoutRef.current) {
        window.clearTimeout(outgoingRingTimeoutRef.current);
      }
      outgoingRingTimeoutRef.current = window.setTimeout(() => {
        const current = activeCallRef.current;
        if (current && !current.incoming && current.status === "ringing") {
          setStatus("No answer");
          cleanupCall(true);
        }
      }, CALL_RING_TIMEOUT_MS);

      await sendEncryptedSignal({
        toUserId: selectedChat.id,
        toPublicKey: selectedChat.encryptionPublicKey,
        callId,
        payload: { type: "call_invite", mode }
      });

      setStatus(`${mode === "audio" ? "Audio" : "Video"} call invite sent`);
    } catch (error) {
      setStatus(`Call failed: ${(error as Error).message}`);
      cleanupCall(false);
    }
  }, [cleanupCall, keys, selectedChat, sendEncryptedSignal, session, setupPeerConnection]);

  const rejectIncomingCall = useCallback(async () => {
    if (!incomingCall) return;

    try {
      if (session) {
        await endCall(session.token, incomingCall.callId).catch(() => undefined);
      }
      await sendEncryptedSignal({
        toUserId: incomingCall.fromUserId,
        toPublicKey: incomingCall.senderPublicKey,
        callId: incomingCall.callId,
        payload: { type: "call_reject" }
      });
    } catch {
      // best effort
    }

    setIncomingCall(null);
  }, [incomingCall, sendEncryptedSignal, session]);

  const acceptIncomingCall = useCallback(async () => {
    if (!incomingCall || !session || !keys) return;

    try {
      await setupPeerConnection({
        callId: incomingCall.callId,
        toUserId: incomingCall.fromUserId,
        toPublicKey: incomingCall.senderPublicKey,
        mode: incomingCall.mode
      });

      callStartAtRef.current = null;
      setCallDurationSec(0);
      setCallQuality("unknown");

      setActiveCall({
        callId: incomingCall.callId,
        peerUserId: incomingCall.fromUserId,
        peerLabel: incomingCall.fromLabel,
        peerPublicKey: incomingCall.senderPublicKey,
        mode: incomingCall.mode,
        status: "connecting",
        incoming: true
      });

      await sendEncryptedSignal({
        toUserId: incomingCall.fromUserId,
        toPublicKey: incomingCall.senderPublicKey,
        callId: incomingCall.callId,
        payload: { type: "call_accept", mode: incomingCall.mode }
      });

      setIncomingCall(null);
    } catch (error) {
      setStatus(`Accept call failed: ${(error as Error).message}`);
      cleanupCall(false);
    }
  }, [cleanupCall, incomingCall, keys, sendEncryptedSignal, session, setupPeerConnection]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;

    const nextMuted = !callMuted;
    for (const track of localStreamRef.current.getAudioTracks()) {
      track.enabled = !nextMuted;
    }

    setCallMuted(nextMuted);
  }, [callMuted]);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;

    const nextVideoOff = !callVideoOff;
    for (const track of localStreamRef.current.getVideoTracks()) {
      track.enabled = !nextVideoOff;
    }

    setCallVideoOff(nextVideoOff);
  }, [callVideoOff]);

  const reconnectCall = useCallback(() => {
    restartCallTransport("manual").catch(() => undefined);
  }, [restartCallTransport]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = messages.map((message) => ({
      kind: "message",
      id: `m:${message.id}`,
      at: message.sentAt,
      message
    }));

    if (selectedChat?.kind === "contact") {
      for (const call of callHistory) {
        items.push({
          kind: "call",
          id: `c:${call.callId}`,
          at: call.createdAt,
          call
        });
      }
    }

    return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }, [callHistory, messages, selectedChat]);

  const typingLabel = useMemo(() => {
    if (typingUsers.length === 0) return "";
    const names = typingUsers.map((userId) => resolveUserLabel(userId));
    if (names.length === 1) return `${names[0]} is typing...`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
    return `${names[0]} and ${names.length - 1} others are typing...`;
  }, [resolveUserLabel, typingUsers]);

  const messageMenuPosition = useMemo(() => {
    if (!messageMenu) return null;
    return clampMenuPosition(messageMenu.x, messageMenu.y);
  }, [messageMenu]);

  const incomingCallInitials = useMemo(() => (
    incomingCall ? makeInitials(incomingCall.fromLabel) : ""
  ), [incomingCall]);

  const activeCallInitials = useMemo(() => (
    activeCall ? makeInitials(activeCall.peerLabel) : ""
  ), [activeCall]);

  const resetAction = useCallback(() => {
    if (!window.confirm("Reset local identity and clear all local data?")) return;
    cleanupCall(false);
    clearAll();
    window.location.reload();
  }, [cleanupCall]);

  if (loading) {
    return (
      <div className="app-shell loading-shell">
        <div className="loader" />
        <p>{status}</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div>
            <h1>Anytime</h1>
            <p>{ownUserId}</p>
          </div>
          <div className="top-actions">
            <button
              className="icon-btn"
              onClick={requestNotificationsAction}
              title="Enable notifications"
              disabled={notificationPermission === "granted"}
            >
              {notificationPermission === "granted" ? "Notified" : "Notify"}
            </button>
            {installPromptEvent ? (
              <button className="icon-btn" onClick={installAppAction} title="Install app">
                Install
              </button>
            ) : null}
            <button className="icon-btn" onClick={backupIdentityAction} title="Backup identity">
              Backup
            </button>
            <button className="icon-btn" onClick={() => backupInputRef.current?.click()} title="Restore identity">
              Restore
            </button>
            <button className="icon-btn danger" onClick={resetAction} title="Reset">
              Reset
            </button>
            <input
              ref={backupInputRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={restoreIdentityAction}
            />
          </div>
        </div>

        <p className="identity-note">
          Your ID and keys are stored on this device. Contacts and groups are kept on the server for this ID.
        </p>

        <div className="sidebar-actions">
          <button className="pill-btn" onClick={() => setShowContactForm((v) => !v)}>
            + Contact
          </button>
          <button className="pill-btn" onClick={() => setShowGroupForm((v) => !v)}>
            + Group
          </button>
        </div>

        {showContactForm ? (
          <div className="card form-card">
            <h3>Add Contact</h3>
            <input
              value={contactUserIdInput}
              onChange={(e) => setContactUserIdInput(e.target.value)}
              placeholder="User ID"
            />
            <input
              value={contactNicknameInput}
              onChange={(e) => setContactNicknameInput(e.target.value)}
              placeholder="Nickname"
            />
            <button className="primary-btn" onClick={addContactAction}>Save Contact</button>
          </div>
        ) : null}

        {showGroupForm ? (
          <div className="card form-card">
            <h3>Create Group</h3>
            <input
              value={groupNameInput}
              onChange={(e) => setGroupNameInput(e.target.value)}
              placeholder="Group name"
            />

            <div className="member-grid">
              {contacts.map((contact) => {
                const checked = groupMembersInput.includes(contact.contactUserId);
                return (
                  <label key={contact.contactUserId} className="member-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleGroupMember(contact.contactUserId)}
                    />
                    <span>{contact.nickname || contact.contactUserId}</span>
                  </label>
                );
              })}
            </div>

            <button className="primary-btn" onClick={createGroupAction}>Create Group</button>
          </div>
        ) : null}

        {contactRequests.length > 0 ? (
          <section className="card request-card">
            <h3>Contact Requests ({contactRequests.length})</h3>
            <div className="request-list">
              {contactRequests.map((request) => (
                <article key={request.userId} className="request-item">
                  <header>
                    <strong>{request.label}</strong>
                    <span>{new Date(request.receivedAt).toLocaleTimeString()}</span>
                  </header>
                  <p>{request.preview}</p>
                  <div className="request-actions">
                    <button className="tiny-btn" onClick={() => acceptContactRequestAction(request)}>Add Contact</button>
                    <button className="tiny-btn danger" onClick={() => eraseContactRequestAction(request)}>Erase</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <div className="search-box">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search chats" />
        </div>

        <div className="chat-list">
          {chatTargets.map((chat) => {
            const selected = selectedChat?.id === chat.id && selectedChat?.kind === chat.kind;
            return (
              <button
                key={`${chat.kind}:${chat.id}`}
                className={`chat-row ${selected ? "active" : ""}`}
                onClick={() => setSelectedChat(chat)}
              >
                <div className="avatar">{chat.kind === "group" ? "👥" : "👤"}</div>
                <div className="chat-meta">
                  <strong>{chat.title}</strong>
                  <span>{chat.subtitle}</span>
                </div>
              </button>
            );
          })}

          {chatTargets.length === 0 ? <p className="empty-note">No chats yet</p> : null}
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <h2>{selectedChat ? selectedChat.title : "Select a chat"}</h2>
            <p>{selectedChat ? (typingLabel || selectedChat.subtitle) : "Private encrypted messaging"}</p>
          </div>

          {selectedChat ? (
            <div className="call-buttons">
              {selectedChat.kind === "contact" ? (
                <>
                  <HeaderActionButton title="Start audio call" onClick={() => startCall("audio")}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6.4 2.8h2.2l1.1 3-1.5 1.5a8.8 8.8 0 0 0 3.6 3.6l1.5-1.5 3 1.1v2.2c0 1.2-.9 2.1-2.1 2.1C8.1 14.8 2 8.7 2 3.6c0-1.2.9-2.1 2.1-2.1Z" />
                    </svg>
                  </HeaderActionButton>
                  <HeaderActionButton title="Start video call" onClick={() => startCall("video")}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="2" y="4" width="8.8" height="8" rx="2" />
                      <path d="m10.8 6.5 3.2-1.8v6.6l-3.2-1.8z" />
                    </svg>
                  </HeaderActionButton>
                  <HeaderActionButton title="Edit contact" onClick={editSelectedContactAction}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3 11.7 2.4 14l2.3-.6L12.9 5.2 10.8 3z" />
                      <path d="m9.7 4.1 2.2 2.2" />
                    </svg>
                  </HeaderActionButton>
                  <HeaderActionButton title="Delete contact" onClick={deleteSelectedContactAction} danger>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <circle cx="6.2" cy="5.1" r="2.2" />
                      <path d="M2.9 12.8c.5-2.1 2.2-3.4 4-3.4 2 0 3.6 1.3 4.1 3.4" />
                      <path d="M11.6 6.2h3.2" />
                    </svg>
                  </HeaderActionButton>
                </>
              ) : null}
              <HeaderActionButton
                title={selectionMode ? "Cancel message selection" : "Select messages"}
                active={selectionMode}
                onClick={() => {
                  setSelectionMode((current) => !current);
                  setSelectedMessageIds([]);
                  setMessageMenu(null);
                }}
              >
                {selectionMode ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                    <path d="m5 5 6 6M11 5l-6 6" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                    <path d="m5.2 8.1 2 2.1 3.9-4" />
                  </svg>
                )}
              </HeaderActionButton>
              {selectionMode ? (
                <HeaderActionButton
                  title={`Delete selected messages (${selectedMessageIds.length})`}
                  danger
                  onClick={deleteSelectedMessagesAction}
                  disabled={selectedMessageIds.length === 0}
                  badge={selectedMessageIds.length}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.4 4.4h9.2" />
                    <path d="M6.3 2.8h3.4v1.6H6.3z" />
                    <rect x="4.5" y="4.4" width="7" height="8.8" rx="1.2" />
                    <path d="M6.8 6.8v4m2.4-4v4" />
                  </svg>
                </HeaderActionButton>
              ) : null}
              <HeaderActionButton title="Delete chat" onClick={clearChatAction} danger>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.4 4.4h9.2" />
                  <path d="M6.3 2.8h3.4v1.6H6.3z" />
                  <rect x="4.5" y="4.4" width="7" height="8.8" rx="1.2" />
                  <path d="M6.8 6.8v4m2.4-4v4" />
                </svg>
              </HeaderActionButton>
            </div>
          ) : null}
        </header>

        <section className="message-stream">
          {timelineItems.length === 0 ? <p className="empty-note">No messages in this conversation</p> : null}

          {timelineItems.map((item) => {
            if (item.kind === "call") {
              const call = item.call;
              const outgoing = call.createdBy === ownUserId;
              const durationMs = call.endedAt ? Date.parse(call.endedAt) - Date.parse(call.createdAt) : 0;
              const duration = durationMs > 0 ? `${Math.round(durationMs / 1000)}s` : "No duration";

              return (
                <article key={item.id} className={`call-card ${outgoing ? "mine" : "theirs"}`}>
                  <header>
                    <strong>{outgoing ? "Outgoing" : "Incoming"} {call.mode === "video" ? "Video" : "Audio"} Call</strong>
                    <span>{new Date(call.createdAt).toLocaleTimeString()}</span>
                  </header>
                  <p>{duration}</p>
                </article>
              );
            }

            const message = item.message;
            const readState = message.mine
              ? (message.readCount > 0 ? (message.recipientCount > 1 ? `${message.readCount}/${message.recipientCount} read` : "Read") : "Sent")
              : "";

            const isSelected = selectedMessageIds.includes(message.id);
            const textPayload = message.payload.type === "text" ? message.payload : null;
            const imagePayload = message.payload.type === "image" ? message.payload : null;
            const gifPayload = message.payload.type === "gif" ? message.payload : null;
            const audioPayload = message.payload.type === "audio" ? message.payload : null;
            const filePayload = message.payload.type === "file" ? message.payload : null;

            return (
              <article
                key={item.id}
                className={`bubble ${message.mine ? "mine" : "theirs"} ${isSelected ? "selected" : ""}`}
                onContextMenu={(event) => openMessageMenu(event, message)}
              >
                <header>
                  {!message.mine ? <strong>{message.senderLabel}</strong> : null}
                  <span>{new Date(message.sentAt).toLocaleTimeString()}</span>
                </header>

                {selectionMode ? (
                  <label className="select-row">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleMessageSelection(message.id)}
                    />
                    <span>Select</span>
                  </label>
                ) : null}

                {textPayload ? <p>{textPayload.text}</p> : null}

                {imagePayload ? (
                  <div className="media-wrap">
                    <img
                      src={imagePayload.dataUrl}
                      alt="sent"
                      onClick={() => openMediaViewer({
                        src: imagePayload.dataUrl,
                        mime: "image/*",
                        title: "Photo",
                        downloadName: `image-${message.id}.png`,
                        caption: imagePayload.caption
                      })}
                    />
                    <div className="attachment-actions">
                      <button
                        className="tiny-btn attachment-link"
                        onClick={() => openMediaViewer({
                          src: imagePayload.dataUrl,
                          mime: "image/*",
                          title: "Photo",
                          downloadName: `image-${message.id}.png`,
                          caption: imagePayload.caption
                        })}
                      >
                        View
                      </button>
                      <a
                        href={imagePayload.dataUrl}
                        download={`image-${message.id}.png`}
                        className="tiny-btn attachment-link"
                      >
                        Download
                      </a>
                    </div>
                    {imagePayload.caption ? <p>{imagePayload.caption}</p> : null}
                  </div>
                ) : null}

                {gifPayload ? (
                  <div className="media-wrap">
                    <img
                      src={gifPayload.url}
                      alt="gif"
                      onClick={() => openMediaViewer({
                        src: gifPayload.url,
                        mime: "image/gif",
                        title: "GIF",
                        downloadName: `gif-${message.id}.gif`
                      })}
                    />
                    <div className="attachment-actions">
                      <button
                        className="tiny-btn attachment-link"
                        onClick={() => openMediaViewer({
                          src: gifPayload.url,
                          mime: "image/gif",
                          title: "GIF",
                          downloadName: `gif-${message.id}.gif`
                        })}
                      >
                        View
                      </button>
                      <a href={gifPayload.url} download={`gif-${message.id}.gif`} className="tiny-btn attachment-link">Download</a>
                    </div>
                  </div>
                ) : null}

                {audioPayload ? (
                  <div className="media-wrap">
                    <audio controls src={audioPayload.dataUrl} preload="metadata" />
                    <div className="attachment-actions">
                      <button
                        className="tiny-btn attachment-link"
                        onClick={() => openMediaViewer({
                          src: audioPayload.dataUrl,
                          mime: "audio/webm",
                          title: "Voice message",
                          downloadName: `voice-${message.id}.webm`
                        })}
                      >
                        View
                      </button>
                      <a href={audioPayload.dataUrl} download={`voice-${message.id}.webm`} className="tiny-btn attachment-link">Download</a>
                    </div>
                  </div>
                ) : null}

                {filePayload ? (
                  <div className="file-wrap">
                    <div className="file-link">
                      <strong>{filePayload.name}</strong>
                      <span>{filePayload.mime || "file"} · {formatBytes(filePayload.sizeBytes)}</span>
                    </div>
                    <div className="attachment-actions">
                      <button
                        className="tiny-btn attachment-link"
                        onClick={() => openMediaViewer({
                          src: filePayload.dataUrl,
                          mime: filePayload.mime,
                          title: filePayload.name,
                          downloadName: filePayload.name,
                          caption: filePayload.caption
                        })}
                      >
                        View
                      </button>
                      <a href={filePayload.dataUrl} download={filePayload.name} className="tiny-btn attachment-link">Download</a>
                    </div>
                    {filePayload.caption ? <p>{filePayload.caption}</p> : null}
                  </div>
                ) : null}

                <footer className="message-meta">
                  {message.editedAt ? <span>edited</span> : <span> </span>}
                  {readState ? <span>{readState}</span> : null}
                </footer>
              </article>
            );
          })}
        </section>

        {messageMenu && messageMenuPosition ? (
          <div
            className="message-context-overlay"
            onClick={() => setMessageMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div
              className="message-context-menu"
              style={{ left: messageMenuPosition.x, top: messageMenuPosition.y }}
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              {canEditMessageContent(messageMenu.message) ? (
                <button
                  className="message-context-item"
                  onClick={() => {
                    setMessageMenu(null);
                    void editMessageAction(messageMenu.message);
                  }}
                >
                  Edit message
                </button>
              ) : null}
              {!messageMenu.message.deletedAt ? (
                <button
                  className="message-context-item danger"
                  onClick={() => {
                    setMessageMenu(null);
                    void deleteMessageAction(messageMenu.message);
                  }}
                >
                  Delete message
                </button>
              ) : null}
              <button
                className="message-context-item"
                onClick={() => {
                  const messageId = messageMenu.message.id;
                  setMessageMenu(null);
                  if (!selectionMode) {
                    setSelectionMode(true);
                    setSelectedMessageIds([messageId]);
                    return;
                  }
                  toggleMessageSelection(messageId);
                }}
              >
                {selectedMessageIds.includes(messageMenu.message.id) ? "Unselect message" : "Select message"}
              </button>
            </div>
          </div>
        ) : null}

        {mediaViewer ? (
          <div className="media-viewer-overlay" onClick={() => setMediaViewer(null)}>
            <div className="media-viewer-sheet" onClick={(event) => event.stopPropagation()}>
              <header className="media-viewer-header">
                <div>
                  <h3>{mediaViewer.title}</h3>
                  <p>{mediaViewer.mime || "Attachment"}</p>
                </div>
                <div className="media-viewer-actions">
                  <a
                    href={mediaViewer.src}
                    download={mediaViewer.downloadName}
                    className="tiny-btn attachment-link"
                  >
                    Download
                  </a>
                  <button className="tiny-btn" onClick={() => setMediaViewer(null)}>Close</button>
                </div>
              </header>
              <div className="media-viewer-body">
                {mediaViewer.previewKind === "image" ? (
                  <img src={mediaViewer.src} alt={mediaViewer.title} className="media-viewer-image" />
                ) : null}
                {mediaViewer.previewKind === "audio" ? (
                  <audio controls src={mediaViewer.src} preload="metadata" className="media-viewer-audio" />
                ) : null}
                {mediaViewer.previewKind === "video" ? (
                  <video controls src={mediaViewer.src} className="media-viewer-video" />
                ) : null}
                {mediaViewer.previewKind === "document" ? (
                  <iframe src={mediaViewer.src} title={mediaViewer.title} className="media-viewer-document" />
                ) : null}
                {mediaViewer.previewKind === "unsupported" ? (
                  <p className="empty-note">
                    Preview is not supported for this file type here yet. Use Download.
                  </p>
                ) : null}
                {mediaViewer.caption ? <p className="media-viewer-caption">{mediaViewer.caption}</p> : null}
              </div>
            </div>
          </div>
        ) : null}

        <footer className="composer-bar">
          <div className="composer-tools">
            <button className="icon-btn" onClick={() => imageInputRef.current?.click()} disabled={!selectedChat}>Photo</button>
            <button className="icon-btn" onClick={() => fileInputRef.current?.click()} disabled={!selectedChat}>File</button>
            <button className={`icon-btn ${showGifPicker ? "active" : ""}`} onClick={sendGifAction} disabled={!selectedChat}>GIF</button>
            {!recording ? (
              <button className="icon-btn" onClick={startRecording} disabled={!selectedChat}>Voice</button>
            ) : (
              <button className="icon-btn danger" onClick={stopRecording}>Stop ({recordSeconds}s)</button>
            )}
          </div>

          {pendingAttachments.length > 0 ? (
            <div className="pending-attachments">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.id} className="attachment-chip">
                  <span>{attachment.kind === "image" ? "Image" : "File"}: {attachment.name}</span>
                  <button className="tiny-btn danger" onClick={() => removePendingAttachment(attachment.id)}>Remove</button>
                </div>
              ))}
            </div>
          ) : null}

          <textarea
            value={composer}
            onChange={(e) => onComposerChange(e.target.value)}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            placeholder={selectedChat ? "Type a message, paste a file, or press Enter to send" : "Select a chat first"}
            disabled={!selectedChat}
          />

          <button
            className="primary-btn"
            onClick={sendTextAction}
            disabled={!selectedChat || (!composer.trim() && pendingAttachments.length === 0)}
          >
            Send
          </button>

          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={onSelectImage}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={onSelectFiles}
          />
        </footer>

        {showGifPicker ? (
          <section className="gif-picker">
            <div className="gif-search">
              <input
                value={gifQuery}
                onChange={(event) => setGifQuery(event.target.value)}
                placeholder="Search GIFs"
              />
              <span className="gif-provider">{gifProvider === "giphy" ? "Giphy" : "Tenor"}</span>
              <button className="icon-btn" onClick={() => setShowGifPicker(false)}>Close</button>
            </div>
            {gifLoading ? <p className="empty-note">Loading GIFs...</p> : null}
            {gifError ? <p className="gif-note">{gifError}</p> : null}
            {!gifLoading && gifResults.length === 0 ? <p className="empty-note">No GIF results found</p> : null}
            <div className="gif-grid">
              {gifResults.map((gif) => (
                <button key={gif.id} className="gif-tile" onClick={() => sendGifFromPicker(gif)} title={gif.title}>
                  <img src={gif.preview} alt={gif.title} />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="status-bar">{status}</div>
      </main>

      {incomingCall ? (
        <div className="overlay call-overlay">
          <div className="incoming-call-sheet">
            <div className="incoming-call-avatar">{incomingCallInitials}</div>
            <h3>{incomingCall.fromLabel}</h3>
            <p className="incoming-call-mode">
              {incomingCall.mode === "audio" ? "Audio call" : "Video call"} · end-to-end encrypted
            </p>
            <div className="call-actions incoming-call-actions">
              <button className="call-action-btn reject" onClick={rejectIncomingCall}>Decline</button>
              <button className="call-action-btn accept" onClick={acceptIncomingCall}>Accept</button>
            </div>
          </div>
        </div>
      ) : null}

      {activeCall ? (
        <div className="overlay call-overlay">
          <div className={`call-stage ${activeCall.mode === "video" ? "video-call" : "audio-call"}`}>
            <header className="call-stage-header">
              <div>
                <h3>{activeCall.peerLabel}</h3>
                <p>{activeCall.mode === "audio" ? "Audio" : "Video"} · {activeCallStatusLabel}</p>
              </div>
              <div className="call-stage-metrics">
                <span className={`quality-pill quality-${callQuality}`}>{activeCallQualityLabel}</span>
                <span className="duration-pill">
                  {activeCall.status === "active" ? formatDuration(callDurationSec) : "--:--"}
                </span>
              </div>
            </header>

            {activeCall.mode === "video" ? (
              <div className="video-stage">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className={`remote-video ${remoteVideoReady ? "visible" : "hidden"}`}
                  onLoadedData={() => setRemoteVideoReady(true)}
                />
                {!remoteVideoReady ? (
                  <div className="remote-placeholder">
                    <div className="audio-avatar-xl">{activeCallInitials}</div>
                    <p>{activeCallStatusLabel}...</p>
                  </div>
                ) : null}
                <div className={`local-preview ${callVideoOff ? "off" : ""}`}>
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    className="local-video"
                    onLoadedData={() => setLocalVideoReady(true)}
                  />
                  {callVideoOff || !localVideoReady ? (
                    <span>{callVideoOff ? "Camera Off" : "Starting Camera"}</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="audio-stage">
                <div className="audio-avatar-xl">{activeCallInitials}</div>
                <p>{activeCallStatusLabel}...</p>
                <small>High-fidelity secure channel</small>
              </div>
            )}

            <audio ref={remoteAudioRef} autoPlay playsInline />

            <div className="call-actions stage-call-actions">
              <button className={`call-control-btn ${callMuted ? "active" : ""}`} onClick={toggleMute}>
                {callMuted ? "Unmute" : "Mute"}
              </button>
              {activeCall.mode === "video" ? (
                <button className={`call-control-btn ${callVideoOff ? "active" : ""}`} onClick={toggleVideo}>
                  {callVideoOff ? "Video On" : "Video Off"}
                </button>
              ) : null}
              <button className="call-control-btn" onClick={reconnectCall} disabled={activeCall.status === "ringing"}>
                Reconnect
              </button>
              <button className="call-control-btn end" onClick={() => cleanupCall(true)}>End</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
