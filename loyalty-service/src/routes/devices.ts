/**
 * `POST /v1/devices` and `DELETE /v1/devices/:token` — register and
 * de-register a customer's push Device_Tokens (task 19.1).
 *
 * Surfaces the mobile-readiness device registry (`devices/deviceTokens.ts`)
 * over the versioned `/v1` API (design.md `/v1` route table:
 * `POST /v1/devices` → register a Device_Token, `DELETE /v1/devices/:token` →
 * de-register). Both are ADDITIVE `/v1` endpoints introduced without altering
 * any existing web request/response contract (Req 19.1, 19.7).
 *
 * IDENTITY (Req 9.2/9.3): both handlers read only `req.authCtx.customerId`,
 * resolved by the `/v1` auth preHandler (task 6.2) identically for App Proxy
 * (web) and Customer Account API (mobile/portal) requests, so a token is always
 * bound to the resolved customer — never to a raw client-supplied id.
 *
 * IDEMPOTENCY (Req 9.6/9.7): `POST` and `DELETE` are state-changing, so the
 * scope-level idempotency plugin requires an `Idempotency-Key` and replays a
 * repeated key within the 24h window. Registration and de-registration are also
 * idempotent at the data layer (upsert on `(customer_id, token)`; de-register
 * is a no-op on an unknown/already-revoked token), so retries are safe.
 *
 * OFF-LEDGER: registering/de-registering a device never touches the ledger and
 * never affects the customer's Balance (Req 19.7).
 *
 * SAFETY: defining this module touches no live/production system. The default
 * store is in-memory; a {@link PgDeviceTokenStore} is injected at deploy time.
 * Route logic is unit-tested with the in-memory store, so no live Postgres is
 * required during verification.
 */
import { requireCustomerScope } from "../auth/customerScope.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  InMemoryDeviceTokenStore,
  deviceRegistrationSchema,
  type DeviceTokenStore,
} from "../devices/deviceTokens.js";

/** Options accepted by {@link registerDeviceRoutes}. */
export interface DeviceRouteOptions {
  /**
   * Registers/de-registers/lists a customer's push Device_Tokens. Defaults to
   * an in-memory store so the routes boot without a live Postgres; a
   * {@link PgDeviceTokenStore} is injected at deploy time.
   */
  deviceTokenStore?: DeviceTokenStore;
}

/** `POST /v1/devices` success body (additive: design's contract is `void`). */
interface RegisterResponse {
  registered: true;
  platform: string;
}

/** `DELETE /v1/devices/:token` success body (additive: design's contract is `void`). */
interface DeregisterResponse {
  deregistered: true;
}

/**
 * Registers `POST /v1/devices` and `DELETE /v1/devices/:token` on `app`. MUST
 * be called inside the `/v1` router scope so the auth preHandler has already
 * resolved `req.authCtx` (task 6.2) and the idempotency preHandler gates the
 * state-changing requests (Req 9.6/9.7) before these handlers run.
 *
 * Responds `401` if auth did not attach an identity (defensive — the preHandler
 * normally rejects first), `400` on an invalid registration body, and otherwise
 * `200` with a small additive JSON body (wrapped in an object so the versioning
 * plugin can inject the version field).
 */
export function registerDeviceRoutes(app: FastifyInstance, opts: DeviceRouteOptions = {}): void {
  const store = opts.deviceTokenStore ?? new InMemoryDeviceTokenStore();

  // Register a Device_Token for the resolved customer (Req 19.1). Idempotent per
  // (customer, token) at the data layer; the idempotency plugin additionally
  // replays a repeated Idempotency-Key.
  app.post("/devices", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const parsed = deviceRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_device_registration",
        message: "A device registration requires a non-empty 'token' and a 'platform' of 'ios' or 'android'.",
      });
    }

    await store.register(ctx.customerId, parsed.data);
    return { registered: true, platform: parsed.data.platform } satisfies RegisterResponse;
  });

  // De-register a Device_Token for the resolved customer (Req 19.1). A no-op for
  // an unknown/already-revoked token, so it is safely idempotent.
  app.delete("/devices/:token", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = requireCustomerScope(req);

    const { token } = req.params as { token: string };
    if (typeof token !== "string" || token.trim() === "") {
      return reply.code(400).send({
        error: "invalid_device_token",
        message: "A device token path parameter is required.",
      });
    }

    await store.deregister(ctx.customerId, token);
    return { deregistered: true } satisfies DeregisterResponse;
  });
}
