/**
 * `athoor-portal-referrals.js` — the Referrals section (spec tasks 23.1, 23.2).
 *
 * Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8, 10.9, 10.10, 10.11,
 * 10.13, 10.14, 10.16, 17.5, 1.8.
 *
 * ── NOT ONE REWARD FIGURE LIVES IN THIS FILE ────────────────────────────────
 * Every points amount, stage name, qualification sentence and state word comes
 * from `GET /v1/referral` for the verified customer, rendered through
 * `ui/copy.ts`'s table (Requirements 10.10, 10.14). Task 29.5's gate forbids any
 * numeric reward literal, and the five internal identifiers Requirement 10.15
 * enumerates, anywhere in this module — which is what makes referral economics
 * changeable without a theme deployment (Requirement 10.13, Property 11). This
 * comment therefore CITES that requirement instead of restating the identifiers:
 * the gate reads the file, not the intent, and it is right to.
 *
 * The consequence worth stating: an AWARDED stage renders `creditedPoints` — what
 * the ledger actually paid — not today's configured amount (Requirement 10.16).
 * `rows.stageRow` makes that choice; this module must not second-guess it. A
 * customer who earned an award under the old economics is owed the number they were
 * actually credited, not a figure that silently restates history.
 *
 * ── THE ONE PERMITTED CLIENT-STORAGE WRITE IN THE WHOLE PORTAL ──────────────
 * Every other portal module writes no storage at all. This one writes exactly one
 * key, `athoor_ref`, and only to remember a referral code the customer arrived
 * with on a `?ref=` link so they do not have to retype it after signing up
 * (task 23.2). The rules that keep it from becoming a second source of truth:
 *
 *   - a 30-day expiry ENFORCED ON READ, not merely recorded, so a stale capture
 *     cannot be replayed months later;
 *   - cleared on any DETERMINATE claim outcome — success or a definite rejection —
 *     because after a determinate answer there is nothing left to remember;
 *   - NOT cleared on a rate limit, a timeout or a 5xx, because those say nothing
 *     about the code and the customer must be able to try again;
 *   - read by nothing but the claim path, which is why the only reader is
 *     `readCapturedCode` and its only callers are the claim form's setup and its
 *     submit;
 *   - never authority. The stored code is a convenience prefill. The SERVER
 *     decides whether it may be applied, and rejects self-referral, an already
 *     claimed account and an account past its first order on its own evidence.
 *
 * A note on shared devices, since `localStorage` is device-scoped and not
 * customer-scoped: the worst case is that a second customer on the same device
 * sees a code prefilled that they did not click. That is a prefill, not an
 * entitlement — the server still arbitrates — and the key name is fixed by the
 * approved design, so it is recorded here rather than worked around.
 *
 * SAFETY: two calls to the existing referral endpoints and no additional referral
 * store (Requirement 10.6). One `localStorage` key, written and read only as above.
 * Every value written with `textContent`.
 */
import { registerSection } from "./registration.js";

/** The single permitted client-storage key (task 23.2). */
const REF_KEY = "athoor_ref";

/** Captures older than this are treated as absent and deleted on read. */
const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The server accepts 1–64 characters (`CLAIM_BODY_SCHEMA`); mirror that on read. */
const CODE_MAX = 64;

/**
 * Outcomes after which there is nothing left to remember.
 *
 * Deliberately a closed list of DETERMINATE answers. `rate_limit_exceeded`,
 * `request_timeout` and every 5xx are absent because they are not answers about
 * the code — clearing the capture there would silently destroy the customer's one
 * chance to apply a code they legitimately hold.
 */
const DETERMINATE_CLAIM_FAILURES: ReadonlySet<string> = new Set([
  "invalid_request",
  "unknown_referral_code",
  "self_referral_rejected",
  "referral_already_claimed",
  "referral_not_eligible",
]);

interface ReferralTotalsView {
  readonly successful?: number;
  readonly pending?: number;
  readonly creditedPoints?: number;
}

/**
 * `GET /v1/referral`'s envelope.
 *
 * Declared locally because the service returns an inline object literal and
 * exports no interface for it, so there is nothing importable to reuse. Every
 * field is optional here: a client type that insists on a field the server may
 * omit turns a missing value into a crash instead of a designed empty state.
 */
interface ReferralSummary {
  readonly referralCode?: string | null;
  readonly shareUrl?: string | null;
  readonly wasReferred?: boolean;
  readonly totals?: ReferralTotalsView;
  readonly stages?: readonly PortalReferralStage[];
}

