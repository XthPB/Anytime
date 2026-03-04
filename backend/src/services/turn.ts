import { env } from "../config.js";
import { createHmac, randomBytes } from "node:crypto";

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: string;
};

type TurnResponse = {
  iceServers: IceServerConfig[];
  ttlSeconds: number;
  source: "default" | "static" | "twilio" | "coturn" | "cloudflare";
};

type ManagedProvider = "cloudflare" | "twilio" | "coturn" | "static";

const DEFAULT_ICE_SERVERS: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

const TWILIO_REFRESH_BUFFER_MS = 30_000;
const CLOUDFLARE_REFRESH_BUFFER_MS = 20_000;
const TURN_HTTP_TIMEOUT_MS = 4_500;
const TURN_HTTP_RETRIES = 2;

let cachedTwilio: { expiresAtMs: number; response: TurnResponse } | null = null;
const cachedCloudflareByUser = new Map<string, { expiresAtMs: number; response: TurnResponse }>();

function parseTurnUrlsCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sanitizeIceServers(input: unknown): IceServerConfig[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is IceServerConfig => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as IceServerConfig;
    const urls = Array.isArray(candidate.urls) ? candidate.urls : [candidate.urls];
    return urls.some((url) => typeof url === "string" && url.trim().length > 0);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function shouldRetryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /network|fetch|timeout/i.test(error.message);
}

async function fetchTurnJsonWithRetry<T>(input: string, init: RequestInit): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= TURN_HTTP_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TURN_HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal
      });

      if (!response.ok) {
        if (attempt < TURN_HTTP_RETRIES && shouldRetryStatus(response.status)) {
          await sleep(160 * (attempt + 1));
          continue;
        }
        throw new Error(`TURN provider HTTP ${response.status}`);
      }

      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < TURN_HTTP_RETRIES && shouldRetryError(error)) {
        await sleep(180 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("TURN provider request failed");
}

function staticIceResponse(): TurnResponse | null {
  if (env.TURN_STATIC_ICE_SERVERS_JSON) {
    try {
      const parsed = JSON.parse(env.TURN_STATIC_ICE_SERVERS_JSON) as unknown;
      const custom = sanitizeIceServers(parsed);
      if (custom.length > 0) {
        return {
          iceServers: [...DEFAULT_ICE_SERVERS, ...custom],
          ttlSeconds: 3600,
          source: "static"
        };
      }
    } catch {
      // Ignore malformed JSON and fall through.
    }
  }

  const urls = parseTurnUrlsCsv(env.TURN_URLS);

  if (urls.length === 0) {
    return null;
  }

  return {
    iceServers: [
      ...DEFAULT_ICE_SERVERS,
      {
        urls,
        username: env.TURN_USERNAME ?? "",
        credential: env.TURN_CREDENTIAL ?? ""
      }
    ],
    ttlSeconds: 3600,
    source: "static"
  };
}

function sanitizeUsernamePart(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 48) : "anon";
}

function coturnIceResponse(userId: string): TurnResponse | null {
  const urls = parseTurnUrlsCsv(env.TURN_URLS);
  const sharedSecret = env.TURN_COTURN_SHARED_SECRET;
  if (urls.length === 0 || !sharedSecret) {
    return null;
  }

  const ttl = env.TURN_COTURN_TTL_SECONDS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const nonce = randomBytes(4).toString("hex");
  const userToken = sanitizeUsernamePart(userId);
  const username = `${expiresAt}:${env.TURN_COTURN_USER_PREFIX}:${userToken}:${nonce}`;
  const credential = createHmac("sha1", sharedSecret).update(username).digest("base64");

  return {
    iceServers: [
      ...DEFAULT_ICE_SERVERS,
      {
        urls,
        username,
        credential
      }
    ],
    ttlSeconds: ttl,
    source: "coturn"
  };
}

