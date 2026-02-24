import { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../services/store.js";

const sendSchema = z.object({
  conversationId: z.string().min(4).max(100),
  clientMessageId: z.string().min(6).max(80).optional(),
  recipientUserId: z.string().min(4),
  ciphertext: z.string().min(16),
  nonce: z.string().min(8)
});

const sendBatchSchema = z.object({
  conversationId: z.string().min(4).max(100),
  clientMessageId: z.string().min(6).max(80).optional(),
  items: z.array(z.object({
    recipientUserId: z.string().min(4),
    ciphertext: z.string().min(16),
    nonce: z.string().min(8)
  })).min(1).max(200)
});

const editSchema = z.object({
  ciphertext: z.string().min(16),
  nonce: z.string().min(8)
});

const editByClientSchema = z.object({
  conversationId: z.string().min(4).max(100),
  items: z.array(z.object({
    recipientUserId: z.string().min(4),
    ciphertext: z.string().min(16),
    nonce: z.string().min(8)
  })).min(1).max(200)
});

const deleteByClientSchema = z.object({
  conversationId: z.string().min(4).max(100)
});

const clearConversationSchema = z.object({
  conversationId: z.string().min(4).max(100)
});

const typingSchema = z.object({
  conversationId: z.string().min(4).max(100),
  recipientUserIds: z.array(z.string().min(4)).min(1).max(200),
  ttlSeconds: z.coerce.number().int().min(2).max(20).default(8)
});

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/messages/send", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const senderUserId = request.user.sub;
    const senderDeviceId = request.user.deviceId;

    if (parsed.data.recipientUserId === senderUserId) {
      return reply.code(400).send({ error: "Cannot send messages to yourself" });
    }

    const recipient = await store.findUser(parsed.data.recipientUserId);
    if (!recipient) {
      return reply.code(404).send({ error: "Recipient not found" });
    }

    const saved = await store.saveMessage({
      conversationId: parsed.data.conversationId,
      clientMessageId: parsed.data.clientMessageId ?? null,
      senderUserId,
      senderDeviceId,
      recipientUserId: parsed.data.recipientUserId,
      ciphertext: parsed.data.ciphertext,
      nonce: parsed.data.nonce
    });

    return reply.code(201).send(saved);
  });

  app.post("/v1/messages/send-batch", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = sendBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const senderUserId = request.user.sub;
    const senderDeviceId = request.user.deviceId;
    const uniqueRecipients = Array.from(new Set(parsed.data.items.map((item) => item.recipientUserId)));

    if (uniqueRecipients.includes(senderUserId)) {
      return reply.code(400).send({ error: "Cannot send messages to yourself in batch mode" });
    }

    const checks = await Promise.all(uniqueRecipients.map((userId) => store.findUser(userId)));
    const missing = uniqueRecipients.filter((_, index) => !checks[index]);
    if (missing.length > 0) {
      return reply.code(404).send({ error: "Some recipients not found", missing });
    }

    const saved = await store.saveMessageBatch({
      senderUserId,
      senderDeviceId,
      conversationId: parsed.data.conversationId,
      clientMessageId: parsed.data.clientMessageId ?? null,
      items: parsed.data.items
    });

    return reply.code(201).send({ items: saved, count: saved.length });
  });

  app.get("/v1/messages/inbox", { preHandler: [app.requireAuth] }, async (request) => {
    const query = request.query as { since?: string };
    const messages = await store.listMessagesForUser(request.user.sub, query.since);
    return { items: messages, count: messages.length };
  });

  app.get("/v1/messages/thread/:contactUserId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { contactUserId: string };
    const query = request.query as { since?: string };

    const contact = await store.findUser(params.contactUserId);
    if (!contact) {
      return reply.code(404).send({ error: "Contact not found" });
    }

    const messages = await store.listConversation(request.user.sub, params.contactUserId, query.since);
    return { items: messages, count: messages.length };
  });

  app.get("/v1/messages/conversation/:conversationId", { preHandler: [app.requireAuth] }, async (request) => {
    const params = request.params as { conversationId: string };
    const query = request.query as { since?: string };
    const messages = await store.listConversationById(request.user.sub, params.conversationId, query.since);
    return { items: messages, count: messages.length };
  });

  app.patch("/v1/messages/:messageId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { messageId: string };
    const parsed = editSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const edited = await store.editMessageById({
      messageId: params.messageId,
      senderUserId: request.user.sub,
      ciphertext: parsed.data.ciphertext,
      nonce: parsed.data.nonce
    });

    if (!edited) {
      return reply.code(404).send({ error: "Message not found or not editable" });
    }

    return reply.send(edited);
  });

  app.patch("/v1/messages/by-client/:clientMessageId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { clientMessageId: string };
    const parsed = editByClientSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const edited = await store.editMessageByClientMessageId({
      conversationId: parsed.data.conversationId,
      clientMessageId: params.clientMessageId,
      senderUserId: request.user.sub,
      items: parsed.data.items
    });

    if (edited.length === 0) {
      return reply.code(404).send({ error: "Message not found or not editable" });
    }

    return reply.send({ items: edited, count: edited.length });
  });

  app.delete("/v1/messages/:messageId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { messageId: string };
    const deleted = await store.deleteMessageById(params.messageId, request.user.sub);
    if (!deleted) {
      return reply.code(404).send({ error: "Message not found or not deletable" });
    }
    return reply.code(204).send();
  });

  app.post("/v1/messages/:messageId/hide", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { messageId: string };
    const hidden = await store.hideMessageForUser(request.user.sub, params.messageId);
    if (!hidden) {
      return reply.code(404).send({ error: "Message not found" });
    }
    return reply.code(204).send();
  });

  app.post("/v1/messages/delete-by-client/:clientMessageId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { clientMessageId: string };
    const parsed = deleteByClientSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const count = await store.deleteMessageByClientMessageId(
      parsed.data.conversationId,
      params.clientMessageId,
      request.user.sub
    );

    if (count === 0) {
      return reply.code(404).send({ error: "Message not found or not deletable" });
    }

    return reply.send({ deleted: count });
  });

  app.post("/v1/messages/conversation/read/:conversationId", { preHandler: [app.requireAuth] }, async (request) => {
    const params = request.params as { conversationId: string };
    const updated = await store.markConversationRead(request.user.sub, params.conversationId);
    return { updated };
  });

  app.post("/v1/messages/conversation/clear", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = clearConversationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    await store.clearConversationForUser(request.user.sub, parsed.data.conversationId);
    return reply.code(204).send();
  });

  app.post("/v1/messages/typing", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = typingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const uniqueRecipients = Array.from(new Set(parsed.data.recipientUserIds))
      .filter((recipientId) => recipientId !== request.user.sub);

    if (uniqueRecipients.length === 0) {
      return reply.code(400).send({ error: "No valid recipients" });
    }

    const checks = await Promise.all(uniqueRecipients.map((userId) => store.findUser(userId)));
    const missing = uniqueRecipients.filter((_, index) => !checks[index]);
    if (missing.length > 0) {
      return reply.code(404).send({ error: "Some recipients not found", missing });
    }

    await Promise.all(uniqueRecipients.map((recipientId) => store.setTypingIndicator({
      conversationId: parsed.data.conversationId,
      fromUserId: request.user.sub,
      toUserId: recipientId,
      ttlSeconds: parsed.data.ttlSeconds
    })));

    return { ok: true };
  });

  app.get("/v1/messages/typing/:conversationId", { preHandler: [app.requireAuth] }, async (request) => {
    const params = request.params as { conversationId: string };
    const items = await store.listTypingIndicators(request.user.sub, params.conversationId);
    return { items, count: items.length };
  });
}
