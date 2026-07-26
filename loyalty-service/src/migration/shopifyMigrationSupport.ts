/**
 * Shared, READ-ONLY Admin API support for the migration clients (task 33).
 *
 * Two things are needed by BOTH concrete migration clients — the M0 export
 * client (`migrationShopifyClient.ts`) and the rollback restore client
 * (`metafieldRestoreClient.ts`) — so they live here once rather than being
 * implemented twice with a risk of divergence:
 *
 *   1. {@link withThrottleRetry} — the throttle-retry loop. It REUSES the
 *      established backoff policy ({@link backoffDelayMs} / {@link DEFAULT_BACKOFF}
 *      from `shopify/adminGateway.ts`, Req 13.2: 1s initial, doubling, 60s cap,
 *      10 attempts) rather than inventing a second policy. Only
 *      {@link ShopifyThrottleError} is retried; every other error — i.e. every
 *      {@link ShopifyAdminRequestError} hard failure — is rethrown IMMEDIATELY so
 *      a migration never silently loops on a real fault. When all attempts are
 *      throttled it throws {@link AdminThrottleExhaustedError}, the same terminal
 *      error the redemption gateway uses.
 *
 *   2. {@link fetchAllLoyaltyMetafields} — paginated, VERBATIM capture of every
 *      metafield in the `loyalty` namespace for one customer
 *      (`namespace`, `key`, `type`, `value` exactly as Shopify returns them).
 *      The M0 export captures these as the rollback anchor and the rollback
 *      restore client reads them back to verify a restore, so both must see
 *      identical bytes — hence one implementation.
 *
 * SAFETY: nothing in this module mutates anything. It issues GraphQL *queries*
 * only, through an injected {@link ShopifyGraphqlTransport} whose `fetch` is
 * itself injectable, so unit tests never touch the network. The Admin token
 * lives only in the transport's request header and is never logged.
 */
import {
  AdminThrottleExhaustedError,
  DEFAULT_BACKOFF,
  ShopifyThrottleError,
  backoffDelayMs,
  type BackoffParams,
  type Sleeper,
} from "../shopify/adminGateway.js";
import type { ShopifyGraphqlTransport } from "../shopify/graphqlClient.js";
import { LOYALTY_METAFIELD_NAMESPACE, type RawMetafield } from "./m0Export.js";

/** Default Shopify connection page size used by every migration query. */
export const DEFAULT_PAGE_SIZE = 100 as const;

/** Real-time sleeper; tests inject an instant fake so no test waits on backoff. */
const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Throttle-retry knobs, injectable so tests are instant and deterministic. */
export interface ThrottleRetryOptions {
  /** Backoff policy; defaults to the shared {@link DEFAULT_BACKOFF} (Req 13.2). */
  backoff?: BackoffParams;
  /** Pauser between attempts; defaults to real `setTimeout`. */
  sleep?: Sleeper;
}

/**
 * Runs `operation`, retrying ONLY on {@link ShopifyThrottleError} with the shared
 * exponential backoff. Hard failures propagate on the first occurrence.
 *
 * @throws AdminThrottleExhaustedError when every attempt was throttled.
 */
export async function withThrottleRetry<T>(
  operation: () => Promise<T>,
  options: ThrottleRetryOptions = {},
): Promise<T> {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? realSleep;

  for (let attempt = 1; attempt <= backoff.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      // Hard failure → give up immediately; retrying a real fault would only
      // hide it behind minutes of backoff.
      if (!(err instanceof ShopifyThrottleError)) {
        throw err;
      }
      if (attempt >= backoff.maxAttempts) {
        throw new AdminThrottleExhaustedError(attempt);
      }
      await sleep(backoffDelayMs(attempt, backoff));
    }
  }
  // Unreachable: the loop returns or throws.
  throw new AdminThrottleExhaustedError(backoff.maxAttempts);
}

/**
 * Reads one page of a customer's `loyalty.*` metafields. `namespace`, `key`,
 * `type` and `value` are returned verbatim — the export/restore round trip
 * depends on byte-for-byte fidelity.
 */
export const CUSTOMER_LOYALTY_METAFIELDS_QUERY = /* GraphQL */ `
  query customerLoyaltyMetafields(
    $id: ID!
    $namespace: String!
    $pageSize: Int!
    $cursor: String
  ) {
    customer(id: $id) {
      id
      metafields(namespace: $namespace, first: $pageSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          namespace
          key
          type
          value
        }
      }
    }
  }
`;

/** The shape of a paginated connection as the migration queries request it. */
export interface Connection<N> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: N[];
}

interface CustomerMetafieldsData {
  customer: { id: string; metafields: Connection<RawMetafield> } | null;
}

/** Thrown when a customer GID cannot be read back from the Admin API. */
export class MigrationCustomerNotFoundError extends Error {
  readonly code = "migration_customer_not_found";
  readonly customerGid: string;
  constructor(customerGid: string) {
    super(`Shopify returned no customer for ${customerGid}.`);
    this.name = "MigrationCustomerNotFoundError";
    this.customerGid = customerGid;
  }
}

/**
 * Fetches ALL metafields in the `loyalty` namespace for one customer, following
 * `pageInfo.hasNextPage` / `endCursor` so a customer carrying more than one page
 * of metafields is still captured completely. Each page is wrapped in the shared
 * throttle-retry loop.
 */
export async function fetchAllLoyaltyMetafields(
  transport: ShopifyGraphqlTransport,
  customerGid: string,
  options: { pageSize?: number; retry?: ThrottleRetryOptions } = {},
): Promise<RawMetafield[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const metafields: RawMetafield[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: CustomerMetafieldsData = await withThrottleRetry(
      () =>
        transport.request<CustomerMetafieldsData>(CUSTOMER_LOYALTY_METAFIELDS_QUERY, {
          id: customerGid,
          namespace: LOYALTY_METAFIELD_NAMESPACE,
          pageSize,
          cursor,
        }),
      options.retry ?? {},
    );

    const customer = data.customer;
    if (!customer) {
      throw new MigrationCustomerNotFoundError(customerGid);
    }

    for (const node of customer.metafields.nodes) {
      metafields.push({
        namespace: node.namespace,
        key: node.key,
        type: node.type,
        value: node.value ?? null,
      });
    }

    if (!customer.metafields.pageInfo.hasNextPage) {
      return metafields;
    }
    cursor = customer.metafields.pageInfo.endCursor;
    if (!cursor) {
      // Defensive: `hasNextPage` without a cursor cannot be followed. Stopping
      // silently would produce a SILENTLY INCOMPLETE backup, so fail loudly.
      throw new Error(
        `Shopify reported another metafield page for ${customerGid} but returned no cursor; ` +
          `refusing to continue with a possibly incomplete metafield capture.`,
      );
    }
  }
}
