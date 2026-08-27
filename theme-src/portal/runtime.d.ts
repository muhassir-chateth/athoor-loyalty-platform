/**
 * The task 18.1–18.7 members of `window.AthoorPortal`, declared as one contract
 * (design §16.2, §16.4, §16.5, §16.9, §16.10).
 *
 * WHY THIS IS A SECOND DECLARATION FILE AND NOT AN EDIT TO `portal.d.ts`
 * ---------------------------------------------------------------------
 * `portal.d.ts` says each of these "adds its own member here when it lands", and
 * that is what this file does — by interface MERGING, which TypeScript applies to
 * `AthoorPortalRuntime` exactly as if the members were written there.
 *
 * It has to be a separate file for one mechanical reason. Typing these members
 * honestly means naming the DTOs the API returns, and those types live in
 * `data/types.ts`, which re-exports them from the service. A file with a
 * top-level `import` is a MODULE, and a module cannot declare globals — so
 * `portal.d.ts`, which declares `interface Window`, must stay a non-module script.
 * This file is the module half: `import type` for the DTOs, `declare global` for
 * the contract. The alternative was to restate each DTO's shape here, which would
 * create a second source of truth for the response bodies and defeat the reason
 * §16.7 gives for having a build step at all.
 *
 * ZERO BYTES. Every declaration here is type-only, so esbuild never sees it and
 * no bundle grows. `import type` (required by `verbatimModuleSyntax`) guarantees
 * the import itself is erased rather than becoming a runtime dependency on
 * `data/types.js`.
 */
import type {
  PortalCatalogProduct,
  PortalErrorCode,
  PortalFieldError,
  PortalOrderSummary,
} from "./data/types.js";