async function twilioIceResponse(): Promise<TurnResponse | null> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    return null;
  }

  const now = Date.now();
  if (cachedTwilio && cachedTwilio.expiresAtMs > now + TWILIO_REFRESH_BUFFER_MS) {
    return cachedTwilio.response;
  }

  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ Ttl: String(env.TWILIO_TURN_TTL_SECONDS) });
  let payload: {
    ice_servers?: IceServerConfig[];
    ttl?: number | string;
    date_expires?: string;
  };
  try {
    payload = await fetchTurnJsonWithRetry<{
      ice_servers?: IceServerConfig[];
      ttl?: number | string;
      date_expires?: string;
    }>(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Tokens.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${auth}`,
          "content-type": "application/x-www-form-urlencoded"
        },
        body
      }
    );
  } catch (error) {
    if (cachedTwilio && cachedTwilio.expiresAtMs > now + 1_000) {
      return cachedTwilio.response;
    }
    throw error;
  }

  const servers = sanitizeIceServers(payload.ice_servers);
  if (servers.length === 0) {
    throw new Error("TURN provider returned no ICE servers");
  }

  const ttlSeconds = Number(payload.ttl);
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : env.TWILIO_TURN_TTL_SECONDS;
  const expiresAtMs = payload.date_expires
    ? Date.parse(payload.date_expires)
    : now + (ttl * 1000);

  const result: TurnResponse = {
    iceServers: servers,
    ttlSeconds: ttl,
    source: "twilio"
  };

  cachedTwilio = {
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : (now + (ttl * 1000)),
    response: result
  };
  return result;
}

async function cloudflareIceResponse(userId: string): Promise<TurnResponse | null> {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) {
    return null;
  }

  const now = Date.now();
  const cached = cachedCloudflareByUser.get(userId);
  if (cached && cached.expiresAtMs > now + CLOUDFLARE_REFRESH_BUFFER_MS) {
    return cached.response;
  }

  let payload: {
    iceServers?: IceServerConfig[];
    ice_servers?: IceServerConfig[];
    ttl?: number | string;
  };
  try {
    payload = await fetchTurnJsonWithRetry<{
      iceServers?: IceServerConfig[];
      ice_servers?: IceServerConfig[];
      ttl?: number | string;
    }>(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ttl: env.CF_TURN_TTL_SECONDS })
      }
    );
  } catch (error) {
    if (cached && cached.expiresAtMs > now + 1_000) {
      return cached.response;
    }
    throw error;
  }

  const servers = sanitizeIceServers(payload.iceServers ?? payload.ice_servers);
  if (servers.length === 0) {
    throw new Error("TURN provider returned no ICE servers");
  }

  const ttlValue = Number(payload.ttl);
  const ttl = Number.isFinite(ttlValue) && ttlValue > 0 ? Math.floor(ttlValue) : env.CF_TURN_TTL_SECONDS;
  const result: TurnResponse = {
    iceServers: servers,
    ttlSeconds: ttl,
    source: "cloudflare"
  };
  cachedCloudflareByUser.set(userId, {
    expiresAtMs: now + (ttl * 1000),
    response: result
  });
  return result;
}

async function resolveProvider(provider: ManagedProvider, userId: string): Promise<TurnResponse | null> {
  if (provider === "cloudflare") return cloudflareIceResponse(userId);
  if (provider === "twilio") return twilioIceResponse();
  if (provider === "coturn") return coturnIceResponse(userId);
  return staticIceResponse();
}

function orderedProviders(primary: ManagedProvider | "disabled"): ManagedProvider[] {
  const base: ManagedProvider[] = ["cloudflare", "twilio", "coturn", "static"];
  if (primary === "disabled") return [];
  return [primary, ...base.filter((item) => item !== primary)];
}

export async function resolveCallIceServers(userId: string): Promise<TurnResponse> {
  const providers = orderedProviders(env.TURN_PROVIDER);
  for (const provider of providers) {
    try {
      const result = await resolveProvider(provider, userId);
      if (result) return result;
    } catch {
      // Try configured fallback providers before giving up.
      continue;
    }
  }

  return {
    iceServers: DEFAULT_ICE_SERVERS,
    ttlSeconds: 600,
    source: "default"
  };
}
