/**
 * Shopify Admin Gateway — outbound, queued, rate-limit aware (task 5.3).
 *
 * This is design.md "Component 3: Shopify Admin Gateway": the ONLY component
 * that calls the Shopify Admin API. It mints the unique, single-use,
 * customer-bound discount code for a redemption (Req 3.5, 3.6, Property 10) and
 * is deliberately built so it NEVER runs synchronously inside a webhook handler
 * — it is invoked from the job-queue worker (Req 13.2).
 *
 * The real Admin API is reached through an INJECTABLE {@link ShopifyAdminClient}
 * interface. Production wires a client that speaks the GraphQL Admin API; tests
 * inject a fake client so no live Admin API is ever called during verification.
 *
 * Rate-limit handling (Req 13.2 / 13.3): every Admin call is routed through an
 * exponential-backoff retry loop — initial delay 1s, doubling each attempt,
 * capped at 60s, up to 10 attempts — but ONLY on throttling responses
 * (HTTP 429 / GraphQL THROTTLED), which the client signals by throwing
 * {@link ShopifyThrottleError}. When all 10 attempts are throttled the gateway
 * throws {@link AdminThrottleExhaustedError} so the caller can keep the
 * redemption pending and surface a "code could not be issued" error (Req 13.4).
 *
 * Hard-failure handling (Req 3.9): a non-throttle Admin failure is retried too,
 * but if the Admin API fails on 3 CONSECUTIVE attempts within 60 seconds the
 * gateway gives up and throws {@link AdminApiFailureError}; the worker then
 * marks the redemption failed and records a compensating ledger adjustment
 * reversing the spend. A successful call in between resets the consecutive
 * streak.
 *
 * SAFETY: defining this module touches no live system. It calls the Admin API
 * only through whatever client is injected at runtime; the gateway itself does
 * pure orchestration (backoff timing + failure classification) and is fully
 * unit-testable with a fake client and a fake sleeper/clock.
 */

/**
 * Input for minting a single-use, customer-bound discount code. Mirrors
 * design.md `DiscountInput` exactly (Component 3): the code is bound to one
 * customer, single use, applies once per customer, and carries the redemption
 * id for reconciliation.
 */
export interface DiscountInput {
  /** Shopify customer GID the code is bound to, e.g. `gid://shopify/Customer/123`. */
  customerGid: string;
  /** The GBP amount off, mapped from the reward tier (5 | 15 | 35 | 75). */
  amountOffGBP: number;
  /** The generated unique code, e.g. `ATH-9F3K-2QX7`. */
  code: string;
  /** Single use (Req 3.6, Property 10). */
  usageLimit: 1;
  /** Applies once per customer (Req 3.6, Property 10). */
  appliesOncePerCustomer: true;
  /** The redemption this code is issued for (reconciliation). */
  redemptionId: string;
}

/** The result of a successful discount-code mint in Shopify. */
export interface DiscountCode {
  /** The code string as created in Shopify (echoes {@link DiscountInput.code}). */
  code: string;
  /** Shopify price-rule id, when the client returns one. */
  shopifyPriceRuleId: number | null;
  /** Shopify discount-node id, when the client returns one. */
  shopifyDiscountId: number | null;
  /** The GBP amount off the code applies. */
  amountOffGBP: number;
}

/**
 * The injectable boundary to the Shopify Admin API. The gateway depends only on
 * this interface; production supplies a GraphQL-backed implementation and tests
 * supply a fake. Implementations MUST throw {@link ShopifyThrottleError} on a
 * throttling response so the gateway can back off and retry; any other thrown
 * error is treated as a hard failure.
 */
export interface ShopifyAdminClient {
  createSingleUseDiscount(input: DiscountInput): Promise<DiscountCode>;
}

/**
 * Signals a Shopify throttling response (HTTP 429 or GraphQL `THROTTLED`).
 * A client throws this so the gateway retries with exponential backoff
 * (Req 13.2 / 13.3) rather than treating it as a hard failure.
 */
