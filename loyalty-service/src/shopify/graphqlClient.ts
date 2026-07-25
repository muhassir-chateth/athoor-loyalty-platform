/**
 * Shared minimal GraphQL transport for the Shopify Admin API (task 5.4 / 6.7).
 *
 * This is the single low-level HTTP boundary the concrete Admin clients
 * ({@link ShopifyGraphqlAdminClient}, {@link ShopifyGraphqlMetafieldClient} in
 * `adminClient.ts`) share. It POSTs a GraphQL document to
 * `https://{shopDomain}/admin/api/{ADMIN_API_VERSION}/graphql.json` with the
 * `X-Shopify-Access-Token` header, using Node's global `fetch` — NO new npm
 * dependency is added (design/tech list `graphql-request`, but it is not
 * installed, so we speak the JSON-over-HTTP contract directly with `fetch`).
 *
 * Error mapping (the contract the gateway in `adminGateway.ts` depends on):
 *   - HTTP 429, or a GraphQL top-level error whose `extensions.code` is
 *     `THROTTLED`, is mapped to {@link ShopifyThrottleError} — the throttling
 *     SIGNAL the {@link ShopifyAdminGateway} retries on with exponential
 *     backoff (Req 13.2 / 13.3 / 13.5).
 *   - Any other failure (non-2xx HTTP, transport error, malformed body, or a
 *     GraphQL top-level `errors` array) is mapped to
 *     {@link ShopifyAdminRequestError} — a HARD failure. The gateway treats any
 *     non-throttle throw as a hard failure (Req 3.9), so a distinct hard-failure
 *     type is exactly what it expects.
 *
 * SECURITY:
 *   - HTTPS only — the endpoint is always `https://`.
 *   - The `X-Shopify-Access-Token` is sent as a header and is NEVER placed in an
 *     error message, thrown object, or any log. Errors carry only status codes,
 *     GraphQL messages, and userError details — never the token.
 *   - The transport is side-effect-free at construction; it performs no I/O
 *     until {@link ShopifyGraphqlTransport.request} is called, and the `fetch`
 *     implementation is injectable so tests never touch the network.
 */
import { ShopifyThrottleError } from "./adminGateway.js";

/** Recent stable Shopify Admin API version pinned for all requests. */
export const ADMIN_API_VERSION = "2024-10" as const;

/** The header carrying the Admin API access token (never logged). */
export const ACCESS_TOKEN_HEADER = "X-Shopify-Access-Token" as const;

/** A single GraphQL error as returned by the Admin API `errors` array. */
export interface GraphqlError {
  message: string;
  extensions?: { code?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** The parsed GraphQL response envelope. */
export interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
  extensions?: { [k: string]: unknown };
}

/** The minimal request init the transport passes to `fetch`. */
export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** The minimal shape of the response the transport reads from `fetch`. */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The injectable `fetch` seam — the Node global satisfies it; tests pass a fake. */
export type FetchLike = (url: string, init: FetchRequestInit) => Promise<HttpResponse>;

/**
 * A HARD (non-throttle) Admin API failure. The {@link ShopifyAdminGateway}
 * counts any non-{@link ShopifyThrottleError} throw as a hard failure (Req 3.9),
 * so this is the "hard-failure error type" the gateway expects. It carries the
 * HTTP status, GraphQL messages, and any mutation `userErrors` for diagnostics —
 * but NEVER the access token.
 */
export class ShopifyAdminRequestError extends Error {
  readonly code = "shopify_admin_request_failed";
  /** HTTP status when the failure came from a non-2xx response. */
  readonly statusCode?: number;
  /** GraphQL top-level error messages, when present. */
  readonly graphqlErrors?: string[];
  /** Mutation `userErrors`, when the failure was a business-rule rejection. */
  readonly userErrors?: ShopifyUserError[];
  override readonly cause?: unknown;

