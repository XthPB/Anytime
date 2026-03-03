import { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../services/store.js";
import { resolveCallIceServers } from "../services/turn.js";

const createCallSchema = z.object({
  participants: z.array(z.string().min(4)).min(1).max(8),
  mode: z.enum(["audio", "video"]).default("audio")
});

const signalSchema = z.object({
  callId: z.string().min(4),
  toUserId: z.string().min(4),
  encryptedPayload: z.string().min(12)
});

const clearCallHistorySchema = z.object({
  peerUserId: z.string().min(4)
});

export async function callRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/calls/ice", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const result = await resolveCallIceServers();
      return {
        iceServers: result.iceServers,
        ttlSeconds: result.ttlSeconds,
        source: result.source
      };
    } catch (error) {
      request.log.error({ error }, "failed to resolve call ICE servers");
      return reply.code(503).send({ error: "Unable to fetch call ICE servers" });
    }
  });

  app.post("/v1/calls/session", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = createCallSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const caller = request.user.sub;
    const participants = Array.from(new Set([caller, ...parsed.data.participants]));

    const checks = await Promise.all(participants.map((id) => store.findUser(id)));
    const missing = participants.filter((_, index) => !checks[index]);

    if (missing.length > 0) {
      return reply.code(404).send({ error: "Some participants not found", missing });
    }

    return reply.code(201).send(await store.createCall(participants, caller, parsed.data.mode));
  });

  app.post("/v1/calls/signal", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = signalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const recipient = await store.findUser(parsed.data.toUserId);
    if (!recipient) {
      return reply.code(404).send({ error: "Recipient not found" });
    }

    const senderDevice = await store.findDevice(request.user.sub, request.user.deviceId);
    if (!senderDevice) {
      return reply.code(404).send({ error: "Sender device not found" });
    }

    const envelope = await store.enqueueSignal({
      callId: parsed.data.callId,
      fromUserId: request.user.sub,
      toUserId: parsed.data.toUserId,
      senderPublicEncryptionKey: senderDevice.encryptionPublicKey,
      encryptedPayload: parsed.data.encryptedPayload
    });

    return reply.code(201).send(envelope);
  });

  app.get("/v1/calls/signal/pull", { preHandler: [app.requireAuth] }, async (request) => {
    const signals = await store.dequeueSignals(request.user.sub);
    return { items: signals, count: signals.length };
  });

  app.post("/v1/calls/:callId/end", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { callId: string };
    const ended = await store.endCall(params.callId, request.user.sub);
    if (!ended) {
      return reply.code(404).send({ error: "Call not found" });
    }
    return reply.code(204).send();
  });

  app.get("/v1/calls/history/:peerUserId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { peerUserId: string };
    const peer = await store.findUser(params.peerUserId);
    if (!peer) {
      return reply.code(404).send({ error: "Peer user not found" });
    }

    const calls = await store.listCallHistoryForPeer(request.user.sub, params.peerUserId, 100);
    return { items: calls, count: calls.length };
  });

  app.post("/v1/calls/history/clear", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = clearCallHistorySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    if (parsed.data.peerUserId === request.user.sub) {
      return reply.code(400).send({ error: "Cannot clear self call history" });
    }

    const peer = await store.findUser(parsed.data.peerUserId);
    if (!peer) {
      return reply.code(404).send({ error: "Peer user not found" });
    }

    await store.clearCallHistoryForPeer(request.user.sub, parsed.data.peerUserId);
    return reply.code(204).send();
  });
}
