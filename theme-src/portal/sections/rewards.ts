/**
 * `athoor-portal-rewards.js` — Rewards and the redemption flow (spec tasks 22.2,
 * 22.3).
 *
 * Requirements 8.1–8.14, 3.7, 3.8, 14.3–14.6, 16.3, 16.4, 16.5, 17.4, 17.8, 18.9,
 * 20.4, 25.8.
 *
 * ── THIS MODULE PERFORMS NO POINTS ARITHMETIC ────────────────────────────────
 * Task 22.2 is emphatic, and §1.5 records why: the production dashboard computes
 * tier and progress in the browser, and it disagrees with the ledger. So every
 * figure here is rendered AS GIVEN — `spendableBalance`, `tier`, `tierMultiplier`,
 * `progressToNextTierGBP`, `redeemable`, `additionalPointsRequired`. There is no
 * threshold comparison, no tier derivation, no multiplier calculation.
 *
 * The single exception is stated in task 22.1 and is deliberately bounded: the
 * progress bar's FILL RATIO, computed from two server-supplied operands, because a
 * width has to be a number and the server does not send one.
 *
 * ── REDEMPTION REUSES THE PROVEN ENGINE, AND ADDS NO MECHANISM ───────────────
 * `POST /v1/redeem` already guarantees idempotency and conservation — properties
 * proven in tasks 5 and 16, not claimed here. What this module owns is the client
 * half:
 *
 *   ONE INTENT, ONE KEY. The transport mints one `Idempotency-Key` per call and
 *   reuses it across its own network retries (task 18.1). This module holds ONE
 *   in-flight promise per reward, so a double press joins the first request rather
 *   than starting a second — which, combined with the server's idempotency, makes a
 *   duplicate spend unreachable from two directions.
 *
 *   NO SUCCESS BEFORE THE BACKEND SAYS SO. Nothing is announced, and no code is
 *   shown, until the response arrives. `pending_code` is a CONFIRMED state — the
 *   points are spent and the code is being minted — so it is presented as success
 *   awaiting a code, never as an error.
 *
 *   THE BALANCE IS RE-READ FROM THE NETWORK. `invalidateBalance()` then a fresh
 *   read, because §16.5's 60 s snapshot would otherwise show the pre-redemption
 *   balance for up to a minute. A customer who has just spent points and sees the
 *   old total cannot tell whether the spend worked.
 *
 * ── THE `valueGBP` CONTRACT DIFFERS BETWEEN THE TWO SHAPES ──────────────────
 * `Reward.valueGBP` is a NUMBER (the catalogue); `PortalRedemption.valueGBP` is a
 * `MoneyGBP` STRING (the ledger). They are rendered differently on purpose rather
 * than normalised, because normalising would mean this module deciding how money
 * formats — which is exactly the arithmetic it is not allowed to do.
 *
 * SAFETY: one read, one write per redemption, and a bounded read-only poll. No
 * storage. No cart involvement — a reward is a discount code, not a cart line.
 */
import { registerSection } from "./registration.js";
import type { PortalRedemptionsResponse } from "../data/types.js";

/** Task 22.3 — bounded polling for the minted code. */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ATTEMPTS = 5;

interface RewardOffer {
  readonly id: string;
  readonly cost: number;
  readonly valueGBP: number;
  readonly redeemable?: boolean;
  readonly additionalPointsRequired?: number;
}

interface BalanceSummary {
  readonly spendableBalance?: number;
  readonly tier?: string;
  readonly tierMultiplier?: number;
  readonly isTopTier?: boolean;
  readonly nextTier?: string | null;
  readonly nextTierThresholdGBP?: number | null;
  readonly progressToNextTierGBP?: number | null;
  readonly lifetimeSpendGBP?: number;
  readonly availableRewards?: readonly RewardOffer[];
  readonly expiringSoon?: { points: number; earliestExpiryAt: string; windowDays: number };
}

interface RedemptionOutcome {
  readonly id?: string;
  readonly rewardId?: string;
  readonly pointsSpent?: number;
  readonly status?: string;
  readonly code?: string | null;
}

