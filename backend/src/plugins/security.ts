import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { FastifyInstance } from "fastify";
import { corsOrigins } from "../config.js";

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false
  });

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true
  });

  await app.register(rateLimit, {
    max: 150,
    timeWindow: "1 minute"
  });
}
