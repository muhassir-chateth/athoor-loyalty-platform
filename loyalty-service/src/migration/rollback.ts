/**
 * Migration rollback — restore metafields from the M0 export + M3 theme CTA
 * revert (task 7.3).
 *
 * This is design.md "Migration Plan → Rollback at any phase" and Requirement 14
 * criterion 14.9. It is the SAFETY NET for the phased migration: if any phase
 * (M0–M3) must be undone, this module restores the store to its pre-migration
 * shape using the versioned M0 backup produced by task 7.1 (`m0Export.ts`) as
 * the authoritative rollback anchor.
 *
 * Two independent rollback mechanisms, matching the two things migration
 * touched:
 *
 *   1. METAFIELD RESTORE (M0–M2, {@link runMetafieldRollback}) — after STOPPING
 *      the service, restore every customer's `loyalty.*` metafields to the exact
 *      values captured in the M0 backup, so each customer's metafields equal
 *      their exported values (Req 14.9). Restoration only ever SETS values back
 *      to their exported form; it NEVER deletes a metafield (Req 14.8 continues
 *      to hold through rollback). The restore then VERIFIES the observable
 *      post-restore condition by reading the metafields back and asserting they
 *      equal the exported values. It is idempotent: re-running restores to the
 *      same end state and re-verifies clean.
 *
 *   2. M3 THEME CTA REVERT ({@link buildThemeCtaRollbackArtifact} /
 *      {@link writeThemeCtaRollbackArtifact}) — for the cutover phase, re-point
 *      the theme's redemption call-to-action back to the prior `mailto:` snippet
 *      that was deliberately RETAINED in version control (task 6.7 kept the
 *      `mailto:` links in `theme/sections/loyalty-dashboard.liquid`). Because
 *      the snippet was never removed, the revert is a configuration flip:
 *      setting the redemption mode back to `mailto` makes the retained CTA the
 *      active one and disables the `/v1` redeem enhancement. This module cannot
 *      (and must not) push to the live theme; it GENERATES the documented
 *      artifact/steps for the gated, migration-time operator to apply.
 *
 * SAFETY — this tool is documented and tested but is NOT wired to run against
 * the live store or live theme here. Shopify is reached ONLY through the
 * injected {@link MetafieldRestoreClient}; the service is stopped ONLY through
 * the injected {@link ServiceController}; artifacts are written ONLY through the
 * injected {@link BackupWriter}. Tests inject fakes (an in-memory metafield
 * store, a fake controller, an in-memory writer), so verification calls NO live
 * Admin API and modifies NO live data or theme. Actual execution is a gated,
 * migration-time step performed by an operator, never automatically.
 */
import type {
  BackupWriter,
  ExportedCustomer,
  M0Backup,
  RawMetafield,
} from "./m0Export.js";

/* -------------------------------------------------------------------------- */
/* 1. Metafield restore (M0–M2)                                               */
/* -------------------------------------------------------------------------- */

/** The payload handed to the injected client to restore one customer's metafields. */
export interface MetafieldRestoreInput {
  /** Shopify customer GID whose metafields are restored, e.g. `gid://shopify/Customer/123`. */
  customerGid: string;
  /** Numeric Shopify customer id (informational; mirrors the export record). */
  customerId: string;
  /**
   * The `loyalty.*` metafields to restore, VERBATIM from the M0 backup. The
   * client MUST set each of these back to the given value (upsert by
   * namespace+key) and MUST NOT delete any metafield (Req 14.8).
   */
  metafields: RawMetafield[];
}

/**
 * The injectable boundary to the Shopify Admin API for rollback. It exposes a
 * RESTORE (set values back) method and a READ-BACK method used to verify the
 * post-restore condition — but deliberately NO delete method, so Req 14.8
 * ("never delete any metafield") holds by construction through rollback too.
 *
 * Production wires an implementation backed by the GraphQL Admin API (metafield
 * write scope); tests inject a fake backed by an in-memory metafield store so no
 * live Admin API is called and no live data is modified.
 */
export interface MetafieldRestoreClient {
  /**
   * Restores (sets) the given customer's metafields to the provided values.
   * Upserts by namespace+key; never deletes. Throws on failure so the caller
   * can record the customer as not-restored.
   */
  restoreCustomerMetafields(input: MetafieldRestoreInput): Promise<void>;
  /**
   * Reads back ALL `loyalty.*` metafields currently on the customer, so the
   * rollback can verify they equal the exported values (the observable
   * post-restore condition, Req 14.9).
   */
  readCustomerMetafields(customerGid: string): Promise<RawMetafield[]>;
}

