import jwt from "@fastify/jwt";
import { FastifyInstance } from "fastify";
import { env } from "../config.js";

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: "30d"
    }
  });

  app.decorate("requireAuth", async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (request: any, reply: any) => Promise<void>;
  }
}
