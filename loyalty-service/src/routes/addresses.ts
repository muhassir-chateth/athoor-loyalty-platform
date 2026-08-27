/**
 * `/v1/profile/addresses` CRUD and default selection (N8) — spec task 14.3,
 * design §13.5, Req 13.5, 2.2, 2.3, 5.2, 21.7.
 *
 * ── OWNERSHIP IS STRUCTURAL: THERE IS NO COMPARISON TO FORGET ───────────────
 * §13.5 states the property exactly: "the mutation is issued against the customer
 * GID derived from ⟨scope⟩, so a foreign `addressId` is rejected by Shopify and
 * mapped to `404` with no address attribute in the body — there is no ownership
 * comparison in our handler to forget."
 *
 * That is worth restating as a mechanism. Every mutation sends `customerId` = OUR
 * GID, bound by the allowlist client from the sanctioned lookup. An `addressId`
 * belonging to somebody else is therefore not an address of the customer named in
 * the same request, so Shopify has nothing to act on and refuses. The handler never
 * compares two ids, which means it cannot compare them wrongly — the class of bug
 * where an ownership check exists but is skipped on one branch is unreachable here.
 *
 * ── EACH ADDRESS IS ITS OWN MUTATION ───────────────────────────────────────
 * No batching, per task 14.3, so a failure names the address that failed. A batched
 * write would tell a customer "one of your addresses was rejected".
 *
 * ── A REFUSAL ON A WRITE BY ID IS A 404, NOT A 400 ──────────────────────────
 * When Shopify refuses an `addressId` the portal cannot tell "this address does not
 * exist" from "it is not yours", and Requirement 2.2 wants exactly that: both answer
 * `404` with no attribute of the resource in the body. A `400` naming the field
 * would leak that the id was well-formed but unowned.
 *
 * SAFETY: no SQL. Every write goes through the six-name allowlist client.
 */
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import { z } from "zod";
import { requireCustomerScope, type CustomerScope } from "../auth/customerScope.js";
import {
  readCustomerAddresses,
  type CustomerIdentityReadDeps,
} from "../portal/repository/customerIdentity.js";
import {
  createCustomerAddress,
  deleteCustomerAddress,
  setDefaultCustomerAddress,
  updateCustomerAddress,
  type CustomerMutationDeps,
} from "../portal/repository/customerMutations.js";
import { PortalWriteRejectedError } from "../portal/userErrorCodes.js";
import type { PortalAddressesResponse } from "../portal/types.js";
import { createRedemptionRateLimiter, type RedemptionRateLimiterOptions } from "../plugins/rateLimit.js";
import { mapPortalWriteFailure, type ProfileWriteDeps } from "./profileWriteSupport.js";

/** `/v1/profile/addresses` write rate limit: 20 per hour (task 14.3). */
export const ADDRESS_RATE_LIMIT_MAX_REQUESTS = 20 as const;
export const ADDRESS_RATE_LIMIT_WINDOW_MS = 3_600_000 as const;

/**
 * The address body (§6.3's `PortalAddressInput`).
 *
 * Every field OPTIONAL and `.strip()`ed. Optional because Shopify's
 * `MailingAddressInput` makes them optional and it is the authoritative validator
 * for address content (§13.4: "the portal validates SHAPE and lets Shopify validate
 * CONTENT" — it knows country-specific postcode rules and phone normalisation, and
 * we do not). Stripped because `id` and `isDefault` are not settable here: an id is
 * assigned by Shopify, and the default is its own route, so accepting either would
 * be accepting a value that silently does nothing.
 */
export const ADDRESS_BODY_SCHEMA = z
  .object({
    firstName: z.string().max(255).optional(),
    lastName: z.string().max(255).optional(),
    address1: z.string().max(255).optional(),
    address2: z.string().max(255).optional(),
    city: z.string().max(255).optional(),
    province: z.string().max(255).optional(),
    zip: z.string().max(64).optional(),
    countryCode: z.string().min(2).max(2).optional(),
    phone: z.string().max(64).optional(),
  })
  .strip();

