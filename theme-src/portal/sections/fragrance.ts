/**
 * `athoor-portal-fragrance.js` — the Fragrance Profile section (tasks 24.1, 24.2).
 *
 * Requirements 12.1, 12.2, 12.3, 12.6, 12.7, 12.8, 14.1, 16.3, 17.8.
 *
 * ── DECLARED AND DERIVED ARE DIFFERENT KINDS OF FACT (§12.1) ────────────────
 * A declared preference is a statement the customer made and can correct. A derived
 * signal is our reading of their behaviour and may simply be wrong — a gift bought
 * for someone else looks exactly like a purchase for oneself. So they are never
 * interleaved: two `<section>` elements, each naming its provenance in its
 * accessible name, and every item carrying `data-provenance` so the separation is
 * asserted mechanically rather than reviewed by eye (§12.5, task 24.3).
 *
 * The derived block carries NO edit control. Editing an inference is meaningless:
 * the customer would be correcting our arithmetic rather than stating a preference.
 * The promotion control is the honest alternative — it writes the value into the
 * declared store, where it becomes their statement and is thereafter stable.
 *
 * ── PROMOTION IS AN ORDINARY N13 WRITE, AND THAT MATTERS ────────────────────
 * There is no promotion endpoint, because there does not need to be one: promoting
 * is exactly "declare this value". Two consequences the service's own rules force,
 * both of which are easy to get wrong:
 *
 *   1. A dimension write REPLACES that dimension's set. Promoting one family means
 *      sending the existing declared set PLUS the new value. Sending the value alone
 *      would silently delete every other preference in that dimension.
 *   2. The value must be in the server's vocabulary or the write is rejected with
 *      `unknown_value`. Derived values come from the product taxonomy, which nothing
 *      constrains to the preference vocabulary, so the control is offered only for a
 *      value the vocabulary contains. A control that would be rejected is worse than
 *      no control.
 *
 * ── AN EMPTY DERIVED BLOCK IS NOT AN ERROR, AND NOT SHOWN ───────────────────
 * The product taxonomy is unpopulated by default, so `inferred.scent_family` and
 * `inferred.note` legitimately arrive empty — a truthful "we can conclude nothing".
 * §12.6 says the derived block is then absent ENTIRELY rather than shown empty, so
 * this module reveals it only when it has something to say. Likewise `season` is
 * withheld below three orders and `occasion` is always `null` today; both are
 * omitted SILENTLY, with no "not enough data" apology.
 *
 * ── ONE READ PER SOURCE, AND THE WRITE IS THE READ-BACK ─────────────────────
 * N12 supplies the vocabulary, the declared values and the caps. `GET /v1/profile`
 * supplies the derived block and the view history. N13 returns the same shape as
 * N12, so a write is followed by NO second request (task 24.2) — the response IS
 * the stored state, which is also the only way to be sure the screen shows what was
 * persisted rather than what was submitted.
 *
 * SAFETY: three reads and one scoped write, all through the existing App Proxy
 * transport. No storage of any kind. Every value written with `textContent`.
 */
import { registerSection } from "./registration.js";
import type { PortalCatalogProduct, PortalCatalogResponse } from "../data/types.js";

/** §12.2's five dimensions, in the order the server declares them. */
const DIMENSIONS = ["scent_family", "note", "intensity", "occasion", "season"] as const;
type Dimension = (typeof DIMENSIONS)[number];

/** The one single-valued dimension. Cardinality of one, not a cap. */
const SINGLE_VALUED: Dimension = "intensity";

/** Customer-facing dimension names. Identifiers never reach the screen (§18.9). */
const DIMENSION_LABEL: Readonly<Record<Dimension, string>> = {
  scent_family: "Scent families",
  note: "Favourite notes",
  intensity: "Preferred strength",
  occasion: "Occasions",
  season: "Seasons",
};

/** Per-dimension invitations. Requirement 12.7 — never an error, never hidden. */
const DIMENSION_PROMPT: Readonly<Record<Dimension, string>> = {
  scent_family: "Which families do you reach for?",
  note: "Any notes you particularly love?",
  intensity: "How strong do you wear it?",
  occasion: "When do you wear fragrance?",
  season: "Any seasons you favour?",
};

/** The vocabulary values as sentences. A value the map lacks is title-cased. */
const VALUE_LABEL: Readonly<Record<string, string>> = {
  orange_blossom: "Orange blossom",
};

/** How many recently-viewed products the strip shows. */
const RECENT_LIMIT = 8;

