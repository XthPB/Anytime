import { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../services/store.js";

const createGroupSchema = z.object({
  name: z.string().min(2).max(64),
  memberUserIds: z.array(z.string().min(4)).min(1).max(200)
});

export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/groups", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const ownerUserId = request.user.sub;
    const uniqueMembers = Array.from(new Set(parsed.data.memberUserIds)).filter((userId) => userId !== ownerUserId);

    const checks = await Promise.all(uniqueMembers.map((userId) => store.findUser(userId)));
    const missing = uniqueMembers.filter((_, index) => !checks[index]);
    if (missing.length > 0) {
      return reply.code(404).send({ error: "Some users not found", missing });
    }

    const created = await store.createGroup({
      ownerUserId,
      name: parsed.data.name,
      memberUserIds: uniqueMembers
    });

    return reply.code(201).send(created);
  });

  app.get("/v1/groups", { preHandler: [app.requireAuth] }, async (request) => {
    const groups = await store.listGroupsForUser(request.user.sub);
    return { items: groups, count: groups.length };
  });
}