/**
 * A Shopify address id, as it arrives in the path.
 *
 * Accepts either the bare numeric id or the full GID, because a client that read
 * `id` from a previous response holds a GID and should be able to send it back
 * unchanged. Anything else is refused BEFORE a request is made — an unvalidated
 * path segment reaching a GraphQL variable is how an id becomes an injection
 * vector.
 */
const ADDRESS_ID_PATTERN = /^(?:gid:\/\/shopify\/MailingAddress\/[A-Za-z0-9_?=-]+|\d+)$/;

/** Options accepted by {@link registerAddressRoutes}. */
export interface AddressRouteOptions {
  /** Absent → every route REFUSES with `502`. The routes register regardless. */
  deps?: CustomerIdentityReadDeps & CustomerMutationDeps;
  addressRateLimit?: RedemptionRateLimiterOptions;
  addressRateLimiter?: preHandlerAsyncHookHandler;
}

/** Raised when no Shopify source is wired. */
export class AddressSourceUnconfiguredError extends Error {
  readonly code = "address_source_unconfigured" as const;
  constructor() {
    super("No Shopify source is configured for the address routes.");
    this.name = "AddressSourceUnconfiguredError";
  }
}

function requireSource(deps: ProfileWriteDeps): CustomerIdentityReadDeps & CustomerMutationDeps {
  if (deps.source === null) throw new AddressSourceUnconfiguredError();
  return deps.source;
}

/** Normalises a path id to the GID form Shopify's mutations take. */
function toAddressGid(raw: string): string | null {
  if (!ADDRESS_ID_PATTERN.test(raw)) return null;
  return raw.startsWith("gid://") ? raw : `gid://shopify/MailingAddress/${raw}`;
}

/**
 * Registers the five N8 routes. MUST be called inside the `/v1` router scope so auth
 * and idempotency have already run.
 */
