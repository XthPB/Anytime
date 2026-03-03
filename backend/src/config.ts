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
  TURN_PROVIDER: z.enum(["disabled", "static", "twilio", "coturn"]).default("disabled"),
  TURN_STATIC_ICE_SERVERS_JSON: z.string().optional(),
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  TURN_COTURN_SHARED_SECRET: z.string().optional(),
  TURN_COTURN_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(600),
  TURN_COTURN_USER_PREFIX: z.string().default("u"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_TURN_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(600)
}).superRefine((input, ctx) => {
  if (input.TURN_PROVIDER === "twilio") {
    if (!input.TWILIO_ACCOUNT_SID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_ACCOUNT_SID"],
        message: "Required when TURN_PROVIDER=twilio"
      });
    }
    if (!input.TWILIO_AUTH_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TWILIO_AUTH_TOKEN"],
        message: "Required when TURN_PROVIDER=twilio"
      });
    }
  }

  if (input.TURN_PROVIDER === "coturn") {
    if (!input.TURN_URLS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_URLS"],
        message: "Required when TURN_PROVIDER=coturn"
      });
    }
    if (!input.TURN_COTURN_SHARED_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURN_COTURN_SHARED_SECRET"],
        message: "Required when TURN_PROVIDER=coturn"
      });
    }
  }
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
