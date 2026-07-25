import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { API_VERSION, API_VERSION_FIELD, API_VERSION_HEADER } from "../version.js";

/**
 * Emits the API version identifier on every JSON response (Requirement 9.8),
 * and enforces stateless request handling by never setting session cookies.
 *
 * Two mechanisms, so the version is always discoverable:
 *  1. An `x-api-version` response header on every response.
 *  2. An `apiVersion` field injected into every JSON object payload.
 */
export function registerVersioning(app: FastifyInstance): void {
  // 1. Header on every response.
  app.addHook("onRequest", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header(API_VERSION_HEADER, API_VERSION);
  });

  // 2. Version field inside every JSON object payload.
  app.addHook("preSerialization", async (_req, _reply, payload) => {
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as Record<string, unknown>;
      if (!(API_VERSION_FIELD in record)) {
        return { ...record, [API_VERSION_FIELD]: API_VERSION };
      }
    }
    return payload;
  });
}