export function registerAddressRoutes(
  app: FastifyInstance,
  opts: AddressRouteOptions = {},
): void {
  // REGISTERED UNCONDITIONALLY with a refusing dependency — see the identity routes.
  const deps: ProfileWriteDeps = { source: opts.deps ?? null };

  const limiter =
    opts.addressRateLimiter ??
    createRedemptionRateLimiter({
      maxRequests: ADDRESS_RATE_LIMIT_MAX_REQUESTS,
      windowMs: ADDRESS_RATE_LIMIT_WINDOW_MS,
      subject: "address",
      ...(opts.addressRateLimit ?? {}),
    });

  /** Reads the list, which every write returns so the client needs no follow-up. */
  const list = async (
    source: CustomerIdentityReadDeps & CustomerMutationDeps,
    scope: CustomerScope,
  ): Promise<PortalAddressesResponse> => ({
    addresses: await readCustomerAddresses(source, scope),
  });

  /* --------------------------------- read ---------------------------------- */
  app.get("/profile/addresses", async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = requireCustomerScope(req);
    try {
      // Inside the try, so an UNWIRED source maps to 502 rather than 500.
      return await list(requireSource(deps), scope);
    } catch (err) {
      return mapPortalWriteFailure(err, reply);
    }
  });

  /* -------------------------------- create --------------------------------- */
  app.post(
    "/profile/addresses",
    { preHandler: [limiter] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const scope = requireCustomerScope(req);
      let source: CustomerIdentityReadDeps & CustomerMutationDeps;
      try {
        source = requireSource(deps);
      } catch (err) {
        return mapPortalWriteFailure(err, reply);
      }

      const parsed = ADDRESS_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) return badShape(reply, parsed.error.issues);

      try {
        const created = await createCustomerAddress(source, scope, parsed.data);
        // The created address AND the resulting list, so a client can render either
        // without a second request.
        return reply.code(201).send({ address: created, ...(await list(source, scope)) });
      } catch (err) {
        if (err instanceof PortalWriteRejectedError) {
          // A create has no id to hide, so the field codes are safe to return and
          // are the only thing that lets the customer fix the address.
          return reply.code(400).send({
            error: "invalid_request",
            message: "Shopify did not accept this address.",
            fields: err.fields,
            retryable: true,
          });
        }
        return mapPortalWriteFailure(err, reply);
      }
    },
  );

  /* -------------------------------- update --------------------------------- */
  app.put<{ Params: { addressId: string }; Body: unknown }>(
    "/profile/addresses/:addressId",
    { preHandler: [limiter] },
    async (req: FastifyRequest<{ Params: { addressId: string } }>, reply: FastifyReply) => {
      const scope = requireCustomerScope(req);
      let source: CustomerIdentityReadDeps & CustomerMutationDeps;
      try {
        source = requireSource(deps);
      } catch (err) {
        return mapPortalWriteFailure(err, reply);
      }

      const gid = toAddressGid(req.params.addressId);
      // A malformed id is a 404, not a 400: telling the caller their id was the
      // wrong SHAPE is more than a stranger needs to learn, and an absent address
      // and an unparseable one are equally "not yours".
      if (gid === null) return notFound(reply);

      const parsed = ADDRESS_BODY_SCHEMA.safeParse(req.body);
      if (!parsed.success) return badShape(reply, parsed.error.issues);

      try {
        const updated = await updateCustomerAddress(source, scope, gid, parsed.data);
        if (updated === null) return notFound(reply);
        return { address: updated, ...(await list(source, scope)) };
      } catch (err) {
        // A refusal on a write BY ID is a 404 (see the module header): the portal
        // cannot tell "no such address" from "not yours", and Req 2.2 wants both to
        // answer identically with no attribute of the resource in the body.
        if (err instanceof PortalWriteRejectedError) return notFound(reply);
        return mapPortalWriteFailure(err, reply);
      }
    },
  );

  /* -------------------------------- delete --------------------------------- */
  app.delete<{ Params: { addressId: string } }>(
    "/profile/addresses/:addressId",
    { preHandler: [limiter] },
    async (req: FastifyRequest<{ Params: { addressId: string } }>, reply: FastifyReply) => {
      const scope = requireCustomerScope(req);
      let source: CustomerIdentityReadDeps & CustomerMutationDeps;
      try {
        source = requireSource(deps);
      } catch (err) {
        return mapPortalWriteFailure(err, reply);
      }

      const gid = toAddressGid(req.params.addressId);
      if (gid === null) return notFound(reply);

      try {
        const deleted = await deleteCustomerAddress(source, scope, gid);
        if (deleted === null) return notFound(reply);
        return await list(source, scope);
      } catch (err) {
        if (err instanceof PortalWriteRejectedError) return notFound(reply);
        return mapPortalWriteFailure(err, reply);
      }
    },
  );

  /* ------------------------------- set default ------------------------------ */
  app.put<{ Params: { addressId: string } }>(
    "/profile/addresses/:addressId/default",
    { preHandler: [limiter] },
    async (req: FastifyRequest<{ Params: { addressId: string } }>, reply: FastifyReply) => {
      const scope = requireCustomerScope(req);
      let source: CustomerIdentityReadDeps & CustomerMutationDeps;
      try {
        source = requireSource(deps);
      } catch (err) {
        return mapPortalWriteFailure(err, reply);
      }

      const gid = toAddressGid(req.params.addressId);
      if (gid === null) return notFound(reply);

      try {
        const defaultId = await setDefaultCustomerAddress(source, scope, gid);
        if (defaultId === null) return notFound(reply);
        // The list carries `isDefault`, read back from Shopify's own
        // `defaultAddress`, so the client sees the new default rather than being
        // told it succeeded and having to infer which one changed.
        return await list(source, scope);
      } catch (err) {
        if (err instanceof PortalWriteRejectedError) return notFound(reply);
        return mapPortalWriteFailure(err, reply);
      }
    },
  );
}

/** `404` with nothing about the resource in the body (Req 2.2, 2.3). */
function notFound(reply: FastifyReply): object {
  return reply.code(404).send({ error: "address_not_found", message: "Not found." });
}

/** `400` with field CODES from the schema failure, never zod's sentences (Req 21.7). */
function badShape(reply: FastifyReply, issues: readonly z.ZodIssue[]): object {
  return reply.code(400).send({
    error: "invalid_request",
    message: "Invalid address.",
    fields: issues.map((issue) => ({
      field: typeof issue.path[0] === "string" ? issue.path[0] : null,
      code: issue.code === "too_big" ? "too_long" : "rejected",
    })),
  });
}