/**
 * The injectable control for stopping (and inspecting) the Loyalty_Service.
 * Req 14.9 requires rollback to STOP the service before restoring metafields so
 * the ledger cannot race the restore by writing the cache. Production wires this
 * to the real process/orchestrator controls; tests inject a fake.
 */
export interface ServiceController {
  /** True while the service is still accepting/processing work. */
  isRunning(): Promise<boolean> | boolean;
  /** Stops the service; resolves once it has stopped. */
  stop(): Promise<void>;
}

/** One customer's restore outcome within a rollback run. */
export interface RestoredCustomer {
  id: string;
  gid: string;
  /** Number of metafields restored (set back) for this customer. */
  metafieldsRestored: number;
  /** True iff the read-back metafields equal the exported values (Req 14.9). */
  verified: boolean;
}

/** A post-restore verification mismatch: a metafield did not equal its exported value. */
export interface RestoreMismatch {
  id: string;
  gid: string;
  namespace: string;
  key: string;
  /** The exported value the metafield should have been restored to. */
  expected: string | null;
  /** The value actually read back after the restore. */
  actual: string | null;
}

/** The result of running the metafield rollback (a discriminated union). */
export type MetafieldRollbackResult =
  | {
      status: "rolled_back";
      /** True iff the service was confirmed stopped before restoring. */
      serviceStopped: boolean;
      /** Number of customers whose metafields were restored. */
      customersRestored: number;
      /** Total number of metafields set back across all customers. */
      metafieldsRestored: number;
      /** Per-customer detail. */
      details: RestoredCustomer[];
      /** Always empty on success — every customer verified equal to export. */
      mismatches: [];
    }
  | {
      status: "verification_failed";
      serviceStopped: boolean;
      customersRestored: number;
      metafieldsRestored: number;
      details: RestoredCustomer[];
      /** The metafields whose read-back value did not equal the exported value. */
      mismatches: RestoreMismatch[];
    }
  | {
      status: "aborted_service_running";
      /** Why the rollback refused to proceed. */
      reason: string;
    };

/** Options for {@link runMetafieldRollback}. */
export interface MetafieldRollbackOptions {
  /** The authoritative M0 backup (task 7.1) — the ONLY source of truth for restore. */
  backup: M0Backup;
  /** Restore/read boundary to Shopify (injected; fake in tests). */
  client: MetafieldRestoreClient;
  /**
   * Controls stopping the service before restore (Req 14.9). Optional: when
   * omitted the caller asserts the service is already stopped and the result
   * reports `serviceStopped: false` (the restore still runs). When provided,
   * the service is stopped first and, if it cannot be stopped, the rollback
   * aborts without touching any metafield.
   */
  service?: ServiceController;
}

/** Stable key for a metafield within the loyalty namespace. */
function metafieldKey(m: Pick<RawMetafield, "namespace" | "key">): string {
  return `${m.namespace}\u0000${m.key}`;
}

/**
 * Indexes a list of metafields by namespace+key. The M0 export never contains
 * duplicate (namespace,key) pairs per customer, so a later duplicate simply
 * wins (deterministic).
 */
function indexByKey(metafields: RawMetafield[]): Map<string, RawMetafield> {
  const map = new Map<string, RawMetafield>();
  for (const m of metafields) {
    map.set(metafieldKey(m), m);
  }
  return map;
}

/**
 * Verifies that every EXPORTED metafield is present in `actual` with an equal
 * value (and type). Returns the mismatches for one customer (empty when the
 * customer's metafields equal their exported values).
 *
 * Only the exported metafields are asserted: because migration M0–M2 only ever
 * WRITES values (it never adds or deletes `loyalty.*` keys), restoring the
 * exported values makes the customer's metafields exactly equal their exported
 * form. Any extra key the store might carry is left untouched (Req 14.8 — never
 * delete), so verification is scoped to the exported set.
 */
