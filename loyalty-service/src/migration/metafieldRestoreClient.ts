/**
 * Concrete {@link MetafieldRestoreClient} for the M0–M2 metafield rollback
 * (task 33 — the production boundary the task-26 rehearsal had to fake).
 *
 * `rollback.ts` declares a restore boundary with exactly two methods — upsert
 * and read-back — and DELIBERATELY no delete method, so Req 14.8 ("never delete
 * any Shopify metafield") holds by construction. This module is its production
 * implementation and preserves that property structurally:
 *
 *   - {@link ShopifyGraphqlMetafieldRestoreClient.restoreCustomerMetafields}
 *     upserts through `metafieldsSet` with `ownerId = customerGid`, passing
 *     `namespace`, `key`, `type` and `value` VERBATIM from the M0 backup.
 *   - {@link ShopifyGraphqlMetafieldRestoreClient.readCustomerMetafields} reads
 *     back every `loyalty.*` metafield so `runMetafieldRollback` can verify the
 *     restore equals the export (Req 14.9).
 *   - There is NO delete method, and `metafieldsDelete` appears nowhere in this
 *     file. A test asserts the runtime method surface is exactly those two names.
 *
 * NULL / EMPTY VALUES — documented behaviour
 * ------------------------------------------
 * `RawMetafield.value` is typed `string | null` because that is what the Admin
 * API can return. `metafieldsSet` requires a non-null `value: String!`, so a
 * null-valued backup entry CANNOT be restored through this mutation. Substituting
 * `""` would write a DIFFERENT value than the backup captured and silently
 * corrupt the restore, so this client instead:
 *
 *   - SKIPS any metafield whose backed-up `value` is `null`, and
 *   - reports it through the optional {@link MetafieldRestoreClientOptions.onSkippedNullValue}
 *     callback (the operator script prints these), so a skip is visible rather
 *     than silent.
 *
 * An EMPTY STRING is not null: `""` is a real captured value and IS written back
 * verbatim. A skipped null metafield will surface again as a rollback
 * `verification_failed` mismatch if the store's current value differs, which is
 * the correct outcome — the operator is told rather than being handed a false
 * "restored".
 *
 * THROTTLING: every request goes through the shared throttle-retry loop
 * ({@link withThrottleRetry}, backoff from `shopify/adminGateway.ts`). Only
 * {@link ShopifyThrottleError} is retried; a hard failure propagates immediately
 * so `runMetafieldRollback` records the customer as not-restored.
 *
 * SAFETY: HTTPS only; the Admin token travels in a header and is never logged.
 * `fetch` is injectable so unit tests never touch the network. This module is
 * never wired into `src/index.ts` — rollback is an operator script only.
 */
import {
  DEFAULT_BACKOFF,
  type BackoffParams,
  type Sleeper,
} from "../shopify/adminGateway.js";
import {
  ShopifyGraphqlTransport,
  assertNoUserErrors,
  type FetchLike,
  type ShopifyUserError,
} from "../shopify/graphqlClient.js";
import type { RawMetafield } from "./m0Export.js";
import type { MetafieldRestoreClient, MetafieldRestoreInput } from "./rollback.js";
import {
  DEFAULT_PAGE_SIZE,
  fetchAllLoyaltyMetafields,
  withThrottleRetry,
  type ThrottleRetryOptions,
} from "./shopifyMigrationSupport.js";

/** Shopify accepts at most 25 metafields per `metafieldsSet` call. */
export const METAFIELDS_SET_BATCH_SIZE = 25 as const;

/** A metafield that could not be restored because its backed-up value was null. */
export interface SkippedNullMetafield {
  customerId: string;
  customerGid: string;
  namespace: string;
  key: string;
  type: string;
}

/** Options for {@link ShopifyGraphqlMetafieldRestoreClient}. */
export interface MetafieldRestoreClientOptions {
  /**
   * Called for each metafield skipped because its backed-up value was `null`
   * (see module header). Reporting, never substitution.
   */
  onSkippedNullValue?: (skipped: SkippedNullMetafield) => void;
  /** Connection page size for the read-back; defaults to 100. */
  pageSize?: number;
  /** Backoff policy for the throttle-retry loop; defaults to {@link DEFAULT_BACKOFF}. */
  backoff?: BackoffParams;
  /** Injected pauser so tests never wait on real backoff delays. */
  sleep?: Sleeper;
}

/** The `metafieldsSet` upsert. Upsert by owner+namespace+key; never deletes. */
export const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation migrationMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface MetafieldsSetData {
  metafieldsSet: {
    metafields: Array<{ namespace: string; key: string }> | null;
    userErrors: ShopifyUserError[];
  };
}

/** Splits a list into fixed-size chunks (module-level: keeps the method surface at two). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Concrete {@link MetafieldRestoreClient} backed by the Admin GraphQL API.
 * Construction performs no I/O. Requires the `write_metafields` scope for the
 * upsert and `read_customers` for the read-back.
 */
export class ShopifyGraphqlMetafieldRestoreClient implements MetafieldRestoreClient {
  private readonly transport: ShopifyGraphqlTransport;
  private readonly pageSize: number;
  private readonly retry: ThrottleRetryOptions;
  private readonly onSkippedNullValue: ((skipped: SkippedNullMetafield) => void) | undefined;

  constructor(
    shopDomain: string,
    accessToken: string,
    fetchImpl?: FetchLike,
    options: MetafieldRestoreClientOptions = {},
  ) {
    this.transport = new ShopifyGraphqlTransport(shopDomain, accessToken, fetchImpl);
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.retry = {
      backoff: options.backoff ?? DEFAULT_BACKOFF,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    };
    this.onSkippedNullValue = options.onSkippedNullValue;
  }

  /**
   * Upserts the customer's `loyalty.*` metafields back to their exported values.
   * Values, types, namespaces and keys are passed through verbatim. Null-valued
   * backup entries are skipped and reported (see module header) rather than
   * written as `""`. Throws on any userError or hard failure so the caller can
   * record the customer as not-restored.
   */
  async restoreCustomerMetafields(input: MetafieldRestoreInput): Promise<void> {
    const writable: Array<Record<string, string>> = [];

    for (const field of input.metafields) {
      if (field.value === null || field.value === undefined) {
        this.onSkippedNullValue?.({
          customerId: input.customerId,
          customerGid: input.customerGid,
          namespace: field.namespace,
          key: field.key,
          type: field.type,
        });
        continue;
      }
      writable.push({
        ownerId: input.customerGid,
        namespace: field.namespace,
        key: field.key,
        type: field.type,
        value: field.value,
      });
    }

    // Nothing writable (e.g. a non-enrolled customer with zero loyalty
    // metafields): issue no mutation at all. Calling `metafieldsSet` with an
    // empty list would be a pointless write attempt.
    if (writable.length === 0) {
      return;
    }

    for (const batch of chunk(writable, METAFIELDS_SET_BATCH_SIZE)) {
      const data = await withThrottleRetry(
        () =>
          this.transport.request<MetafieldsSetData>(METAFIELDS_SET_MUTATION, {
            metafields: batch,
          }),
        this.retry,
      );
      assertNoUserErrors("metafieldsSet", data.metafieldsSet.userErrors);
    }
  }

  /**
   * Reads back ALL `loyalty.*` metafields currently on the customer (paginated),
   * so the rollback can verify they equal the exported values (Req 14.9).
   */
  async readCustomerMetafields(customerGid: string): Promise<RawMetafield[]> {
    return fetchAllLoyaltyMetafields(this.transport, customerGid, {
      pageSize: this.pageSize,
      retry: this.retry,
    });
  }
}
