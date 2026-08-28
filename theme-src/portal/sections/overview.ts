/**
 * `athoor-portal-overview.js` — the Portal_Home (tasks 27.1–27.3).
 *
 * Requirements 4.1–4.12, 1.8, 15.1, 15.2, 15.8, 18.5, 18.8, 18.9, 21.5 (design
 * §21.5, §21.6).
 *
 * ── THIS SECTION WRITES NOTHING ─────────────────────────────────────────────
 * Overview is read-only: six reads and no mutation of any kind. It is the only
 * section with no write path at all, which is worth stating because it means every
 * failure here is recoverable by a retry and none of them can leave a half-applied
 * change.
 *
 * ── THREE PARALLEL READS, NOT SIX (§21.5) ───────────────────────────────────
 * `GET /v1/balance`, `GET /v1/orders?pageSize=1` and `GET /v1/profile/wishlist` go
 * out together on boot. Referral, birthday and the fragrance-derived tile are
 * deferred to an `IntersectionObserver`, because the free Render instance is
 * single-threaded per request and two of the six need Admin API round trips — fanning
 * out all six turns one cold start into six queued cold starts. Deferring costs
 * nothing when the tile is below the fold.
 *
 * The balance read goes through `cache.read`, so the Rewards page's own read within
 * 60 s is served from the same snapshot and a second visit does not pay for it twice
 * (Requirements 18.8, 18.9).
 *
 * ── OMIT, DO NOT EMPTY; AND NEVER REVEAL ────────────────────────────────────
 * §21.6's three rules together: content is never inserted above existing content, no
 * element appears on hydration that the server render lacked, and a tile with no data
 * is REMOVED rather than revealed. So this module only ever fills a server-rendered
 * box or deletes it — it appends no tile, and it inserts nothing anywhere. That is
 * why `paint*` functions take a tile that already exists and why the failure path
 * calls `drop()` instead of writing an empty state into it.
 *
 * A tile that fails is dropped rather than degraded, and that is deliberate: this is
 * a summary, and eight "unavailable" boxes is a worse page than a shorter one. The
 * section itself only degrades when ALL THREE boot reads fail, because at that point
 * there is no summary left to show. Every other section keeps its own degraded state,
 * which is where a retry belongs.
 *
 * ── EACH TILE FAILS ALONE (Requirements 15.1, 15.2, 15.8) ───────────────────
 * Every tile has its own request and its own `try`. A thrown renderer takes its tile
 * with it and leaves the rest of the page — and the navigation — untouched.
 *
 * SAFETY: reads only. No storage. No customer identifier is read from the DOM or
 * sent in any request; the App Proxy signature is the only identity channel.
 */
import { registerSection } from "./registration.js";
import type { PortalCatalogProduct, PortalCatalogResponse } from "../data/types.js";

/** Requirement 4.6 — a preview of up to three. */
const WISHLIST_PREVIEW = 3;

/** How many recently-viewed products the strip shows. */
const RECENT_PREVIEW = 4;

/** Month names, so a date renders without `toLocaleDateString`'s locale drift. */
interface RewardOffer {
  readonly id?: string;
  readonly cost?: number;
  readonly valueGBP?: number;
  readonly redeemable?: boolean;
}

interface BalanceSummary {
  readonly spendableBalance?: number;
  readonly tier?: string;
  readonly isTopTier?: boolean;
  readonly nextTier?: string | null;
  readonly nextTierThresholdGBP?: number | null;
  readonly progressToNextTierGBP?: number | null;
  readonly availableRewards?: readonly RewardOffer[];
}

interface OrderSummary {
  readonly id?: string;
  readonly name?: string;
  readonly processedAt?: string;
  readonly totalGBP?: string;
  readonly fulfilmentStatus?: string;
}

interface OrdersResponse {
  readonly orders?: readonly OrderSummary[];
}

interface WishlistSet {
  readonly wishlist?: readonly string[];
}

interface ReferralSummary {
  readonly referralCode?: string | null;
  readonly totals?: { successful?: number };
}

interface BirthdayResponse {
  readonly birthday?: { month: number; day: number } | null;
  readonly eligibility?: { state?: string };
}

interface ProfileResponse {
  readonly inferred?: { insight?: { kind?: string; value?: string } | null };
  readonly recentlyViewed?: readonly { productId?: string }[];
}

