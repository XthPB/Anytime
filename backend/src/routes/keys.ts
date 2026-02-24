import { FastifyInstance } from "fastify";
import { z } from "zod";
import { store } from "../services/store.js";

const uploadSchema = z.object({
  signedPreKey: z.string().min(10),
  signedPreKeySignature: z.string().min(10),
  oneTimePreKeys: z.array(z.string().min(10)).max(2000)
});

export async function keyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/keys/prekeys/upload", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const parsed = uploadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    }

    const userId = request.user.sub;
    const exists = await store.findUser(userId);
    if (!exists) return reply.code(404).send({ error: "User not found" });

    await store.setPreKeyBundle(userId, parsed.data);
    return reply.code(201).send({ ok: true, uploadedPreKeys: parsed.data.oneTimePreKeys.length });
  });

  app.get("/v1/keys/prekeys/:userId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const params = request.params as { userId: string };
    const bundle = await store.popPreKeyBundle(params.userId);
    if (!bundle) return reply.code(404).send({ error: "No prekey bundle for user" });
    return reply.send(bundle);
  });
}