interface PreferencesResponse {
  readonly vocabulary?: Partial<Record<Dimension, readonly string[]>>;
  readonly declared?: Partial<Record<Dimension, readonly string[] | string | null>>;
  readonly limits?: Partial<Record<string, number>>;
}

interface InferredRanking {
  readonly value?: string;
  readonly distinctProducts?: number;
}

interface InferredSignal {
  readonly basis?: readonly string[];
  readonly scent_family?: readonly InferredRanking[];
  readonly note?: readonly InferredRanking[];
  readonly season?: InferredRanking | null;
  readonly occasion?: InferredRanking | null;
  readonly insight?: { kind?: string; value?: string; distinctProducts?: number } | null;
}

interface ProfileResponse {
  readonly inferred?: InferredSignal;
  readonly recentlyViewed?: readonly { productId?: string; viewedAt?: string }[];
}

registerSection("fragrance", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const declaredBlock = root.querySelector<HTMLElement>("[data-portal-declared]");
  const derivedBlock = root.querySelector<HTMLElement>("[data-portal-derived]");
  const recentBlock = root.querySelector<HTMLElement>("[data-portal-recent]");
  const dimensionsHost = root.querySelector<HTMLElement>("[data-portal-dimensions]");
  const derivedHost = root.querySelector<HTMLElement>("[data-portal-derived-groups]");
  const recentList = root.querySelector<HTMLElement>("[data-portal-recent-list]");
  const basisNode = root.querySelector<HTMLElement>("[data-portal-basis]");
  const insightNode = root.querySelector<HTMLElement>("[data-portal-insight]");

  const template = (name: string): HTMLTemplateElement | null =>
    root.querySelector<HTMLTemplateElement>(`[data-portal-row="${name}"]`);

  /** The stored state, as the server last reported it. Never a local guess. */
  let vocabulary: Partial<Record<Dimension, readonly string[]>> = {};
  let declared: Record<Dimension, string[]> = {
    scent_family: [],
    note: [],
    intensity: [],
    occasion: [],
    season: [],
  };
  let limits: Record<string, number> = {};
  let inferred: InferredSignal | null = null;

  /** One in-flight write per dimension, so a double tap cannot race itself. */
  const inFlight = new Map<Dimension, Promise<void>>();

  function label(value: string): string {
    const mapped = Object.prototype.hasOwnProperty.call(VALUE_LABEL, value)
      ? VALUE_LABEL[value]
      : undefined;
    if (typeof mapped === "string") return mapped;
    // Title-case the identifier's own words. The vocabulary is lower-case single
    // words, so this reads correctly without a table entry per value — and a value
    // added to the server's vocabulary next year renders properly with no theme
    // change, which is the same principle the referral figures follow.
    return value
      .split(/[_-]/)
      .map((word) => (word === "" ? word : word[0]?.toUpperCase() + word.slice(1)))
      .join(" ");
  }

  /** Normalise the declared block, whatever cardinality the dimension has. */
  function readDeclared(payload: PreferencesResponse): Record<Dimension, string[]> {
    const next: Record<Dimension, string[]> = {
      scent_family: [],
      note: [],
      intensity: [],
      occasion: [],
      season: [],
    };
    const source = payload.declared ?? {};
    for (const dimension of DIMENSIONS) {
      const value = Object.prototype.hasOwnProperty.call(source, dimension)
        ? source[dimension]
        : undefined;
      if (typeof value === "string" && value !== "") next[dimension] = [value];
      else if (Array.isArray(value)) next[dimension] = value.filter((v): v is string => typeof v === "string");
    }
    return next;
  }

  /** Keep only real numbers: an absent cap must not become `undefined` in the map. */
  function numericLimits(source: Partial<Record<string, number>> | undefined): Record<string, number> {
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(source ?? {})) {
      if (typeof value === "number") next[key] = value;
    }
    return next;
  }

  /* ---------------------------------------------------------------------- *
   * The declared block.
   * ---------------------------------------------------------------------- */

  function paintDeclared(): void {
    if (!dimensionsHost) return;
    const dimensionTemplate = template("dimension");
    const pillTemplate = template("pill");
    if (!dimensionTemplate || !pillTemplate) return;

    dimensionsHost.textContent = "";
    let rendered = 0;

    for (const dimension of DIMENSIONS) {
      const options = vocabulary[dimension] ?? [];
      // A dimension the server offers no vocabulary for cannot be selected from, so
      // it is omitted rather than rendered as an empty box. That is not the same as
      // Requirement 12.7's empty state, which is a dimension WITH options and no
      // selection — that one renders, with its invitation.
      if (options.length === 0) continue;

      const fragment = dimensionTemplate.content.cloneNode(true) as DocumentFragment;
      const legend = fragment.querySelector<HTMLElement>("[data-slot='legend']");
      if (legend) legend.textContent = DIMENSION_LABEL[dimension];
      const prompt = fragment.querySelector<HTMLElement>("[data-slot='prompt']");
      if (prompt) prompt.textContent = DIMENSION_PROMPT[dimension];

      const pills = fragment.querySelector<HTMLElement>("[data-slot='pills']");
      if (pills) {
        pills.setAttribute("aria-label", DIMENSION_LABEL[dimension]);
        const chosen = declared[dimension];
        for (const value of options) {
          const pillFragment = pillTemplate.content.cloneNode(true) as DocumentFragment;
          const control = pillFragment.querySelector<HTMLButtonElement>("[data-portal-pill]");
          if (!control) continue;
          control.dataset.dimension = dimension;
          control.dataset.value = value;
          const on = chosen.includes(value);
          control.setAttribute("aria-pressed", on ? "true" : "false");
          const text = pillFragment.querySelector<HTMLElement>("[data-slot='label']");
          if (text) text.textContent = label(value);
          pills.appendChild(pillFragment);
        }
      }
      dimensionsHost.appendChild(fragment);
      rendered += 1;
    }

    if (declaredBlock) {
      if (rendered > 0) declaredBlock.removeAttribute("hidden");
      else declaredBlock.setAttribute("hidden", "hidden");
    }
  }

  /* ---------------------------------------------------------------------- *
   * The derived block.
   * ---------------------------------------------------------------------- */

  /** Is this derived value promotable — in the vocabulary, and not already declared? */
  function promotable(dimension: Dimension, value: string): boolean {
    const options = vocabulary[dimension] ?? [];
    if (!options.includes(value)) return false;
    return !declared[dimension].includes(value);
  }

  function paintDerived(): void {
    if (!derivedHost || !derivedBlock) return;
    const groupTemplate = template("derived-group");
    const rowTemplate = template("derived");
    if (!groupTemplate || !rowTemplate) return;

    derivedHost.textContent = "";

    // `occasion` is always `null` today and `season` is withheld below three orders.
    // Both are omitted SILENTLY (§12.6) — a "not enough data" apology would tell the
    // customer about our thresholds rather than about their fragrances.
    const groups: { dimension: Dimension; rankings: readonly InferredRanking[] }[] = [
      { dimension: "scent_family", rankings: inferred?.scent_family ?? [] },
      { dimension: "note", rankings: inferred?.note ?? [] },
      { dimension: "season", rankings: inferred?.season ? [inferred.season] : [] },
      { dimension: "occasion", rankings: inferred?.occasion ? [inferred.occasion] : [] },
    ];

    let total = 0;
    for (const group of groups) {
      const rankings = group.rankings.filter((r) => typeof r.value === "string" && r.value !== "");
      if (rankings.length === 0) continue;

      const groupFragment = groupTemplate.content.cloneNode(true) as DocumentFragment;
      const legend = groupFragment.querySelector<HTMLElement>("[data-slot='legend']");
      if (legend) legend.textContent = DIMENSION_LABEL[group.dimension];
      const host = groupFragment.querySelector<HTMLElement>("[data-slot='list']");

      if (host) {
        const { fragment, failed } = runtime.rows.list(rankings, rowTemplate, (ranking, tpl) => {
          const row = tpl.content.cloneNode(true) as DocumentFragment;
          const value = ranking.value ?? "";
          const valueNode = row.querySelector<HTMLElement>("[data-slot='value']");
          if (valueNode) valueNode.textContent = label(value);

          // The EVIDENCE, not a confidence score: a count of distinct products the
          // customer can check against their own history. §12.7 excludes a match
          // percentage deliberately — it would imply a precision we do not have.
          const evidence = row.querySelector<HTMLElement>("[data-slot='evidence']");
          const count = ranking.distinctProducts;
          if (evidence) {
            evidence.textContent =
              typeof count === "number" && count > 0
                ? `${String(count)} ${count === 1 ? "fragrance" : "fragrances"}`
                : "";
          }

          const promote = row.querySelector<HTMLButtonElement>("[data-portal-promote]");
          if (promote) {
            if (promotable(group.dimension, value)) {
              promote.dataset.dimension = group.dimension;
              promote.dataset.value = value;
              promote.textContent = `Add ${label(value)} to your preferences`;
            } else {
              // Already declared, or outside the server's vocabulary — the write
              // would be rejected, so the control is removed rather than offered.
              promote.remove();
            }
          }
          return row;
        });
        host.appendChild(fragment);
        total += rankings.length - failed;
      }
      derivedHost.appendChild(groupFragment);
    }

    // Requirement 12.8 / §12.6 — the basis line names the inputs.
    const basis = (inferred?.basis ?? []).filter((b): b is string => typeof b === "string");
    if (basisNode) {
      basisNode.textContent =
        basis.length > 0
          ? `Read from your ${basis.map(basisLabel).join(", ")}.`
          : "Read from your own activity.";
    }

    const insight = inferred?.insight;
    if (insightNode) {
      const sentence =
        insight && typeof insight.kind === "string"
          ? runtime.copy.insight(insight.kind, insight.value ? label(insight.value) : null)
          : "";
      if (sentence) {
        insightNode.textContent = sentence;
        insightNode.removeAttribute("hidden");
      } else {
        insightNode.setAttribute("hidden", "hidden");
      }
    }

    // Absent ENTIRELY rather than shown empty (§12.6).
    if (total > 0) derivedBlock.removeAttribute("hidden");
    else derivedBlock.setAttribute("hidden", "hidden");
  }

  /** The four `InferredBasis` identifiers, as words (§18.9 — never the identifier). */
  function basisLabel(identifier: string): string {
    if (identifier === "orders") return "orders";
    if (identifier === "wishlist") return "saved items";
    if (identifier === "recently_viewed") return "recent views";
    if (identifier === "favourites") return "favourites";
    // An identifier this asset has never seen renders neutrally rather than raw.
    return "account activity";
  }

  /* ---------------------------------------------------------------------- *
   * Recently viewed.
   * ---------------------------------------------------------------------- */

  /**
   * The strip.
   *
   * `GET /v1/profile` returns product ids and timestamps only, so the titles and
   * images come from the catalogue. If that enrichment fails the strip is OMITTED
   * rather than rendered as a row of bare ids — a list of numbers is not a fragrance.
   */
  async function paintRecent(ids: readonly string[]): Promise<void> {
    if (!recentBlock || !recentList || ids.length === 0) return;
    const rowTemplate = template("recent");
    if (!rowTemplate) return;

    const result = await runtime.cache.read<PortalCatalogResponse>({
      method: "GET",
      path: "/catalog/products",
      query: { ids: ids.join(",") },
      target: "shopify",
    });
    if (!result.ok) return;

    const byId = new Map<string, PortalCatalogProduct>();
    for (const product of result.value.products ?? []) byId.set(String(product.productId), product);

    const ordered = ids.map((id) => byId.get(id)).filter((p): p is PortalCatalogProduct => p !== undefined);
    if (ordered.length === 0) return;

    const { fragment } = runtime.rows.list(ordered, rowTemplate, (product, tpl) => {
      const row = tpl.content.cloneNode(true) as DocumentFragment;
      const link = row.querySelector<HTMLAnchorElement>("[data-slot='link']");
      // `handle` is nullable in the catalogue DTO. A product without one has no
      // storefront URL, so the anchor becomes plain text rather than a link to
      // `/products/null` — a 404 dressed up as a product.
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
      if (image && product.imageUrl) {
        image.src = product.imageUrl;
        if (product.imageWidth) image.width = product.imageWidth;
        if (product.imageHeight) image.height = product.imageHeight;
      } else if (image) {
        image.remove();
      }
      return row;
    });
    recentList.textContent = "";
    recentList.appendChild(fragment);
    recentBlock.removeAttribute("hidden");
  }

  /* ---------------------------------------------------------------------- *
   * Writing.
   * ---------------------------------------------------------------------- */

  /**
   * Write one dimension's full set.
   *
   * A dimension write REPLACES that dimension's set, so the caller passes the whole
   * intended set and never a delta. The response is the stored state, so it is
   * painted directly with no follow-up read (task 24.2) — which is also the only way
   * to show what was persisted rather than what was submitted.
   */
  function write(dimension: Dimension, next: readonly string[], control: HTMLElement): Promise<void> {
    const existing = inFlight.get(dimension);
    if (existing) return existing;

    const cap = limits[dimension];
    if (typeof cap === "number" && next.length > cap) {
      runtime.announce.assertive(
        root,
        `You can choose up to ${String(cap)} ${DIMENSION_LABEL[dimension].toLowerCase()}.`,
      );
      return Promise.resolve();
    }

    control.setAttribute("aria-busy", "true");

    // Typed explicitly: `intensity` is a nullable STRING and every other dimension
    // is an array, so a computed-key literal would collapse both into one value type
    // and lose the distinction the service enforces.
    const declaredPatch: Record<string, string | null | string[]> =
      dimension === SINGLE_VALUED ? { [dimension]: next[0] ?? null } : { [dimension]: [...next] };
    const body = { declared: declaredPatch };

    const flight = (async (): Promise<void> => {
      const result = await runtime.request<PreferencesResponse>({
        method: "PUT",
        path: "/profile/preferences",
        body,
      });
      control.removeAttribute("aria-busy");

      if (!result.ok) {
        runtime.announce.assertive(root, runtime.copy.error(result.error.code));
        // The screen still shows the last state the SERVER confirmed, so there is
        // nothing to roll back — the pills were never optimistically flipped.
        return;
      }

      // The response IS the stored state.
      vocabulary = result.value.vocabulary ?? vocabulary;
      declared = readDeclared(result.value);
      limits = { ...limits, ...numericLimits(result.value.limits) };
      paintDeclared();
      // A promotion changes which derived values are still promotable.
      paintDerived();
      runtime.announce.polite(root, "Saved.");
    })();

    inFlight.set(dimension, flight);
    void flight.finally(() => {
      inFlight.delete(dimension);
    });
    return flight;
  }

  function toggle(control: HTMLButtonElement): void {
    const dimension = control.dataset.dimension as Dimension | undefined;
    const value = control.dataset.value;
    if (!dimension || !value || !DIMENSIONS.includes(dimension)) return;

    const current = declared[dimension];
    if (dimension === SINGLE_VALUED) {
      // Cardinality of one: choosing replaces, choosing the chosen one clears.
      void write(dimension, current.includes(value) ? [] : [value], control);
      return;
    }
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    void write(dimension, next, control);
  }

  function promote(control: HTMLButtonElement): void {
    const dimension = control.dataset.dimension as Dimension | undefined;
    const value = control.dataset.value;
    if (!dimension || !value || !DIMENSIONS.includes(dimension)) return;
    if (!promotable(dimension, value)) return;
    // The EXISTING set plus the new value. Sending the value alone would delete
    // every other preference in this dimension.
    const next =
      dimension === SINGLE_VALUED ? [value] : [...declared[dimension], value];
    void write(dimension, next, control);
  }

  /* ---------------------------------------------------------------------- *
   * Load.
   * ---------------------------------------------------------------------- */

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    const preferences = await runtime.cache.read<PreferencesResponse>({
      method: "GET",
      path: "/profile/preferences",
    });
    if (!preferences.ok) {
      // Fatal: without the vocabulary there is nothing to offer the customer.
      runtime.states.degrade(root, preferences.error, () => void load());
      return;
    }
    vocabulary = preferences.value.vocabulary ?? {};
    declared = readDeclared(preferences.value);
    limits = numericLimits(preferences.value.limits);

    // The derived block is a SEPARATE read, and its failure is not fatal: a customer
    // can still state their taste when we cannot compute ours.
    const profile = await runtime.cache.read<ProfileResponse>({ method: "GET", path: "/profile" });
    inferred = profile.ok ? (profile.value.inferred ?? null) : null;

    paintDeclared();
    paintDerived();

    const anyDeclared = DIMENSIONS.some((d) => declared[d].length > 0);
    const derivedShown = derivedBlock?.hasAttribute("hidden") === false;
    const recentIds = profile.ok
      ? (profile.value.recentlyViewed ?? [])
          .map((entry) => entry.productId)
          .filter((id): id is string => typeof id === "string" && id !== "")
          .slice(0, RECENT_LIMIT)
      : [];

    // Requirement 12.6 — nothing declared, nothing derived and no history at all.
    if (!anyDeclared && !derivedShown && recentIds.length === 0) {
      runtime.states.set(root, "empty", {
        announce: "Tell us your taste in three answers: families, strength and occasions.",
      });
      // The declared block stays visible in the empty state: its pills ARE the
      // invitation, and hiding them would leave an empty state with no way to act.
      if (declaredBlock && (vocabulary.scent_family ?? []).length > 0) {
        declaredBlock.removeAttribute("hidden");
      }
      return;
    }

    runtime.states.set(root, "ready");
    void paintRecent(recentIds);
  }

  // Bound on this section's own root, never on `document` (§16.10).
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const promoteControl = target.closest<HTMLButtonElement>("[data-portal-promote]");
    if (promoteControl) {
      promote(promoteControl);
      return;
    }
    const pill = target.closest<HTMLButtonElement>("[data-portal-pill]");
    if (pill) toggle(pill);
  });

  void load();
});
