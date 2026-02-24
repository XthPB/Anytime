import Fastify from "fastify";
import { env } from "./config.js";
import { registerAuth } from "./plugins/auth.js";
import { registerSecurity } from "./plugins/security.js";
import { authRoutes } from "./routes/auth.js";
import { callRoutes } from "./routes/calls.js";
import { groupRoutes } from "./routes/groups.js";
import { healthRoutes } from "./routes/health.js";
import { keyRoutes } from "./routes/keys.js";
import { messageRoutes } from "./routes/messages.js";
import { userRoutes } from "./routes/users.js";
import { store } from "./services/store.js";

async function buildServer() {
  const app = Fastify({ logger: true });

  await registerSecurity(app);
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(groupRoutes);
  await app.register(keyRoutes);
  await app.register(messageRoutes);
  await app.register(callRoutes);

  return app;
}

async function start() {
  await store.init();
  const app = await buildServer();

  const shutdown = async () => {
    await app.close();
    await store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await app.listen({
      host: env.HOST,
      port: env.PORT
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