registerSection("overview", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  /** A server-rendered tile, or `null` when the markup does not carry it. */
  const tile = (name: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-portal-tile="${name}"]`);

  const template = (name: string): HTMLTemplateElement | null =>
    root.querySelector<HTMLTemplateElement>(`[data-portal-row="${name}"]`);

  /**
   * Remove a tile.
   *
   * Requirement 4.11's "omit rather than present an empty container", and §21.6's
   * "removed rather than revealed". Removal is the ONLY structural change this module
   * makes; it never appends or inserts.
   */
  function drop(name: string): void {
    tile(name)?.remove();
  }

  /** Fill one slot inside a tile. `textContent` only — never `innerHTML` (§5.3). */
  function set(host: HTMLElement, slot: string, value: string): void {
    const node = host.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
    if (node) node.textContent = value;
  }

  /**
   * Render a tile, or drop it if anything throws.
   *
   * Requirement 15.8 — a JavaScript error is contained to its own tile and the rest
   * of the page, including navigation, stays operable. The exception is not read
   * (design E.1 rule 2), because an upstream message must never reach the output.
   */
  function render(name: string, paint: (host: HTMLElement) => boolean): void {
    const host = tile(name);
    if (!host) return;
    try {
      if (!paint(host)) drop(name);
    } catch {
      drop(name);
    }
  }

  /* ---------------------------------------------------------------------- *
   * The three boot tiles.
   * ---------------------------------------------------------------------- */

  /** Requirements 4.2, 4.3 — balance, tier, and progress or the top-tier line. */
  function paintLoyalty(host: HTMLElement, summary: BalanceSummary): boolean {
    const balance = summary.spendableBalance;
    if (typeof balance !== "number") return false;
    set(host, "balance", String(balance));
    set(host, "tier", typeof summary.tier === "string" ? summary.tier : "");

    const bar = host.querySelector<HTMLElement>("[data-portal-progress]");
    const remaining = summary.progressToNextTierGBP;
    const threshold = summary.nextTierThresholdGBP;

    if (summary.isTopTier === true || remaining === null || remaining === undefined || !threshold) {
      // Requirement 4.3 — the highest-tier indication INSTEAD of progress. The track
      // is removed rather than shown full, which would read as an unfinished bar.
      bar?.remove();
      set(host, "progress-text", summary.isTopTier === true ? "You are at our highest tier." : "");
      return true;
    }

    // The one permitted calculation: a fill ratio over two server-supplied operands.
    const attained = Math.max(0, threshold - remaining);
    const ratio = threshold > 0 ? Math.min(1, attained / threshold) : 0;
    if (bar) {
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", String(threshold));
      bar.setAttribute("aria-valuenow", String(attained));
      const fill = bar.querySelector<HTMLElement>("[data-portal-progress-fill]");
      // Set once and NOT transitioned (§21.6): an animated bar on first paint is
      // motion the customer did not ask for, and it makes the value ambiguous.
      if (fill) fill.style.width = `${String(Math.round(ratio * 100))}%`;
    }
    set(
      host,
      "progress-text",
      `£${remaining.toFixed(2)} more spend to reach ${summary.nextTier ?? "the next tier"}.`,
    );
    return true;
  }

  /**
   * Requirement 4.5 — ONE reward the customer can redeem now.
   *
   * The best value they can actually afford, which is the customer-favourable reading
   * of "one reward" and a presentational choice rather than a business rule: the
   * server has already decided WHICH rewards are redeemable via `redeemable`, and
   * this only picks among them.
   */
  function paintReward(host: HTMLElement, rewards: readonly RewardOffer[]): boolean {
    let best: RewardOffer | null = null;
    for (const reward of rewards) {
      if (reward.redeemable !== true) continue;
      if (typeof reward.valueGBP !== "number") continue;
      if (best === null || reward.valueGBP > (best.valueGBP ?? 0)) best = reward;
    }
    if (best === null) return false;
    set(host, "value", `£${String(best.valueGBP)}`);
    set(host, "cost", typeof best.cost === "number" ? `${String(best.cost)} points` : "");
    return true;
  }

  /** Requirement 4.4 — the most recent order, its date, and a route to its detail. */
  function paintOrder(host: HTMLElement, orders: readonly OrderSummary[]): boolean {
    const order = orders[0];
    if (!order || typeof order.id !== "string" || order.id === "") return false;
    set(host, "name", typeof order.name === "string" ? order.name : "Your order");
    set(host, "date", order.processedAt ? runtime.copy.formatDate(order.processedAt) : "");
    set(host, "total", typeof order.totalGBP === "string" ? `£${order.totalGBP}` : "");
    set(
      host,
      "status",
      typeof order.fulfilmentStatus === "string" ? runtime.copy.fulfilment(order.fulfilmentStatus) : "",
    );
    const link = host.querySelector<HTMLAnchorElement>("[data-portal-order-link]");
    if (link) link.href = `/pages/my-athoor-order-detail?id=${encodeURIComponent(order.id)}`;
    return true;
  }

  /** Requirement 4.6 — up to three saved items, enriched from the catalogue. */
  async function paintWishlist(ids: readonly string[]): Promise<void> {
    const host = tile("wishlist");
    if (!host) return;
    if (ids.length === 0) {
      drop("wishlist");
      return;
    }
    const preview = ids.slice(0, WISHLIST_PREVIEW);
    const rowTemplate = template("overview-wishlist");
    const list = host.querySelector<HTMLElement>("[data-portal-wishlist-list]");
    if (!rowTemplate || !list) {
      drop("wishlist");
      return;
    }

    const enriched = await runtime.cache.read<PortalCatalogResponse>({
      method: "GET",
      path: "/catalog/products",
      query: { ids: preview.join(",") },
      target: "shopify",
    });
    // A preview of product ids is not a preview of products, so the tile goes rather
    // than rendering a row of numbers.
    if (!enriched.ok) {
      drop("wishlist");
      return;
    }

    const byId = new Map<string, PortalCatalogProduct>();
    for (const product of enriched.value.products ?? []) byId.set(String(product.productId), product);
    const ordered = preview
      .map((id) => byId.get(id))
      .filter((product): product is PortalCatalogProduct => product !== undefined);
    if (ordered.length === 0) {
      drop("wishlist");
      return;
    }

    const { fragment } = runtime.rows.list(ordered, rowTemplate, (product, tpl) => {
      const row = tpl.content.cloneNode(true) as DocumentFragment;
      const link = row.querySelector<HTMLAnchorElement>("[data-slot='link']");
      if (link) {
        if (typeof product.handle === "string" && product.handle !== "") {
          link.href = `/products/${encodeURIComponent(product.handle)}`;
        } else {
          link.removeAttribute("href");
        }
      }
      const title = row.querySelector<HTMLElement>("[data-slot='title']");
      if (title) title.textContent = product.title;
      const image = row.querySelector<HTMLImageElement>("[data-slot='image']");
      if (image && product.imageUrl) image.src = product.imageUrl;
      else image?.remove();
      return row;
    });
    list.appendChild(fragment);
  }

  /* ---------------------------------------------------------------------- *
   * The deferred tiles.
   * ---------------------------------------------------------------------- */

  /** Requirement 4.7 — the successful-referral count, where a code exists. */
  async function loadReferral(): Promise<void> {
    const result = await runtime.cache.read<ReferralSummary>({ method: "GET", path: "/referral" });
    if (!result.ok) {
      drop("referral");
      return;
    }
    render("referral", (host) => {
      const summary = result.value;
      // "WHERE the customer has a referral code" — no code, no tile.
      if (typeof summary.referralCode !== "string" || summary.referralCode === "") return false;
      const count = summary.totals?.successful ?? 0;
      set(
        host,
        "referral-count",
        count === 0
          ? "No one has used your code yet."
          : `${String(count)} ${count === 1 ? "friend has" : "friends have"} joined with your code.`,
      );
      return true;
    });
  }

  /**
   * Requirement 4.8 — the birthday eligibility state, where a birthday is recorded
   * AND a benefit is available.
   *
   * Both halves of that conjunction are load-bearing. `outside_window` and
   * `already_granted_this_year` are recorded birthdays with no benefit available, so
   * the tile is omitted rather than telling the customer about a gift they cannot
   * have yet. The full state lives on the Profile page, which is what the route is
   * for.
   */
  async function loadBirthday(): Promise<void> {
    const result = await runtime.cache.read<BirthdayResponse>({
      method: "GET",
      path: "/profile/birthday",
    });
    if (!result.ok) {
      drop("birthday");
      return;
    }
    render("birthday", (host) => {
      const value = result.value;
      if (!value.birthday) return false;
      const state = value.eligibility?.state;
      if (state !== "eligible") return false;
      set(host, "birthday-state", runtime.copy.birthdayEligibility(state));
      return true;
    });
  }

  /** Requirement 4.9 — ONE insight from the customer's own profile, plus the strip. */
  async function loadFragrance(): Promise<void> {
    const result = await runtime.cache.read<ProfileResponse>({ method: "GET", path: "/profile" });
    if (!result.ok) {
      drop("fragrance");
      return;
    }
    const insight = result.value.inferred?.insight ?? null;
    const ids = (result.value.recentlyViewed ?? [])
      .map((entry) => entry.productId)
      .filter((id): id is string => typeof id === "string" && id !== "")
      .slice(0, RECENT_PREVIEW);

    // Neither an insight nor a view history means there is nothing to say.
    if (!insight && ids.length === 0) {
      drop("fragrance");
      return;
    }

    let sentence = "";
    if (insight && typeof insight.kind === "string") {
      sentence = runtime.copy.insight(insight.kind, insight.value ? titleCase(insight.value) : null);
    }

    const host = tile("fragrance");
    if (!host) return;
    if (sentence) set(host, "insight", sentence);
    else host.querySelector("[data-slot='insight']")?.remove();

    if (ids.length === 0) {
      // The insight alone is a valid tile; the empty strip is removed, not left.
      host.querySelector("[data-portal-recent-list]")?.remove();
      return;
    }
    await paintRecent(host, ids);
    // An insight-less tile whose strip could not be enriched has nothing left.
    if (!sentence && host.querySelector("[data-portal-recent-list]")?.childElementCount === 0) {
      drop("fragrance");
    }
  }

  async function paintRecent(host: HTMLElement, ids: readonly string[]): Promise<void> {
    const list = host.querySelector<HTMLElement>("[data-portal-recent-list]");
    const rowTemplate = template("overview-recent");
    if (!list || !rowTemplate) return;
    const enriched = await runtime.cache.read<PortalCatalogResponse>({
      method: "GET",
      path: "/catalog/products",
      query: { ids: ids.join(",") },
      target: "shopify",
    });
    if (!enriched.ok) {
      list.remove();
      return;
    }
    const byId = new Map<string, PortalCatalogProduct>();
    for (const product of enriched.value.products ?? []) byId.set(String(product.productId), product);
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((product): product is PortalCatalogProduct => product !== undefined);
    if (ordered.length === 0) {
      list.remove();
      return;
    }
    const { fragment } = runtime.rows.list(ordered, rowTemplate, (product, tpl) => {
      const row = tpl.content.cloneNode(true) as DocumentFragment;
      const link = row.querySelector<HTMLAnchorElement>("[data-slot='link']");
      if (link) {
        if (typeof product.handle === "string" && product.handle !== "") {
          link.href = `/products/${encodeURIComponent(product.handle)}`;
        } else {
          link.removeAttribute("href");
        }
      }
      const title = row.querySelector<HTMLElement>("[data-slot='title']");
      if (title) title.textContent = product.title;
      const image = row.querySelector<HTMLImageElement>("[data-slot='image']");
      if (image && product.imageUrl) image.src = product.imageUrl;
      else image?.remove();
      return row;
    });
    list.appendChild(fragment);
  }

  /** A vocabulary identifier as words. The service sends ids; the client words them. */
  function titleCase(value: string): string {
    return value
      .split(/[_-]/)
      .map((word) => (word === "" ? word : word[0]?.toUpperCase() + word.slice(1)))
      .join(" ");
  }

  /* ---------------------------------------------------------------------- *
   * Deferral.
   * ---------------------------------------------------------------------- */

  /**
   * Fetch a deferred tile when it approaches the viewport.
   *
   * `IntersectionObserver` is absent in some older webviews. The fallback is to load
   * immediately rather than never: a tile that silently never appears is worse than
   * one extra request on a browser that is already unusual.
   */
  function defer(name: string, load: () => Promise<void>): void {
    const host = tile(name);
    if (!host) return;
    if (typeof IntersectionObserver !== "function") {
      void load();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // Disconnect FIRST, so a scroll that re-triggers before the fetch settles
          // cannot start a second one.
          observer.disconnect();
          void load();
          return;
        }
      },
      // Started a little before it is visible, so the tile is usually filled by the
      // time the customer reaches it.
      { rootMargin: "200px 0px" },
    );
    observer.observe(host);
  }

  /* ---------------------------------------------------------------------- *
   * Load.
   * ---------------------------------------------------------------------- */

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    // §21.5 — exactly three parallel reads on boot.
    const [balance, orders, wishlist] = await Promise.all([
      runtime.cache.read<BalanceSummary>({ method: "GET", path: "/balance" }),
      runtime.cache.read<OrdersResponse>({ method: "GET", path: "/orders", query: { pageSize: 1 } }),
      runtime.cache.read<WishlistSet>({ method: "GET", path: "/profile/wishlist" }),
    ]);

    // The section degrades only when there is NO summary left to show. One failed
    // source drops its own tiles and the rest of the page stands (Requirement 15.2).
    if (!balance.ok && !orders.ok && !wishlist.ok) {
      runtime.states.degrade(root, balance.error, () => void load());
      return;
    }

    if (balance.ok) {
      render("loyalty", (host) => paintLoyalty(host, balance.value));
      render("reward", (host) => paintReward(host, balance.value.availableRewards ?? []));
    } else {
      drop("loyalty");
      drop("reward");
    }

    if (orders.ok) render("order", (host) => paintOrder(host, orders.value.orders ?? []));
    else drop("order");

    // `ready` BEFORE the wishlist enrichment: the state reflects the summary the
    // customer can already see, and the shared layer reveals the body at that point.
    runtime.states.set(root, "ready");

    if (wishlist.ok) {
      try {
        await paintWishlist([...(wishlist.value.wishlist ?? [])].map(String));
      } catch {
        drop("wishlist");
      }
    } else {
      drop("wishlist");
    }

    defer("referral", loadReferral);
    defer("birthday", loadBirthday);
    defer("fragrance", loadFragrance);
  }

  void load();
});
