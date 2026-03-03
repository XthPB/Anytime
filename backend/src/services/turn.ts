import { env } from "../config.js";

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: string;
};

type TurnResponse = {
  iceServers: IceServerConfig[];
  ttlSeconds: number;
  source: "default" | "static" | "twilio";
};

const DEFAULT_ICE_SERVERS: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

const TWILIO_REFRESH_BUFFER_MS = 30_000;

let cachedTwilio: { expiresAtMs: number; response: TurnResponse } | null = null;

function sanitizeIceServers(input: unknown): IceServerConfig[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is IceServerConfig => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as IceServerConfig;
    const urls = Array.isArray(candidate.urls) ? candidate.urls : [candidate.urls];
    return urls.some((url) => typeof url === "string" && url.trim().length > 0);
  });
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

  const urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

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
  const response = await fetch(
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

  if (!response.ok) {
    throw new Error(`TURN provider HTTP ${response.status}`);
  }

  const payload = await response.json() as {
    ice_servers?: IceServerConfig[];
    ttl?: number | string;
    date_expires?: string;
  };

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

export async function resolveCallIceServers(): Promise<TurnResponse> {
  if (env.TURN_PROVIDER === "twilio") {
    const twilio = await twilioIceResponse();
    if (twilio) return twilio;
  }

  if (env.TURN_PROVIDER === "static") {
    const staticConfig = staticIceResponse();
    if (staticConfig) return staticConfig;
  }

  return {
    iceServers: DEFAULT_ICE_SERVERS,
    ttlSeconds: 600,
    source: "default"
  };
}
