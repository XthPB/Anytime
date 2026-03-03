import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CORS_ORIGINS: z.string().default("*"),
  DATABASE_URL: z.string().url(),
  MAX_INBOX_BATCH: z.coerce.number().int().positive().max(1000).default(200),
  TURN_PROVIDER: z.enum(["disabled", "static", "twilio"]).default("disabled"),
  TURN_STATIC_ICE_SERVERS_JSON: z.string().optional(),
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_TURN_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(600)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS === "*"
  ? true
  : env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
