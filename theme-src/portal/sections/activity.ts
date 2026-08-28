/**
 * `athoor-portal-activity.js` — Rewards Activity (spec task 22.4).
 *
 * Requirements 9.1, 9.2, 9.5, 9.6, 9.7, 9.9, 9.10.
 *
 * ── EVERY DESCRIPTION COMES FROM `ui/copy.ts` ────────────────────────────────
 * Never from the ledger's `reason`. §1.5 records that production currently shows
 * customers strings like `reward_15`, and §18.9's table is the replacement: a closed
 * map with a neutral fallback, so a tenth `entry_type` added next year renders as
 * "An adjustment to your account" rather than as an identifier. Requirement 9.8's
 * unmapped case is therefore handled by construction, not by a branch here.
 *
 * Operator free text on an `adjust` row is mapped away unconditionally
 * (Requirement 9.7) — it is written by staff for staff and may name a person or a
 * ticket.
 *
 * ── A SUB-VIEW WITH ITS OWN URL (task 22.4) ─────────────────────────────────
 * `/pages/my-athoor-activity` is a real page with its own bundle and its own
 * request, reached from Rewards. It is not a tab that hides content behind
 * JavaScript, because a URL a customer can bookmark and share is worth more than a
 * saved request — and §16.6 rules out a client router entirely.
 *
 * SAFETY: reads only. This module writes nothing, anywhere.
 */
import { registerSection } from "./registration.js";

/** Task 22.4 — pages of at most 25. */
const PAGE_SIZE = 25;

interface HistoryPage {
  readonly entries?: readonly PortalActivityEntry[];
  readonly totalCount?: number;
  readonly hasNextPage?: boolean;
}

interface RewardOffer {
  readonly id: string;
  readonly valueGBP: number;
}

registerSection("activity", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const body = root.querySelector<HTMLElement>("[data-portal-body]");
  const template = root.querySelector<HTMLTemplateElement>('[data-portal-row="activity"]');
  const more = root.querySelector<HTMLButtonElement>("[data-portal-more-activity]");
  const list = document.createElement("ul");
  list.className = "athoor-activity__list";
  list.setAttribute("role", "list");

  let page = 1;
  let rendered = 0;
  let loading = false;

  /**
   * Reward id → rendered money, so a `spend` row shows the VALUE and never the id.
   *
   * Fetched from `/v1/rewards`, which is the catalogue's own contract
   * (`valueGBP: number`). An id the catalogue does not know falls back to
   * "Redeemed — a reward", which is `ui/copy.ts`'s designed behaviour rather than a
   * defect.
   */
  let rewardValues: Record<string, string> = {};

  async function loadRewardValues(): Promise<void> {
    const result = await runtime.cache.read<{ rewards?: readonly RewardOffer[] }>({
      method: "GET",
      path: "/rewards",
    });
    if (!result.ok) return;
    const map: Record<string, string> = {};
    for (const reward of result.value.rewards ?? []) {
      map[reward.id] = `£${String(reward.valueGBP)}`;
    }
    rewardValues = map;
  }

  /** One entry. The description and the signed amount both come from the copy map. */
  function renderEntry(entry: PortalActivityEntry, tpl: HTMLTemplateElement): DocumentFragment {
    const fragment = tpl.content.cloneNode(true) as DocumentFragment;
    const set = (slot: string, value: string): void => {
      const node = fragment.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
      if (node) node.textContent = value;
    };

    set("description", runtime.copy.activityDescription(entry, rewardValues));
    set("points", runtime.copy.signedPoints(entry.points));
    set("date", runtime.copy.formatDate(entry.date));

    // Requirement 9.5 — a route to the order for an order-related entry, and no
    // link at all when there is no order reference.
    const link = fragment.querySelector<HTMLAnchorElement>('[data-slot="order-link"]');
    if (link) {
      if (entry.orderReference !== null && entry.orderReference !== undefined) {
        link.href = `/pages/my-athoor-order-detail?id=${encodeURIComponent(String(entry.orderReference))}`;
        link.textContent = "View order";
        link.removeAttribute("hidden");
      } else {
        link.remove();
      }
    }
    return fragment;
  }

  async function load(append: boolean): Promise<void> {
    if (loading) return;
    loading = true;
    if (more) more.disabled = true;

    if (!append) {
      runtime.states.set(root, "loading");
      runtime.announce.loadingOnce(root, runtime.copy.state("loading"));
      await loadRewardValues();
    }

    const result = await runtime.cache.read<HistoryPage>({
      method: "GET",
      path: "/history",
      query: { page, pageSize: PAGE_SIZE },
    });

    loading = false;

    if (!result.ok) {
      runtime.states.degrade(root, result.error, () => void load(append));
      if (more) more.disabled = false;
      return;
    }

    const entries = result.value.entries ?? [];
    if (!append && entries.length === 0) {
      // Requirement 9.10 — an empty state that describes how points are earned,
      // which the Liquid renders.
      runtime.states.set(root, "empty", { announce: "You have no points activity yet." });
      return;
    }

    if (template) {
      const { fragment, failed } = runtime.rows.list(entries, template, renderEntry);
      list.appendChild(fragment);
      rendered += entries.length - failed;
      if (failed > 0) runtime.announce.polite(root, "Some entries could not be shown.");
    }
    if (body && !body.contains(list)) body.appendChild(list);
    runtime.states.set(root, "ready");

    const hasMore = result.value.hasNextPage === true;
    if (more) {
      more.disabled = false;
      if (hasMore) more.removeAttribute("hidden");
      else more.setAttribute("hidden", "hidden");
    }
    if (hasMore) page += 1;

    if (append) {
      // §20.2 — the new count, and focus stays on the control.
      runtime.announce.polite(root, `${String(entries.length)} more shown. ${String(rendered)} in total.`);
    }
  }

  if (more) more.addEventListener("click", () => void load(true));

  void load(false);
});
