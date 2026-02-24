import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      deviceId: string;
    };
    user: {
      sub: string;
      deviceId: string;
    };
  }
}