  constructor(
    message: string,
    details: {
      statusCode?: number;
      graphqlErrors?: string[];
      userErrors?: ShopifyUserError[];
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ShopifyAdminRequestError";
    if (details.statusCode !== undefined) this.statusCode = details.statusCode;
    if (details.graphqlErrors !== undefined) this.graphqlErrors = details.graphqlErrors;
    if (details.userErrors !== undefined) this.userErrors = details.userErrors;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

/** A Shopify mutation `userErrors` entry (business-rule rejection). */
export interface ShopifyUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

/** Default transport: Node's global `fetch`, adapted to {@link FetchLike}. */
const defaultFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as unknown as Promise<HttpResponse>;

/** True iff a GraphQL top-level error signals throttling (`extensions.code === THROTTLED`). */
function isThrottleError(errors: GraphqlError[] | undefined): boolean {
  return Boolean(errors?.some((e) => e.extensions?.code === "THROTTLED"));
}

/** Parses a `Retry-After` header (seconds) into a number, if present and finite. */
function parseRetryAfter(res: HttpResponse): number | undefined {
  const raw = res.headers.get("Retry-After");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The shared GraphQL transport. Construct once with a shop domain + access token
 * (+ optional injected `fetch` for tests) and call {@link request} per query.
 * Construction performs no I/O and never logs the token.
 */
export class ShopifyGraphqlTransport {
  private readonly endpoint: string;
  private readonly accessToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(shopDomain: string, accessToken: string, fetchImpl: FetchLike = defaultFetch) {
    if (!shopDomain) throw new Error("shopDomain is required for the Shopify Admin transport.");
    if (!accessToken) throw new Error("accessToken is required for the Shopify Admin transport.");
    // HTTPS only (Req 11.11). `shopDomain` is the bare host, e.g. `x.myshopify.com`.
    this.endpoint = `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`;
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
  }

  /** The resolved GraphQL endpoint (no secrets). Exposed for tests/diagnostics. */
  get url(): string {
    return this.endpoint;
  }

  /**
   * Executes a GraphQL operation and returns its `data`. Maps throttling to
   * {@link ShopifyThrottleError} (retryable) and every other failure to
   * {@link ShopifyAdminRequestError} (hard). Never leaks the access token.
   */
  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: HttpResponse;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          [ACCESS_TOKEN_HEADER]: this.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      // Network/transport failure — hard failure (token never referenced here).
      throw new ShopifyAdminRequestError("Shopify Admin API request failed to send.", { cause });
    }

    // HTTP 429 → throttling signal the gateway retries on (Req 13.3).
    if (res.status === 429) {
      throw new ShopifyThrottleError(
        "Shopify Admin API returned HTTP 429 (rate limited).",
        parseRetryAfter(res),
      );
    }

    const rawBody = await res.text();

    if (!res.ok) {
      // Non-2xx, non-429 → hard failure. Include status only, never the token.
      throw new ShopifyAdminRequestError(
        `Shopify Admin API returned HTTP ${res.status}.`,
        { statusCode: res.status },
      );
    }

    let parsed: GraphqlResponse<T>;
    try {
      parsed = JSON.parse(rawBody) as GraphqlResponse<T>;
    } catch (cause) {
      throw new ShopifyAdminRequestError("Shopify Admin API returned a non-JSON body.", { cause });
    }

    if (parsed.errors && parsed.errors.length > 0) {
      // Top-level GraphQL errors: THROTTLED → retryable; anything else → hard.
      if (isThrottleError(parsed.errors)) {
        throw new ShopifyThrottleError("Shopify Admin API GraphQL response was THROTTLED.");
      }
      throw new ShopifyAdminRequestError("Shopify Admin API returned GraphQL errors.", {
        graphqlErrors: parsed.errors.map((e) => e.message),
      });
    }

    if (parsed.data === undefined || parsed.data === null) {
      throw new ShopifyAdminRequestError("Shopify Admin API returned no data.");
    }

    return parsed.data;
  }
}

/**
 * Raises the appropriate error for a mutation's `userErrors`. A THROTTLED code
 * (defensive — throttling is normally top-level) becomes a retryable
 * {@link ShopifyThrottleError}; any other userError is a hard
 * {@link ShopifyAdminRequestError}. No-op when there are no userErrors.
 */
export function assertNoUserErrors(operation: string, userErrors: ShopifyUserError[]): void {
  if (userErrors.length === 0) return;
  if (userErrors.some((e) => e.code === "THROTTLED")) {
    throw new ShopifyThrottleError(`Shopify ${operation} was THROTTLED.`);
  }
  throw new ShopifyAdminRequestError(`Shopify ${operation} returned userErrors.`, { userErrors });
}

/**
 * Parses the trailing numeric id from a Shopify GID
 * (`gid://shopify/DiscountCodeNode/123` → 123). Returns null when absent or
 * non-numeric so callers can store `null` rather than a bogus id.
 */
export function numericIdFromGid(gid: string | null | undefined): number | null {
  if (!gid) return null;
  const tail = gid.split("/").pop();
  if (!tail) return null;
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}
