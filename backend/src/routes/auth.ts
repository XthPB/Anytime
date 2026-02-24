import { FastifyInstance } from "fastify";
import { z } from "zod";
import { isLikelyEd25519PublicKey, verifyEd25519Signature } from "../services/crypto.js";
import { store } from "../services/store.js";

const registerSchema = z.object({
  deviceName: z.string().min(1).max(64),
  deviceSigningPublicKey: z.string().min(20),
  deviceEncryptionPublicKey: z.string().min(20)
});

const challengeSchema = z.object({
  userId: z.string().min(4),
  deviceId: z.string().min(4)
});

const verifySchema = z.object({
  userId: z.string().min(4),
  deviceId: z.string().min(4),
  signature: z.string().min(20)
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/identity/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    if (!isLikelyEd25519PublicKey(parsed.data.deviceSigningPublicKey)) {
      return reply.code(400).send({ error: "deviceSigningPublicKey must be base64url-encoded Ed25519 32-byte key" });
    }

    if (parsed.data.deviceEncryptionPublicKey.length < 32) {
      return reply.code(400).send({ error: "deviceEncryptionPublicKey is invalid" });
    }

    const created = await store.createUser(parsed.data);
    const token = app.jwt.sign({ sub: created.user.userId, deviceId: created.device.deviceId });

    return reply.code(201).send({
      userId: created.user.userId,
      deviceId: created.device.deviceId,
      token,
      createdAt: created.user.createdAt
    });
  });

  app.get("/v1/identity/me", { preHandler: [app.requireAuth] }, async (request) => {
    return {
      userId: request.user.sub,
      deviceId: request.user.deviceId
    };
  });

  app.post("/v1/identity/challenge", async (request, reply) => {
    const parsed = challengeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const device = await store.findDevice(parsed.data.userId, parsed.data.deviceId);
    if (!device) {
      return reply.code(404).send({ error: "User/device not found" });
    }

    const challenge = await store.issueChallenge(parsed.data.userId, parsed.data.deviceId);
    return reply.send({ challenge, expiresInSeconds: 180 });
  });

  app.post("/v1/identity/verify", async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const challenge = await store.consumeChallenge(parsed.data.userId, parsed.data.deviceId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      return reply.code(400).send({ error: "Challenge missing or expired" });
    }

    const device = await store.findDevice(parsed.data.userId, parsed.data.deviceId);
    if (!device) {
      return reply.code(404).send({ error: "User/device not found" });
    }

    const ok = await verifyEd25519Signature({
      publicKeyBase64Url: device.signingPublicKey,
      message: challenge.challenge,
      signatureBase64Url: parsed.data.signature
    });

    if (!ok) {
      return reply.code(401).send({ error: "Signature verification failed" });
    }

    const token = app.jwt.sign({ sub: parsed.data.userId, deviceId: parsed.data.deviceId });
    return reply.send({ token });
  });
}