export function verifyRestored(
  exported: RawMetafield[],
  actual: RawMetafield[],
): Array<Pick<RestoreMismatch, "namespace" | "key" | "expected" | "actual">> {
  const actualByKey = indexByKey(actual);
  const mismatches: Array<Pick<RestoreMismatch, "namespace" | "key" | "expected" | "actual">> = [];
  for (const want of exported) {
    const got = actualByKey.get(metafieldKey(want));
    if (!got || got.value !== want.value || got.type !== want.type) {
      mismatches.push({
        namespace: want.namespace,
        key: want.key,
        expected: want.value,
        actual: got ? got.value : null,
      });
    }
  }
  return mismatches;
}

/**
 * Runs the M0–M2 metafield rollback (Req 14.9). Flow, in order:
 *
 *   1. STOP the service (if a controller is injected) so the ledger cannot race
 *      the restore. If the service will not stop, ABORT without touching any
 *      metafield.
 *   2. For each customer in the M0 backup, restore their `loyalty.*` metafields
 *      to the exact exported values via the injected client (SET only, never
 *      delete — Req 14.8).
 *   3. Read the metafields back and VERIFY they equal the exported values (the
 *      observable post-restore condition, Req 14.9). Any mismatch is collected.
 *
 * Returns `rolled_back` when every customer verifies equal to their export, or
 * `verification_failed` with the offending metafields otherwise (the values were
 * still restored — nothing was deleted). Idempotent: because the restore only
 * sets values back to the exported form, re-running reaches the same end state
 * and re-verifies clean.
 */
export async function runMetafieldRollback(
  options: MetafieldRollbackOptions,
): Promise<MetafieldRollbackResult> {
  // (1) Stop the service before restoring (Req 14.9).
  let serviceStopped = false;
  if (options.service) {
    await options.service.stop();
    const stillRunning = await options.service.isRunning();
    if (stillRunning) {
      return {
        status: "aborted_service_running",
        reason:
          "The Loyalty_Service could not be stopped; rollback aborted before touching any " +
          "metafield so the ledger cannot race the restore.",
      };
    }
    serviceStopped = true;
  }

  // (2) Restore each customer's metafields to their exported values, then
  // (3) verify by reading them back (Req 14.9). Never delete anything (Req 14.8).
  const details: RestoredCustomer[] = [];
  const mismatches: RestoreMismatch[] = [];
  let metafieldsRestored = 0;

  for (const customer of options.backup.customers) {
    // Copy defensively so the client cannot mutate the authoritative backup.
    const exported = customer.metafields.map((m) => ({ ...m }));

    await options.client.restoreCustomerMetafields({
      customerGid: customer.gid,
      customerId: customer.id,
      metafields: exported,
    });
    metafieldsRestored += exported.length;

    const actual = await options.client.readCustomerMetafields(customer.gid);
    const customerMismatches = verifyRestored(exported, actual);
    for (const mm of customerMismatches) {
      mismatches.push({ id: customer.id, gid: customer.gid, ...mm });
    }

    details.push({
      id: customer.id,
      gid: customer.gid,
      metafieldsRestored: exported.length,
      verified: customerMismatches.length === 0,
    });
  }

  if (mismatches.length > 0) {
    return {
      status: "verification_failed",
      serviceStopped,
      customersRestored: details.length,
      metafieldsRestored,
      details,
      mismatches,
    };
  }

  return {
    status: "rolled_back",
    serviceStopped,
    customersRestored: details.length,
    metafieldsRestored,
    details,
    mismatches: [],
  };
}

/* -------------------------------------------------------------------------- */
/* 2. M3 theme redemption-CTA revert (cutover phase)                          */
/* -------------------------------------------------------------------------- */

/**
 * Discriminator stamped on the generated M3 theme-rollback artifact so an
 * operator/tool recognises it.
 */
export const THEME_CTA_ROLLBACK_KIND = "m3-theme-cta-rollback" as const;

/**
 * The two redemption modes the theme dashboard supports. `automated` uses the
 * `/v1/redeem` App Proxy enhancement (the M3 cutover state); `mailto` uses the
 * retained `mailto:` links (the pre-cutover / rolled-back state).
 */
export type RedemptionMode = "automated" | "mailto";

/** The theme file that retains the `mailto:` redemption CTA in version control. */
export const RETAINED_MAILTO_SNIPPET_FILE =
  "theme/sections/loyalty-dashboard.liquid" as const;

/**
 * The config flag that selects the redemption mode. Setting it to `mailto` flips
 * the dashboard back to the retained `mailto:` CTA and disables the `/v1`
 * redeem enhancement — the M3 rollback. It lives in the `data-loyalty-config`
 * JSON block consumed by `assets/athoor-loyalty.js`.
 */