declare global {
  /* ====================================================================== *
   * 18.1 — the transport
   * ====================================================================== */

  /**
   * Which upstream a request ultimately reads, which is the only thing that
   * changes the timeout budget (design §22.3).
   *
   * `loyalty` is our own Postgres, hosted on a service that spins down when
   * idle; `shopify` is a third party that is always warm. The distinction exists
   * because the cold-start allowance must apply to the first read of the former
   * and never to the latter — an 8 s Shopify budget stretched to 60 s would turn
   * a genuine Shopify outage into a minute of silence.
   */
  type PortalUpstream = "loyalty" | "shopify";

  /** A request to `/apps/loyalty/v1`, described rather than constructed. */
  interface PortalRequestSpec {
    readonly method: "GET" | "POST" | "PUT" | "DELETE";
    /** Path BELOW `/v1`, e.g. `/balance`. Leading slash required. */
    readonly path: string;
    /**
     * Query parameters. Serialised with keys sorted, so the cache key for one
     * resource is stable no matter what order a caller wrote them in.
     */
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    /** A JSON body. Only permitted on a state-changing method. */
    readonly body?: unknown;
    /** Defaults to `loyalty`. */
    readonly target?: PortalUpstream;
    /**
     * Reuse an existing `Idempotency-Key` instead of minting one.
     *
     * The one legitimate use is §22.4's rule that a write retried after a network
     * failure or timeout carries the SAME key, so the server can replay rather
     * than repeat. A fresh submission must NOT pass this.
     */
    readonly idempotencyKey?: string;
    /**
     * Called once if this attempt is still outstanding after 3 s on the
     * cold-start budget — design §22.3's "waking" state. Never called on the 8 s
     * budget, where 3 s of silence is not yet remarkable.
     */
    readonly onWaking?: () => void;
  }

  /**
   * A failure, described by an identifier from the closed set — never by an
   * upstream message (design E.1 rule 2).
   */
  /**
   * Every identifier the client must be able to render.
   *
   * `PortalErrorCode` is the N1–N16 subset only — its own doc comment says so —
   * but a portal ROUTE can answer with more than that. Design E.2 is the full
   * taxonomy, and task 16.5 confirmed by sweeping every route which of those
   * actually reach a portal response. Two of them matter especially:
   *
   *   `internal_error`  the service began emitting this when task 16 stopped the
   *                     500 path forwarding `err.message`. It is NOT in
   *                     `PortalErrorCode`, so a client typed against that union
   *                     alone would have no wording for the one state that means
   *                     "we do not know what happened".
   *   `section_render_failed`  E.2's client-side row, originated here rather than
   *                     by the service (§16.10).
   *
   * Plus the two the transport itself originates when there was no answer to read.
   * Closed on purpose: `ui/copy.ts` is asserted total against this union, so an
   * identifier added to the service without wording here fails a test rather than
   * reaching a customer as the neutral fallback nobody noticed.
   */
  type PortalFailureCode =
    | PortalErrorCode
    // No answer at all — originated by the transport.
    | "network_unavailable"
    | "request_timeout"
    // Originated by the client's own error boundary.
    | "section_render_failed"
    // Design E.2, reachable on a portal route (confirmed by task 16.5's sweep).
    | "app_proxy_verification_unavailable"
    | "app_proxy_request_expired"
    | "invalid_pagination"
    | "birthday_not_set"
    | "address_not_found"
    | "unknown_referral_code"
    | "reward_channel_not_allowed"
    | "insufficient_points"
    | "self_referral_rejected"
    | "referral_already_claimed"
    | "referral_not_eligible"
    | "lock_timeout"
    | "service_unavailable"
    | "internal_error"
    | "invalid_device_registration"
    | "invalid_device_token"
    | "invalid_reward"
    | "customer_not_found"
    | "entitlement_not_qualified"
    | "entitlement_channel_not_allowed"
    | "membership_service_unavailable"
    | "idempotency_scope_unavailable";

  interface PortalFailure {
    /** The identifier the client's copy map is keyed on. */
    readonly code: PortalFailureCode;
    /** The HTTP status, or `null` when the request never completed. */
    readonly status: number | null;
    /** The `x-request-id` the service returned, for §22.9's reference. */
    readonly requestId: string | null;
    /**
     * Whether offering the customer a retry can plausibly help (§22.9). False
     * for a determinate answer — 400, 401, 403, 404, 409 — where a retry would
     * produce the same answer and read as the service being unreliable.
     */
    readonly retryable: boolean;
    /** Field-level rejections from a `400 invalid_request`, as codes. */
    readonly fields?: readonly PortalFieldError[];
    /** From a `429`, so the control can re-enable itself when it elapses. */
    readonly retryAfterSeconds?: number;
    /** From a `409 birthday_change_locked`, the ISO date a change reopens. */
    readonly allowedFrom?: string;
  }

  /**
   * The transport's return type. **Never throws for an HTTP status** — half of
   * Requirement 15.8 is that a section's renderer cannot be skipped by an
   * unhandled rejection, and a union makes the failure branch unignorable
   * instead of merely documented.
   */
  type PortalResult<T> =
    | { readonly ok: true; readonly value: T; readonly requestId: string | null }
    | { readonly ok: false; readonly error: PortalFailure };

  /* ====================================================================== *
   * 18.2 — page state
   * ====================================================================== */

  interface AthoorPortalCache {
    /**
     * Read through the cache: coalesced while in flight, and served from the
     * 60 s snapshot for `GET /balance` only (§16.5).
     */
    read<T>(spec: PortalRequestSpec): Promise<PortalResult<T>>;
    /**
     * Drop the balance snapshot. Called immediately after a successful
     * redemption so the next read cannot be the pre-redemption balance.
     */
    invalidateBalance(): void;
    /** Drop everything. For tests and for a wholesale section retry. */
    clear(): void;
    /** How many entries are held. For tests; carries no customer data. */
    size(): number;
  }

  interface AthoorPortalDraft {
    /** The fields held for one form, as a fresh object. */
    get(scope: string): Record<string, string>;
    set(scope: string, field: string, value: string): void;
    /** Forget one form's input — after a successful submission. */
    clear(scope: string): void;
    has(scope: string): boolean;
  }

  /* ====================================================================== *
   * 18.3 — the eight designed states, and the row renderers
   * ====================================================================== */

  /**
   * The `data-state` vocabulary (design §16.3, §18.8). Eight values, all
   * designed; there is deliberately no ninth for "unknown".
   */
  type PortalSectionState =
    | "loading"
    | "empty"
    | "ready"
    | "error"
    | "disabled"
    | "offline"
    | "session-expired"
    | "degraded";

  /** What a state needs beyond its name in order to be rendered. */
  interface PortalStateOptions {
    /** Why a control is disabled — §18.8 requires a stated reason, not just a look. */
    readonly reason?: string;
    /** The failure a `degraded` or `error` state is reporting. */
    readonly failure?: PortalFailure;
    /**
     * Re-request THIS section (Requirement 15.6). Rendered only when the failure
     * is retryable, so a 404 never offers a button that cannot help.
     */
    readonly retry?: () => void;
    /** Politely announced text. Omit for a change the customer did not cause. */
    readonly announce?: string;
  }

  interface AthoorPortalStates {
    /** Write the state to the root and render its designed presentation. */
    set(root: HTMLElement, state: PortalSectionState, options?: PortalStateOptions): void;
    /** The state a root is currently in, read back from the DOM (§16.3). */
    current(root: HTMLElement): PortalSectionState | null;
    /** Map a failure onto the right state and render it, including §22.9's reference. */
    degrade(root: HTMLElement, failure: PortalFailure, retry?: () => void): void;
    /** The eight-value vocabulary, for the tests that assert it is total. */
    readonly states: readonly PortalSectionState[];
  }

  /**
   * A row renderer: `(dto, template) => DocumentFragment` (spec 18.3).
   *
   * The template is passed IN rather than looked up, because the markup belongs
   * to the Liquid snippet that owns the section (task 19.4) and a renderer that
   * searched the document for it would be guessing. Tests supply their own.
   */
  interface AthoorPortalRows {
    orderRow(dto: PortalOrderSummary, template: HTMLTemplateElement): DocumentFragment;
    wishlistRow(dto: PortalCatalogProduct, template: HTMLTemplateElement): DocumentFragment;
    activityRow(dto: PortalActivityEntry, template: HTMLTemplateElement): DocumentFragment;
    rewardCard(dto: PortalRewardOffer, template: HTMLTemplateElement): DocumentFragment;
    stageRow(dto: PortalReferralStage, template: HTMLTemplateElement): DocumentFragment;
    /**
     * Render a list, each row inside its own `try`/`catch` (spec 18.3, §22.6).
     * A row that throws is omitted and counted; the rest of the list still
     * renders, which is the difference between one unavailable product and an
     * empty wishlist.
     */
    list<T>(
      items: readonly T[],
      template: HTMLTemplateElement,
      render: (dto: T, template: HTMLTemplateElement) => DocumentFragment,
    ): { readonly fragment: DocumentFragment; readonly failed: number };
  }

  /**
   * One `/v1/history` entry as the wire returns it.
   *
   * `reason` is typed `string`, not a union, on purpose: the ledger's `adjust`
   * rows carry operator-authored free text, so the set is genuinely open. That is
   * exactly why §18.9 maps it through a closed table with a neutral fallback
   * rather than rendering it.
   */
  interface PortalActivityEntry {
    readonly id: string;
    readonly type: "earned" | "spent" | "expired";
    readonly points: number;
    readonly reason: string;
    readonly date: string;
    readonly orderReference: number | null;
  }

  /** One redeemable reward as `/v1/rewards` returns it. */
  interface PortalRewardOffer {
    readonly id: string;
    readonly cost: number;
    readonly valueGBP: number;
  }

  /** One referral stage as `/v1/referral` returns it. */
  interface PortalReferralStage {
    readonly key: string;
    readonly state: string;
    readonly currentRewardPoints?: number;
    readonly creditedPoints?: number;
  }

  /* ====================================================================== *
   * 18.4 — announcements and focus
   * ====================================================================== */

  interface AthoorPortalAnnouncer {
    /**
     * Announce politely in the section's own region (§20.6). Replaces the
     * previous message rather than queueing, so a screen reader is never read a
     * backlog.
     */
    polite(root: HTMLElement, message: string): void;
    /** Announce politely in the one global `role="status"` region. */
    global(message: string): void;
    /**
     * `assertive`, reserved for a failure that STOPS the flow the customer is in
     * — a rejected redemption or a rejected submission. Anything else politely.
     */
    assertive(root: HTMLElement, message: string): void;
    /**
     * Announce a section is loading, at most once per root (§20.6: "loading is
     * announced once, not per skeleton").
     */
    loadingOnce(root: HTMLElement, message: string): void;
  }

  interface AthoorPortalFocus {
    /** To a sheet's heading on open. */
    toSheetHeading(dialog: HTMLElement): void;
    /** Back to the control that opened it, on close. */
    restore(control: Element | null): void;
    /** To the first invalid field on a rejected submission (Requirement 17.7). */
    toFirstInvalid(form: HTMLElement): boolean;
    /** To the section heading when content is replaced wholesale. */
    toSectionHeading(root: HTMLElement): void;
  }

  /* ====================================================================== *
   * 18.5 — the one sheet
   * ====================================================================== */

  interface AthoorPortalSheet {
    /**
     * Open a `<dialog>` as a sheet: focus to its heading, return focus on close,
     * `Esc` and the dismiss control both close it.
     *
     * Returns a `close()` that is safe to call more than once. Closing NEVER
     * cancels work already in flight (spec 18.5) — a customer who dismisses the
     * redemption sheet has still redeemed, and aborting the request would be the
     * one way to produce a spend the customer cannot see.
     */
    open(dialog: HTMLDialogElement, invoker?: Element | null): () => void;
    close(dialog: HTMLDialogElement): void;
    isOpen(dialog: HTMLDialogElement): boolean;
  }

  /* ====================================================================== *
   * 18.6 — the copy map
   * ====================================================================== */

  interface AthoorPortalCopy {
    /**
     * The customer-facing description of a ledger entry (§18.9's table).
     *
     * `rewardValues` maps a reward id to its rendered money, so `spend` shows
     * the value and never the id. Omit it and an unknown reward falls back to
     * "Redeemed — a reward", which is the designed behaviour, not a defect.
     */
    activityDescription(
      entry: PortalActivityEntry,
      rewardValues?: Readonly<Record<string, string>>,
    ): string;
    /** The signed amount as the customer sees it, e.g. `+50`, `−25`. */
    signedPoints(points: number): string;
    /** A referral stage's name, qualification sentence and state wording. */
    referralStage(stage: PortalReferralStage): {
      readonly name: string;
      readonly qualification: string;
      readonly state: string;
    };
    /** Wording for a fulfilment status identifier. */
    fulfilment(identifier: string): string;
    /** Wording for a catalogue availability identifier. */
    availability(identifier: string): string;
    /** Wording for a redemption status identifier. */
    redemptionStatus(identifier: string): string;
    /** Wording for a birthday eligibility state, `{date}` resolved. */
    birthdayEligibility(identifier: string, allowedFrom?: string | null): string;
    /** Wording for a preference's provenance. */
    provenance(identifier: string): string;
    /** Wording for an inferred insight, `{family}` resolved. */
    insight(identifier: string, family?: string | null): string;
    /** Wording for an error identifier — the customer-safe sentence. */
    error(code: string): string;
    /** Wording for a field-level rejection code. */
    fieldError(code: string): string;
    /** Wording for one of the eight designed states. */
    state(state: PortalSectionState): string;
  }

  /* ====================================================================== *
   * The merged runtime
   * ====================================================================== */

  interface AthoorPortalRuntime {
    /** 18.1 — the only `fetch` in the portal. */
    request<T>(spec: PortalRequestSpec): Promise<PortalResult<T>>;
    /** 18.2 */
    readonly cache: AthoorPortalCache;
    /** 18.2 */
    readonly draft: AthoorPortalDraft;
    /** 18.3 */
    readonly states: AthoorPortalStates;
    /** 18.3 */
    readonly rows: AthoorPortalRows;
    /** 18.4 */
    readonly announce: AthoorPortalAnnouncer;
    /** 18.4 */
    readonly focus: AthoorPortalFocus;
    /** 18.5 */
    readonly sheet: AthoorPortalSheet;
    /** 18.6 */
    readonly copy: AthoorPortalCopy;
    /**
     * 18.1 — the per-page-load, non-identifying request-group reference
     * (design §24.2). Exposed so the smoke test can assert it is neither stored
     * nor derived from anything about the customer.
     */
    readonly sessionRef: string;
  }
}
