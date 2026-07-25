/**
 * Admin authentication for the admin management surface (task 17.1,
 * Requirement 10.1).
 *
 * Requirement 10.1: any attempt to access an admin management tool WITHOUT an
 * authenticated Admin_User session holding an admin authorization role must be
 * denied, perform NO data change, and return a response indicating that
 * authorization is required.
 *
 * This module mirrors the customer-auth pattern (`src/plugins/auth.ts` +
 * `src/auth/identity.ts`): a small, injectable verifier resolves a presented
 * credential to an {@link AdminCtx}, and a Fastify `preHandler` gates every
 * admin route so a rejected request never reaches business logic. The verifier
 * is injectable so the routes are unit-testable with a fake and the service
 * NEVER builds or calls a live auth provider from a test or local run.
 *
 * The default verifier {@link UnconfiguredAdminAuthenticator} FAILS CLOSED — it
 * authenticates no one — so the admin surface denies all access until a real
 * authenticator is wired at deploy time (Req 10.1). A shared-secret verifier is
 * provided for a simple bearer-token deployment.
 *
 * SAFETY: defining this module touches no live/production system. The verifiers
 * hold only in-memory config; no network call is made.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * The resolved admin identity an admin handler runs with (design.md →
 * `AdminCtx`). `role` is fixed to `"admin"`: only a holder of the admin
 * authorization role reaches a handler (Req 10.1).
 */
export interface AdminCtx {
  adminUserId: string;
  role: "admin";
}

/**
 * Verifies a presented admin credential (a bearer token) and returns the
 * {@link AdminCtx} it authenticates, or `null` when the credential is
 * missing/invalid/expired or does not hold the admin role.
 *
 * Kept behind this interface so the admin routes are testable with a fake and
 * the service never couples to a specific identity provider.
 */
export interface AdminAuthenticator {
  verify(token: string): Promise<AdminCtx | null>;
}

/**
 * Default admin authenticator: authenticates NO ONE (fails closed). Keeps the
 * service bootable without an admin identity provider while guaranteeing the
 * admin surface denies every request until a real authenticator is wired
 * (Req 10.1).
 */
export class UnconfiguredAdminAuthenticator implements AdminAuthenticator {
  async verify(_token: string): Promise<AdminCtx | null> {
    return null;
  }
}

/**
 * Simple shared-secret admin authenticator for a bearer-token deployment. A
 * caller presents `Authorization: Bearer <secret>`; when the secret matches
 * (via a constant-time compare) the request is authenticated as the configured
 * admin user id. Suitable as a minimal production wiring; a richer deployment
 * swaps in an SSO/JWT-backed {@link AdminAuthenticator}.
 *
 * The secret is supplied from config/secrets management (never hardcoded,
 * Req 11.6). An empty/blank secret disables the authenticator (fails closed).
 */
export class SharedSecretAdminAuthenticator implements AdminAuthenticator {
  private readonly secret: string | null;
  private readonly adminUserId: string;

  constructor(secret: string | undefined, adminUserId = "admin") {
    const trimmed = typeof secret === "string" ? secret.trim() : "";
    this.secret = trimmed.length > 0 ? trimmed : null;
    this.adminUserId = adminUserId;
  }

  async verify(token: string): Promise<AdminCtx | null> {
    if (this.secret === null) {
      return null; // not configured → fail closed
    }
    if (!constantTimeEquals(token, this.secret)) {
      return null;
    }
    return { adminUserId: this.adminUserId, role: "admin" };
  }
}

/**
 * In-memory {@link AdminAuthenticator} backed by a `token → adminUserId` map.
 * The vehicle for tests; an unknown token resolves to `null` (unauthenticated).
 */
export class InMemoryAdminAuthenticator implements AdminAuthenticator {
  private readonly byToken: Map<string, string>;

  constructor(entries: Record<string, string> | Map<string, string> = {}) {
    this.byToken = entries instanceof Map ? new Map(entries) : new Map(Object.entries(entries));
  }

  async verify(token: string): Promise<AdminCtx | null> {
    const adminUserId = this.byToken.get(token);
    return adminUserId ? { adminUserId, role: "admin" } : null;
  }

  /** Test/setup helper: register a token → admin user id mapping. */
  set(token: string, adminUserId: string): void {
    this.byToken.set(token, adminUserId);
  }
}

/**
 * Constant-time string comparison to avoid leaking secret length/prefix via
 * timing. Returns false for unequal lengths without early-exit on content.
 */
function constantTimeEquals(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

const AUTHORIZATION_HEADER = "authorization";
const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

/** Read a single-valued header, tolerating the array form Node uses. */
function readHeader(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

/** Extract a bearer token from the Authorization header, or undefined. */
function readBearerToken(req: FastifyRequest): string | undefined {
  const header = readHeader(req, AUTHORIZATION_HEADER);
  if (!header) {
    return undefined;
  }
  const match = BEARER_SCHEME.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

/** The client-facing body returned when admin authorization is required (Req 10.1). */
export const AUTHORIZATION_REQUIRED_BODY = {
  error: "authorization_required",
  message: "Admin authorization is required to access this tool.",
} as const;

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved admin identity; set by the admin-auth preHandler before the handler runs. */
    adminCtx?: AdminCtx;
  }
}

export interface AdminAuthPluginOptions {
  /** Verifies a presented admin bearer token. Defaults to a fail-closed verifier. */
  authenticator?: AdminAuthenticator;
}

/**
 * Register the admin-auth `preHandler` on `app`. Confine its effect to a route
 * scope by calling this inside an encapsulated plugin (the admin router does
 * exactly this). Every route in the scope must resolve to an {@link AdminCtx}
 * or the request is rejected with HTTP 401 and the authorization-required body
 * BEFORE any handler runs, so no data changes on an unauthorized request
 * (Req 10.1).
 */
export function registerAdminAuth(app: FastifyInstance, opts: AdminAuthPluginOptions = {}): void {
  const authenticator = opts.authenticator ?? new UnconfiguredAdminAuthenticator();

  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const token = readBearerToken(req);
    if (!token) {
      reply.code(401).send(AUTHORIZATION_REQUIRED_BODY);
      return reply;
    }
    const ctx = await authenticator.verify(token);
    if (!ctx) {
      // No authenticated admin role → deny, no handler runs, no data change (Req 10.1).
      reply.code(401).send(AUTHORIZATION_REQUIRED_BODY);
      return reply;
    }
    req.adminCtx = ctx;
  });
}