export const REDEMPTION_MODE_CONFIG_KEY = "redemptionMode" as const;

/**
 * A documented, machine-readable artifact describing how to re-point the theme
 * redemption CTA back to the retained `mailto:` snippet (Req 14.9, M3 rollback).
 * This is GENERATED, not applied — an operator applies it to the theme during a
 * gated cutover-rollback (this tool never pushes to the live theme).
 */
export interface ThemeCtaRollbackArtifact {
  kind: typeof THEME_CTA_ROLLBACK_KIND;
  /** ISO 8601 instant the artifact was generated. */
  generatedAt: string;
  /** The mode to roll back TO. */
  redemptionMode: Extract<RedemptionMode, "mailto">;
  /** The config flip that performs the revert. */
  configFlag: {
    key: typeof REDEMPTION_MODE_CONFIG_KEY;
    value: Extract<RedemptionMode, "mailto">;
    location: string;
    description: string;
  };
  /** The retained snippet the CTA points back to (kept in version control). */
  retainedSnippet: {
    file: typeof RETAINED_MAILTO_SNIPPET_FILE;
    note: string;
  };
  /** Ordered, human-readable steps for the operator to apply the revert. */
  steps: string[];
}

/**
 * Builds the M3 theme-CTA rollback artifact (Req 14.9). Because task 6.7 kept
 * the `mailto:` CTA in `theme/sections/loyalty-dashboard.liquid`, the revert is
 * a configuration flip (`redemptionMode: "mailto"`) rather than a re-addition of
 * removed markup — no code needs to be un-deleted. The returned artifact
 * documents exactly what an operator changes; it performs NO live theme push.
 */
export function buildThemeCtaRollbackArtifact(
  now: () => Date = () => new Date(),
): ThemeCtaRollbackArtifact {
  return {
    kind: THEME_CTA_ROLLBACK_KIND,
    generatedAt: now().toISOString(),
    redemptionMode: "mailto",
    configFlag: {
      key: REDEMPTION_MODE_CONFIG_KEY,
      value: "mailto",
      location: `${RETAINED_MAILTO_SNIPPET_FILE} → <script data-loyalty-config> JSON block`,
      description:
        "Set redemptionMode to 'mailto' so assets/athoor-loyalty.js skips the /v1/redeem " +
        "cutover and leaves the retained mailto: reward-btn links as the active redemption CTA.",
    },
    retainedSnippet: {
      file: RETAINED_MAILTO_SNIPPET_FILE,
      note:
        "The mailto: reward-btn links were deliberately retained in version control (task 6.7). " +
        "No markup needs to be re-added; the CTA reverts by disabling the /v1 redeem enhancement.",
    },
    steps: [
      `Add "${REDEMPTION_MODE_CONFIG_KEY}": "mailto" to the data-loyalty-config JSON block in ${RETAINED_MAILTO_SNIPPET_FILE}.`,
      "Deploy the theme change through the normal version-control + theme-push workflow (not from this service).",
      "Confirm the reward-btn links resolve to the mailto: URLs and the /v1/redeem enhancement no longer activates.",
      "Retain the ledger data for a later cutover retry (M3 rollback keeps the ledger; only the storefront CTA reverts).",
    ],
  };
}

/** The filename the generated theme-rollback artifact is written under. */
export function themeCtaRollbackFilename(generatedAt: Date): string {
  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  return `${THEME_CTA_ROLLBACK_KIND}-${stamp}.json`;
}

/**
 * Generates and PERSISTS the M3 theme-CTA rollback artifact via the injected
 * {@link BackupWriter} (the same filesystem boundary M0 uses), returning where
 * it was written. This produces the documented artifact/steps only — it does
 * NOT push to the live theme (Req 14.9 revert is applied by an operator).
 */
export async function writeThemeCtaRollbackArtifact(
  writer: BackupWriter,
  now: () => Date = () => new Date(),
): Promise<{ artifact: ThemeCtaRollbackArtifact; location: string }> {
  const generatedAt = now();
  const artifact = buildThemeCtaRollbackArtifact(() => generatedAt);
  const location = await writer.write(
    themeCtaRollbackFilename(generatedAt),
    JSON.stringify(artifact, null, 2),
  );
  return { artifact, location };
}

/** Re-export for convenience so callers can build restore fakes without deep imports. */
export type { ExportedCustomer, M0Backup, RawMetafield };