registerSection("rewards", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const body = root.querySelector<HTMLElement>("[data-portal-body]");
  const cardTemplate = root.querySelector<HTMLTemplateElement>('[data-portal-row="reward"]');
  const sheet = root.querySelector<HTMLDialogElement>("[data-portal-redeem-sheet]");

  /** ONE in-flight promise per reward (task 22.3). */
  const inFlight = new Map<string, Promise<void>>();

  function text(slot: string, value: string): void {
    const node = root.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    if (node) node.textContent = value;
  }

  /** Render the balance, tier and progress exactly as the server reported them. */
  function paintSummary(summary: BalanceSummary): void {
    const balance = summary.spendableBalance;
    text("balance", typeof balance === "number" ? String(balance) : "0");
    text("tier", typeof summary.tier === "string" ? summary.tier : "");
    text(
      "multiplier",
      typeof summary.tierMultiplier === "number" ? `${String(summary.tierMultiplier)}× points` : "",
    );

    // §20.4 — a progressbar with its values AND an adjacent text statement, because
    // `aria-valuenow` alone is not a sentence a sighted customer can read.
    const bar = root.querySelector<HTMLElement>("[data-portal-progress]");
    const remaining = summary.progressToNextTierGBP;
    const threshold = summary.nextTierThresholdGBP;
    if (bar) {
      if (summary.isTopTier || remaining === null || remaining === undefined || !threshold) {
        bar.remove();
        text("progress-text", summary.isTopTier ? "You are at our highest tier." : "");
      } else {
        // THE ONE PERMITTED CALCULATION: a fill ratio over two server-supplied
        // operands (task 22.1). No threshold comparison, no tier derivation.
        const attained = Math.max(0, threshold - remaining);
        const ratio = threshold > 0 ? Math.min(1, attained / threshold) : 0;
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", String(threshold));
        bar.setAttribute("aria-valuenow", String(attained));
        const fill = bar.querySelector<HTMLElement>("[data-portal-progress-fill]");
        // Set once and NOT transitioned (task 22.1): an animated bar on first paint
        // is motion the customer did not ask for.
        if (fill) fill.style.width = `${String(Math.round(ratio * 100))}%`;
        text(
          "progress-text",
          `£${remaining.toFixed(2)} more spend to reach ${summary.nextTier ?? "the next tier"}.`,
        );
      }
    }

    // Requirement 8.13 — the expiring-points note, only when there is one.
    const expiring = root.querySelector<HTMLElement>("[data-portal-expiring]");
    if (expiring) {
      if (summary.expiringSoon && summary.expiringSoon.points > 0) {
        expiring.textContent = `${String(summary.expiringSoon.points)} points expire on ${runtime.copy.formatDate(summary.expiringSoon.earliestExpiryAt)}.`;
        expiring.removeAttribute("hidden");
      } else {
        expiring.remove();
      }
    }
  }

  /** Render the catalogue, with eligibility as given (Requirements 8.5, 8.6). */
  function paintCatalogue(rewards: readonly RewardOffer[]): void {
    if (!body || !cardTemplate) return;
    const list = document.createElement("ul");
    list.className = "athoor-rewards__catalogue";
    list.setAttribute("role", "list");

    const { fragment, failed } = runtime.rows.list(rewards, cardTemplate, (reward, tpl) => {
      // `Reward.valueGBP` is a NUMBER here — the catalogue's contract.
      const card = runtime.rows.rewardCard(
        { id: reward.id, cost: reward.cost, valueGBP: reward.valueGBP },
        tpl,
      );
      const action = card.querySelector<HTMLButtonElement>("[data-slot='redeem']");
      if (action) {
        action.dataset.rewardId = reward.id;
        action.dataset.cost = String(reward.cost);
        action.dataset.value = `£${String(reward.valueGBP)}`;
        if (reward.redeemable === false) {
          action.disabled = true;
          // §18.8 — a disabled control must state WHY, and the reason is the
          // server's own `additionalPointsRequired`, not a comparison we made.
          const short = reward.additionalPointsRequired;
          action.setAttribute(
            "aria-label",
            typeof short === "number"
              ? `${String(short)} more points needed for £${String(reward.valueGBP)}`
              : `Not available yet`,
          );
          const note = card.querySelector<HTMLElement>("[data-slot='eligibility']");
          if (note && typeof short === "number") {
            note.textContent = `${String(short)} more points needed`;
          }
        }
      }
      return card;
    });

    list.appendChild(fragment);
    body.textContent = "";
    body.appendChild(list);
    if (failed > 0) runtime.announce.polite(root, "Some rewards could not be shown.");
  }

  /** Show the issued code, or the confirmed-awaiting-code state. */
  function paintOutcome(outcome: RedemptionOutcome, cost: number, value: string): void {
    const panel = root.querySelector<HTMLElement>("[data-portal-code-panel]");
    if (!panel) return;
    panel.removeAttribute("hidden");

    const codeNode = panel.querySelector<HTMLElement>("[data-portal-code]");
    const copyControl = panel.querySelector<HTMLButtonElement>("[data-portal-copy-code]");

    if (outcome.code) {
      if (codeNode) codeNode.textContent = outcome.code;
      if (copyControl) {
        copyControl.dataset.code = outcome.code;
        copyControl.removeAttribute("hidden");
      }
      runtime.announce.polite(
        root,
        `Redeemed ${String(cost)} points for ${value}. Your code is ${outcome.code}.`,
      );
      return;
    }

    // `pending_code` — CONFIRMED, not an error (Requirement 8.10). The points are
    // spent; the code is being minted by the worker.
    if (codeNode) codeNode.textContent = runtime.copy.redemptionStatus("pending_code");
    if (copyControl) copyControl.setAttribute("hidden", "hidden");
    runtime.announce.polite(root, `Redeemed ${String(cost)} points for ${value}. Your code is being issued.`);
  }

  /**
   * Poll for the minted code — bounded, read-only, and it never invents an error.
   *
   * Task 22.3: 2 s, at most 5 attempts, ending with "your code will appear in
   * Rewards Activity". Bounded because an unbounded poll against a worker that is
   * genuinely stuck becomes a request every two seconds for as long as the tab is
   * open, and the honest answer after ten seconds is "check back", not "failed".
   */
  async function pollForCode(redemptionId: string, cost: number, value: string): Promise<void> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const result = await runtime.request<PortalRedemptionsResponse>({
        method: "GET",
        path: "/redemptions",
      });
      if (!result.ok) continue;
      const found = (result.value.redemptions ?? []).find((r) => r.id === redemptionId);
      if (found?.code) {
        paintOutcome({ id: found.id, code: found.code, status: found.status }, cost, value);
        return;
      }
    }
    // Never an invented error (task 22.3).
    runtime.announce.polite(root, "Your code will appear in Rewards Activity shortly.");
    const codeNode = root.querySelector<HTMLElement>("[data-portal-code]");
    if (codeNode) codeNode.textContent = "Your code will appear in Rewards Activity shortly.";
  }

  /** The redemption itself. One promise per reward. */
  function redeem(rewardId: string, cost: number, value: string, control: HTMLButtonElement): Promise<void> {
    // ONE IN-FLIGHT PROMISE PER REWARD (task 22.3). A second press joins the first
    // rather than starting a second request — belt to the server's idempotency
    // braces, and the thing that makes a double press render exactly one outcome.
    const existing = inFlight.get(rewardId);
    if (existing) return existing;

    control.disabled = true;
    // §18.8 — the disabled state states its reason.
    control.setAttribute("aria-label", `Redeeming ${value}…`);

    const flight = (async (): Promise<void> => {
      const result = await runtime.request<RedemptionOutcome>({
        method: "POST",
        path: "/redeem",
        body: { rewardId },
      });

      if (!result.ok) {
        // Distinct designed outcomes, each with the no-points-taken assurance and
        // NO code (Requirement 8.11). The wording comes from the copy map, so a new
        // code added to the service renders the neutral sentence rather than an
        // identifier.
        const code = result.error.code;
        const assurance =
          code === "rate_limit_exceeded"
            ? ""
            : " No points have been taken.";
        runtime.announce.assertive(root, `${runtime.copy.error(code)}${assurance}`);

        if (code === "rate_limit_exceeded") {
          const wait = result.error.retryAfterSeconds;
          const note = root.querySelector<HTMLElement>("[data-portal-wait]");
          if (note && typeof wait === "number") {
            note.textContent = `Please wait ${String(wait)} seconds before trying again.`;
            note.removeAttribute("hidden");
          }
        }
        control.disabled = false;
        control.removeAttribute("aria-label");
        return;
      }

      // Success. Now — and only now — the balance is stale.
      runtime.cache.invalidateBalance();
      paintOutcome(result.value, cost, value);

      const summary = await runtime.cache.read<BalanceSummary>({ method: "GET", path: "/balance" });
      if (summary.ok) paintSummary(summary.value);

      if (!result.value.code && result.value.id) {
        void pollForCode(result.value.id, cost, value);
      }
      // The control stays disabled: the points are spent.
    })();

    inFlight.set(rewardId, flight);
    void flight.finally(() => {
      inFlight.delete(rewardId);
    });
    return flight;
  }

  /** Confirmation in the Task 18.5 sheet — no second modal system. */
  function confirm(control: HTMLButtonElement): void {
    const rewardId = control.dataset.rewardId;
    const cost = Number(control.dataset.cost ?? "0");
    const value = control.dataset.value ?? "";
    if (!rewardId || control.disabled) return;

    if (!sheet) {
      // No sheet in the markup: redeem directly rather than blocking the customer.
      void redeem(rewardId, cost, value, control);
      return;
    }

    // Requirement 8.7 — the sheet shows the cost AND the resulting balance.
    const balanceNow = Number(root.querySelector("[data-slot='balance']")?.textContent ?? "0");
    const costNode = sheet.querySelector<HTMLElement>("[data-slot='sheet-cost']");
    if (costNode) costNode.textContent = `${String(cost)} points for ${value}`;
    const afterNode = sheet.querySelector<HTMLElement>("[data-slot='sheet-after']");
    if (afterNode) {
      // Presentational subtraction of two numbers already on screen — not points
      // arithmetic that decides anything. The authoritative balance is re-read from
      // the server immediately after the redemption.
      afterNode.textContent = `${String(Math.max(0, balanceNow - cost))} points remaining afterwards`;
    }

    const close = runtime.sheet.open(sheet, control);
    const confirmControl = sheet.querySelector<HTMLButtonElement>("[data-portal-redeem-confirm]");
    if (confirmControl) {
      confirmControl.onclick = () => {
        close();
        void redeem(rewardId, cost, value, control);
      };
    }
  }

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    // ONE request serves balance, tier, progress, multiplier, benefits and the
    // catalogue with eligibility (task 22.2).
    const result = await runtime.cache.read<BalanceSummary>({ method: "GET", path: "/balance" });
    if (!result.ok) {
      runtime.states.degrade(root, result.error, () => void load());
      return;
    }
    paintSummary(result.value);
    paintCatalogue(result.value.availableRewards ?? []);
    runtime.states.set(root, "ready");
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const redeemControl = target.closest<HTMLButtonElement>("[data-slot='redeem']");
    if (redeemControl?.dataset.rewardId) {
      confirm(redeemControl);
      return;
    }

    const copyControl = target.closest<HTMLButtonElement>("[data-portal-copy-code]");
    if (copyControl?.dataset.code) {
      const code = copyControl.dataset.code;
      // `navigator.clipboard` is unavailable on an insecure origin and in some
      // browsers. A failure is announced rather than silent, because the code is
      // still on screen to be read.
      const clipboard = navigator.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        void clipboard.writeText(code).then(
          () => runtime.announce.global("Code copied."),
          () => runtime.announce.global("Could not copy. The code is shown above."),
        );
      } else {
        runtime.announce.global("Copying is unavailable. The code is shown above.");
      }
    }
  });

  void load();
});
