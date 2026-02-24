import { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../services/store.js";

const addContactSchema = z.object({
  contactUserId: z.string().min(4),
  nickname: z.string().min(1).max(50).optional()
});

const updateContactSchema = z.object({
  nickname: z.string().min(1).max(50).nullable()
});

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/users/:userId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { userId: string };
    const profile = await store.findUserPublicProfile(params.userId);

    if (!profile) {
      return reply.code(404).send({ error: "User not found" });
    }

    return reply.send(profile);
  });

  app.post("/v1/users/contacts", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = addContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    if (parsed.data.contactUserId === request.user.sub) {
      return reply.code(400).send({ error: "Cannot add yourself as contact" });
    }

    const contactExists = await store.findUser(parsed.data.contactUserId);
    if (!contactExists) {
      return reply.code(404).send({ error: "Contact user not found" });
    }

    const contact = await store.addContact(request.user.sub, parsed.data.contactUserId, parsed.data.nickname);
    return reply.code(201).send(contact);
  });

  app.get("/v1/users/contacts", { preHandler: [app.requireAuth] }, async (request) => {
    const contacts = await store.listContacts(request.user.sub);
    return { items: contacts, count: contacts.length };
  });

  app.patch("/v1/users/contacts/:contactUserId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { contactUserId: string };
    const parsed = updateContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const updated = await store.updateContactNickname(
      request.user.sub,
      params.contactUserId,
      parsed.data.nickname
    );

    if (!updated) {
      return reply.code(404).send({ error: "Contact not found" });
    }

    return reply.send(updated);
  });

  app.delete("/v1/users/contacts/:contactUserId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { contactUserId: string };
    const deleted = await store.deleteContact(request.user.sub, params.contactUserId);
    if (!deleted) {
      return reply.code(404).send({ error: "Contact not found" });
    }
    return reply.code(204).send();
  });
}