interface ClaimOutcome {
  readonly status?: string;
  readonly referralCode?: string;
}

registerSection("referrals", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const body = root.querySelector<HTMLElement>("[data-portal-body]");
  const template = root.querySelector<HTMLTemplateElement>('[data-portal-row="stage"]');
  const codeNode = root.querySelector<HTMLElement>("[data-portal-referral-code]");
  const linkNode = root.querySelector<HTMLElement>("[data-portal-referral-link]");
  const copyControl = root.querySelector<HTMLButtonElement>("[data-portal-referral-copy]");
  const shareControl = root.querySelector<HTMLButtonElement>("[data-portal-referral-share]");
  const copyResult = root.querySelector<HTMLElement>("[data-portal-referral-copy-result]");
  const totalsNode = root.querySelector<HTMLElement>("[data-portal-referral-totals]");
  const stagesHeading = root.querySelector<HTMLElement>("[data-portal-referral-stages-heading]");
  const claimForm = root.querySelector<HTMLFormElement>("[data-portal-referral-claim]");
  const claimInput = claimForm?.querySelector<HTMLInputElement>("input[name='referralCode']") ?? null;
  const claimMessage = root.querySelector<HTMLElement>("[data-portal-referral-claim-message]");
  const claimSubmit = root.querySelector<HTMLButtonElement>("[data-portal-referral-claim-submit]");

  const list = document.createElement("ul");
  list.className = "athoor-referrals__stages";
  list.setAttribute("role", "list");

  /** The link we offer to copy or share. Never rebuilt client-side. */
  let shareUrl: string | null = null;

  /** One in-flight claim, so a repeated submit cannot start a second. */
  let claiming = false;

  /* ---------------------------------------------------------------------- *
   * The `?ref=` capture — the only client storage in the portal.
   * ---------------------------------------------------------------------- */

  /**
   * Capture a code from the current URL.
   *
   * Runs on every load of this section, before anything is rendered, because the
   * customer may land on a `?ref=` link and sign up before ever reaching a claim
   * form. `localStorage` can throw — Safari private mode, a full quota, a blocked
   * third-party context — so every access is guarded. A capture that cannot be
   * stored is not an error worth showing anyone: the manual entry field still
   * works.
   */
  function captureFromUrl(): void {
    let raw: string | null = null;
    try {
      raw = new URLSearchParams(window.location.search).get("ref");
    } catch {
      return;
    }
    if (raw === null) return;
    const code = raw.trim();
    // Length-bounded on the way IN as well as on the way out: an unbounded value
    // from a URL is not something to hand to `JSON.stringify` and keep for a month.
    if (code === "" || code.length > CODE_MAX) return;
    try {
      window.localStorage.setItem(REF_KEY, JSON.stringify({ code, capturedAt: Date.now() }));
    } catch {
      // Storage unavailable. Nothing to report and nothing to retry.
    }
  }

  /**
   * The captured code, or `null`.
   *
   * THE ONLY READER of the key. The 30-day expiry is enforced here rather than at
   * write time, because a write-time expiry is a promise and a read-time expiry is
   * a fact — the clock moves after the write. An expired or malformed entry is
   * deleted as it is rejected, so a corrupted value cannot be re-parsed on every
   * subsequent load.
   */
  function readCapturedCode(): string | null {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(REF_KEY);
    } catch {
      return null;
    }
    if (raw === null) return null;

    let code: string | null = null;
    let capturedAt = 0;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as { code?: unknown; capturedAt?: unknown };
        if (typeof record.code === "string") code = record.code;
        if (typeof record.capturedAt === "number") capturedAt = record.capturedAt;
      }
    } catch {
      // Malformed. Falls through to the discard below.
    }

    const fresh = capturedAt > 0 && Date.now() - capturedAt <= REF_TTL_MS;
    if (code === null || code === "" || code.length > CODE_MAX || !fresh) {
      clearCapturedCode();
      return null;
    }
    return code;
  }

  function clearCapturedCode(): void {
    try {
      window.localStorage.removeItem(REF_KEY);
    } catch {
      // Nothing to do: the expiry check rejects it on the next read regardless.
    }
  }

  /* ---------------------------------------------------------------------- *
   * Rendering.
   * ---------------------------------------------------------------------- */

  /**
   * The code, the link, and the controls that act on them.
   *
   * A customer with no code yet gets no copy control and no link, because there is
   * nothing to copy — and a control that copies an empty string is worse than an
   * absent one. `shareUrl` is `null` in exactly that case, built server-side so
   * the link format is not a theme literal either.
   */
  function paintInvite(summary: ReferralSummary): void {
    const code = typeof summary.referralCode === "string" ? summary.referralCode : "";
    shareUrl = typeof summary.shareUrl === "string" && summary.shareUrl !== "" ? summary.shareUrl : null;

    if (codeNode) codeNode.textContent = code;
    if (linkNode) {
      if (shareUrl) {
        linkNode.textContent = shareUrl;
        linkNode.removeAttribute("hidden");
      } else {
        linkNode.setAttribute("hidden", "hidden");
      }
    }

    if (copyControl) {
      if (shareUrl) copyControl.removeAttribute("hidden");
      else copyControl.setAttribute("hidden", "hidden");
    }

    // Requirement 10.3 — the share control appears ONLY where the device exposes
    // the capability. Feature-detected, never inferred from a user agent.
    if (shareControl) {
      const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
      if (shareUrl && canShare) shareControl.removeAttribute("hidden");
      else shareControl.setAttribute("hidden", "hidden");
    }
  }

  /** Requirement 10.4 — the three programme totals, as given. */
  function paintTotals(totals: ReferralTotalsView | undefined): void {
    if (!totalsNode) return;
    if (!totals) {
      totalsNode.setAttribute("hidden", "hidden");
      return;
    }
    const write = (slot: string, value: number | undefined): void => {
      const node = totalsNode.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (node) node.textContent = typeof value === "number" ? String(value) : "0";
    };
    write("successful", totals.successful);
    write("pending", totals.pending);
    write("credited", totals.creditedPoints);
    totalsNode.removeAttribute("hidden");
  }

  /**
   * Requirement 10.9 — both stages, each with its amount, qualification and state.
   *
   * `rows.stageRow` owns the amount choice (credited when awarded, configured
   * otherwise) and `ui/copy.ts` owns the wording, including the neutral fallback
   * for a stage identifier this asset has never seen. Neither is re-implemented
   * here, which is the point: a third stage added to the programme renders through
   * the fallback instead of not rendering at all.
   */
  function paintStages(stages: readonly PortalReferralStage[]): void {
    if (!body || !template) return;
    list.textContent = "";
    const { fragment, failed } = runtime.rows.list(stages, template, (stage, tpl) =>
      runtime.rows.stageRow(stage, tpl),
    );
    list.appendChild(fragment);
    if (!body.contains(list)) body.appendChild(list);
    if (stagesHeading) stagesHeading.removeAttribute("hidden");
    if (failed > 0) runtime.announce.polite(root, "Some referral stages could not be shown.");
  }

  /* ---------------------------------------------------------------------- *
   * Copy and share.
   * ---------------------------------------------------------------------- */

  /**
   * Announce AND show the result (task 23.2).
   *
   * A clipboard write produces no visible change, so a confirmation that is only
   * rendered tells a screen-reader user nothing and a confirmation that is only
   * announced leaves a sighted user unsure. Both, every time.
   */
  function reportCopy(message: string): void {
    if (copyResult) {
      copyResult.textContent = message;
      copyResult.removeAttribute("hidden");
    }
    runtime.announce.polite(root, message);
  }

  /**
   * The `execCommand` fallback, for the browsers where `navigator.clipboard` is
   * absent or refuses on an insecure origin.
   *
   * The input is off-screen rather than `display: none`, because a hidden element
   * cannot be selected and the copy silently fails. It is removed in a `finally`
   * so a throw cannot leave a stray focusable node in the section.
   */
  function copyViaFallback(text: string): boolean {
    const scratch = document.createElement("input");
    scratch.setAttribute("aria-hidden", "true");
    scratch.tabIndex = -1;
    scratch.style.position = "fixed";
    scratch.style.top = "-1000px";
    scratch.style.opacity = "0";
    scratch.value = text;
    root.appendChild(scratch);
    try {
      scratch.select();
      scratch.setSelectionRange(0, text.length);
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      scratch.remove();
    }
  }

  async function copyLink(): Promise<void> {
    if (!shareUrl) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === "function") {
      try {
        await clipboard.writeText(shareUrl);
        reportCopy("Link copied.");
        return;
      } catch {
        // Fall through: a refusal is recoverable, and the link is still on screen.
      }
    }
    if (copyViaFallback(shareUrl)) {
      reportCopy("Link copied.");
      return;
    }
    reportCopy("Copying is unavailable. Your link is shown above.");
  }

  async function shareLink(): Promise<void> {
    if (!shareUrl || typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    try {
      await navigator.share({ url: shareUrl, title: "My Athoor" });
    } catch {
      // A dismissed share sheet rejects, and a customer who changed their mind has
      // not experienced a failure. Nothing is announced.
    }
  }

  /* ---------------------------------------------------------------------- *
   * The claim.
   * ---------------------------------------------------------------------- */

  function showClaimMessage(message: string, assertively: boolean): void {
    if (claimMessage) {
      claimMessage.textContent = message;
      claimMessage.removeAttribute("hidden");
    }
    if (assertively) runtime.announce.assertive(root, message);
    else runtime.announce.polite(root, message);
  }

  /**
   * Reveal the manual entry fallback, prefilled from the capture if there is one.
   *
   * Revealed ONLY on an explicit `wasReferred === false`. A missing field is not a
   * licence to offer the form: asking someone who has already been credited to
   * enter a code invites a rejection that did not need to happen.
   */
  function setUpClaim(summary: ReferralSummary): void {
    if (!claimForm) return;
    if (summary.wasReferred !== false) {
      claimForm.setAttribute("hidden", "hidden");
      return;
    }
    claimForm.removeAttribute("hidden");
    const captured = readCapturedCode();
    if (captured !== null && claimInput && claimInput.value === "") {
      claimInput.value = captured;
    }
  }

  async function claim(): Promise<void> {
    if (claiming) return;
    const typed = claimInput?.value.trim() ?? "";
    // Prefer what the customer typed; fall back to the capture only when the field
    // is empty, so a deliberate edit is never overridden by a stored value.
    const code = typed === "" ? (readCapturedCode() ?? "") : typed;
    if (code === "") {
      showClaimMessage("Enter the code your friend gave you.", false);
      return;
    }

    claiming = true;
    if (claimSubmit) {
      claimSubmit.disabled = true;
      // §18.8 — a disabled control states its reason.
      claimSubmit.setAttribute("aria-label", "Applying your code…");
    }

    const result = await runtime.request<ClaimOutcome>({
      method: "POST",
      path: "/referral",
      body: { referralCode: code },
    });

    claiming = false;
    if (claimSubmit) {
      claimSubmit.disabled = false;
      claimSubmit.removeAttribute("aria-label");
    }

    if (!result.ok) {
      const failure = result.error.code;
      showClaimMessage(runtime.copy.error(failure), true);
      // Determinate answers only. A rate limit or a timeout leaves the capture in
      // place so the customer can try again.
      if (DETERMINATE_CLAIM_FAILURES.has(failure)) clearCapturedCode();
      return;
    }

    // A determinate success, including `already_rewarded` — which is the idempotent
    // replay of a claim that already landed, not a failure to report as one.
    clearCapturedCode();
    if (claimInput) claimInput.value = "";
    showClaimMessage(
      result.value.status === "already_rewarded"
        ? "That code was already applied to your account."
        : "Code applied. Your friend will be credited when the conditions are met.",
      false,
    );
    // The programme figures have changed, so re-read rather than patch them here.
    runtime.cache.clear();
    void load();
  }

  /* ---------------------------------------------------------------------- *
   * Load.
   * ---------------------------------------------------------------------- */

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    const result = await runtime.cache.read<ReferralSummary>({
      method: "GET",
      path: "/referral",
    });
    if (!result.ok) {
      runtime.states.degrade(root, result.error, () => void load());
      return;
    }

    const summary = result.value;
    // The invite, the totals and the claim form all sit OUTSIDE `data-portal-body`,
    // so they survive the `empty` state. That is what lets Requirement 10.8's empty
    // state carry the code and an invitation rather than an apology.
    paintInvite(summary);
    paintTotals(summary.totals);
    setUpClaim(summary);

    const stages = summary.stages ?? [];
    if (stages.length === 0) {
      runtime.states.set(root, "empty", {
        announce: "You have no referrals yet. Share your code to begin.",
      });
      return;
    }
    paintStages(stages);
    runtime.states.set(root, "ready");
  }

  // Bound on this section's own root, never on `document` (§16.10).
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-portal-referral-copy]")) {
      void copyLink();
      return;
    }
    if (target.closest("[data-portal-referral-share]")) void shareLink();
  });

  if (claimForm) {
    claimForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void claim();
    });
  }

  // Before the first render: the customer may have arrived on a `?ref=` link and
  // will not reach a claim form until after they have an account.
  captureFromUrl();
  void load();
});