export class ShopifyThrottleError extends Error {
  readonly code = "shopify_throttled";
  /** Optional server-suggested retry delay in seconds, if the client parsed one. */
  readonly retryAfterSeconds?: number;
  constructor(message = "Shopify Admin API throttled the request.", retryAfterSeconds?: number) {
    super(message);
    this.name = "ShopifyThrottleError";
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

/**
 * Thrown when every one of the {@link BackoffParams.maxAttempts} attempts was
 * throttled and no code was minted (Req 13.4). The redemption must be kept
 * pending and a "code could not be issued" error surfaced — the spend is NOT
 * reversed (the code may still succeed on a later manual retry).
 */
export class AdminThrottleExhaustedError extends Error {
  readonly code = "admin_throttle_exhausted";
  readonly attempts: number;
  constructor(attempts: number) {
    super(
      `The Shopify Admin API stayed throttled across all ${attempts} attempts; ` +
        `no discount code was issued.`,
    );
    this.name = "AdminThrottleExhaustedError";
    this.attempts = attempts;
  }
}

/**
 * Thrown when the Admin API fails on 3 consecutive attempts within 60 seconds,
 * or when the attempt budget is exhausted while failing hard (Req 3.9). The
 * worker maps this to: mark the redemption failed + record a compensating
 * ledger adjustment reversing the spend.
 */
export class AdminApiFailureError extends Error {
  readonly code = "admin_api_failure";
  readonly consecutiveFailures: number;
  /** True when the 3-consecutive-failures-within-60s condition was met (Req 3.9). */
  readonly withinWindow: boolean;
  override readonly cause?: unknown;
  constructor(consecutiveFailures: number, withinWindow: boolean, cause?: unknown) {
    super(
      `The Shopify Admin API failed on ${consecutiveFailures} consecutive attempts ` +
        `${withinWindow ? "within 60 seconds" : "and the attempt budget was exhausted"}; ` +
        `no discount code was issued.`,
    );
    this.name = "AdminApiFailureError";
    this.consecutiveFailures = consecutiveFailures;
    this.withinWindow = withinWindow;
    this.cause = cause;
  }
}

/** Exponential-backoff parameters (Req 13.2): 1s initial, doubling, 60s cap, 10 attempts. */
export interface BackoffParams {
  /** Initial retry delay in ms (Req 13.2: 1 second). */
  readonly initialMs: number;
  /** Multiplier applied each attempt (Req 13.2: doubling). */
  readonly factor: number;
  /** Maximum delay in ms (Req 13.2: 60 seconds). */
  readonly capMs: number;
  /** Maximum number of attempts (Req 13.2: 10). */
  readonly maxAttempts: number;
}

/** The default backoff policy mandated by Requirement 13.2. */
export const DEFAULT_BACKOFF: BackoffParams = {
  initialMs: 1000,
  factor: 2,
  capMs: 60000,
  maxAttempts: 10,
} as const;

/** Number of consecutive hard failures that triggers the compensating-reversal path (Req 3.9). */
export const HARD_FAILURE_STREAK = 3 as const;

/** The window (ms) within which {@link HARD_FAILURE_STREAK} failures trigger reversal (Req 3.9). */
export const HARD_FAILURE_WINDOW_MS = 60000 as const;

/**
 * The delay (ms) before the retry that FOLLOWS a given 1-based `attempt`:
 * `min(initialMs * factor^(attempt-1), capMs)` (Req 13.2). Pure and testable.
 * e.g. after attempt 1 → 1000ms, attempt 2 → 2000ms, … capped at 60000ms.
 */
export function backoffDelayMs(attempt: number, params: BackoffParams = DEFAULT_BACKOFF): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer; received ${String(attempt)}.`);
  }
  const raw = params.initialMs * params.factor ** (attempt - 1);
  return Math.min(raw, params.capMs);
}

/** A pauser; injected so tests run instantly instead of waiting real backoff delays. */
export type Sleeper = (ms: number) => Promise<void>;

/** A clock; injected so tests control the 60-second hard-failure window (Req 3.9). */
export type Clock = () => number;

/** Real-time sleeper used in production. */
const realSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True iff the error is a Shopify throttling signal. */
function isThrottle(err: unknown): err is ShopifyThrottleError {
  return err instanceof ShopifyThrottleError;
}

/** Options for {@link ShopifyAdminGateway}. */
export interface ShopifyAdminGatewayOptions {
  /** Backoff policy; defaults to {@link DEFAULT_BACKOFF} (Req 13.2). */
  backoff?: BackoffParams;
  /** Pauser between attempts; defaults to real `setTimeout` (overridden in tests). */
  sleep?: Sleeper;
  /** Millisecond clock; defaults to `Date.now` (overridden in tests). */
  now?: Clock;
}

/**
 * The rate-limit-aware Admin Gateway. Wraps an injected {@link ShopifyAdminClient}
 * with the exponential-backoff retry loop and terminal-failure classification
 * required by Requirements 13.2, 13.3, 13.4 and 3.9. It touches no database and
 * knows nothing about the ledger — persisting the code and reversing a spend is
 * the worker's job (see `generateDiscountCode.ts`).
 */
export class ShopifyAdminGateway {
  private readonly client: ShopifyAdminClient;
  private readonly backoff: BackoffParams;
  private readonly sleep: Sleeper;
  private readonly now: Clock;

  constructor(client: ShopifyAdminClient, options: ShopifyAdminGatewayOptions = {}) {
    this.client = client;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
  }

  /**
   * Mints a single-use, customer-bound discount code, retrying on throttling
   * with exponential backoff (Req 13.2 / 13.3).
   *
   * Resolves with the {@link DiscountCode} on success. Throws:
   *   - {@link AdminThrottleExhaustedError} if all {@link BackoffParams.maxAttempts}
   *     attempts were throttled (Req 13.4);
   *   - {@link AdminApiFailureError} on 3 consecutive hard failures within 60s,
   *     or when the attempt budget is exhausted while failing hard (Req 3.9).
   *
   * NEVER call this synchronously in a webhook handler — it is invoked from the
   * queue worker only (Req 13.2).
   */
  async createSingleUseDiscount(input: DiscountInput): Promise<DiscountCode> {
    const { maxAttempts } = this.backoff;
    let consecutiveFailures = 0;
    let streakStartedAt = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.client.createSingleUseDiscount(input);
      } catch (err) {
        const isLastAttempt = attempt >= maxAttempts;

        if (isThrottle(err)) {
          // Throttling breaks any hard-failure streak (Req 13.3 vs 3.9).
          consecutiveFailures = 0;
          streakStartedAt = 0;
          if (isLastAttempt) {
            // All attempts throttled: keep redemption pending, surface error (Req 13.4).
            throw new AdminThrottleExhaustedError(attempt);
          }
        } else {
          // Hard failure: track the consecutive streak and its start time (Req 3.9).
          consecutiveFailures += 1;
          const nowMs = this.now();
          if (consecutiveFailures === 1) {
            streakStartedAt = nowMs;
          }
          const withinWindow =
            consecutiveFailures >= HARD_FAILURE_STREAK &&
            nowMs - streakStartedAt <= HARD_FAILURE_WINDOW_MS;
          if (withinWindow) {
            // 3 consecutive failures within 60s → compensating reversal (Req 3.9).
            throw new AdminApiFailureError(consecutiveFailures, true, err);
          }
          if (isLastAttempt) {
            // Budget exhausted while failing hard → also a terminal hard failure.
            throw new AdminApiFailureError(consecutiveFailures, false, err);
          }
        }

        // Wait out the backoff before the next attempt (Req 13.2).
        await this.sleep(backoffDelayMs(attempt, this.backoff));
      }
    }

    // Unreachable: the loop either returns or throws. Kept for exhaustiveness.
    throw new AdminThrottleExhaustedError(maxAttempts);
  }
}
