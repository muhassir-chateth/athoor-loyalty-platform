/**
 * Channel reachability — is an app-exclusive entitlement grantable to anyone?
 * (task 42) — Req 19.3, 19.4, 19.7, 11.5, A19.
 *
 * ── THE DECISION THIS MODULE ENFORCES ────────────────────────────────────────
 * `channel: "app"` requires a Customer Account API bearer token, and
 * `index.ts` deliberately wires NO token verifier: `UnconfiguredTokenVerifier`
 * fails every token closed. That is the right posture today — Req 19 is
 * explicitly future-scoped for delivered app features, no native app exists, and
 * Req 11.5 forbids building custom authentication, so refusing tokens is more
 * honest than inventing a check. The consequence is that **every production
 * request is `web`** and the `app` channel is unreachable.
 *
 * ── THE TRAP THAT FOLLOWS, AND WHY IT NEEDS A MACHINE CHECK ──────────────────
 * Task 30 made benefits configurable: flipping `benefits.config.appExclusive` to
 * `true` is a data edit, no deploy. But while the `app` channel is unreachable, an
 * app-exclusive item is grantable to **nobody** — it silently disappears from
 * every member's entitlements, with no error, no log and no failed request. The
 * gate is behaving exactly as specified (Property 15); the configuration is what
 * became nonsense.
 *
 * That is the same shape as the task 32 market-config hazard: a configuration
 * change whose real effect is invisible. So the deviation is machine-checked
 * rather than only written down — this module reports, read-only, any configured
 * app-exclusive item alongside whether the `app` channel can currently be reached
 * at all, and `/health` publishes it.
 *
 * Informational, never fatal: nothing here changes a grant decision, and a
 * reachability finding must never fail a request or a liveness probe.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────
 * This does NOT wire a verifier, does not relax the gate, and does not alter any
 * entitlement outcome. It answers one question honestly.
 */
import type { Channel } from "./channel.js";
import type { Queryable } from "../ledger/repository.js";
import { REWARD_CATALOG } from "../rewards/catalog.js";

/** Channels a request can currently be attributed to in this deployment. */
export interface ChannelReachability {
  /** Always reachable: Shopify App Proxy signs storefront requests. */
  web: true;
  /**
   * Reachable only when a Customer Account API token verifier is wired. `false`
   * with no verifier, because `UnconfiguredTokenVerifier` refuses every token.
   */
  app: boolean;
}

/** An item that can never be granted while its required channel is unreachable. */
export interface UngrantableItem {
  /** `benefit` or `reward`. */
  kind: "benefit" | "reward";
  /** The benefit key or reward id. */
  id: string;
  /** The channel the item requires but which cannot be reached. */
  requiresChannel: Channel;
}

/** What `/health` publishes about channel attribution (Req 19.3, A19). */
export interface ChannelReachabilityReport {
  /** The channel every production request is attributed to today. */
  attributed: Channel;
  reachable: ChannelReachability;
  /**
   * Configured items that require an unreachable channel and are therefore
   * grantable to NOBODY. Empty is the expected state; non-empty means a
   * configuration edit has quietly removed an entitlement from every member.
   */
  ungrantable: UngrantableItem[];
}

/** Active benefits flagged app-exclusive; read-only. */
const SELECT_APP_EXCLUSIVE_BENEFITS_SQL = `
  SELECT key
  FROM benefits
  WHERE active = true
    AND COALESCE((config->>'appExclusive')::boolean, false) = true
  ORDER BY key
`;

/** Read-only view of channel reachability, surfaced on `/health`. */
export interface ChannelReachabilitySource {
  report(): Promise<ChannelReachabilityReport>;
}

/**
 * Pure evaluation: given which channels are reachable and which items are
 * app-exclusive, which items can be granted to nobody?
 *
 * Rewards come from the in-code catalog (the MVP source of truth per A18);
 * benefits are supplied by the caller because they live in configuration.
 */
export function evaluateChannelReachability(
  reachable: ChannelReachability,
  appExclusiveBenefitKeys: readonly string[],
): ChannelReachabilityReport {
  const ungrantable: UngrantableItem[] = [];

  if (!reachable.app) {
    for (const key of appExclusiveBenefitKeys) {
      ungrantable.push({ kind: "benefit", id: key, requiresChannel: "app" });
    }
    for (const reward of REWARD_CATALOG) {
      // `appExclusive` is optional on a Reward and unused by the current
      // catalog; checked anyway so flagging one later cannot slip past.
      if ((reward as { appExclusive?: boolean }).appExclusive === true) {
        ungrantable.push({ kind: "reward", id: reward.id, requiresChannel: "app" });
      }
    }
  }

  return {
    // Every production request resolves to `web` while no verifier is wired.
    attributed: reachable.app ? "app" : "web",
    reachable,
    ungrantable,
  };
}

/**
 * Reads the app-exclusive benefit configuration and reports reachability.
 *
 * `appChannelReachable` is supplied by the boot wiring — it is `true` only when a
 * real Customer Account API token verifier has been wired, so this cannot drift
 * from the actual auth posture by guessing.
 *
 * A read failure yields `ungrantable: []` with the error attached rather than
 * throwing: the caller is a liveness probe.
 */
export class DbChannelReachabilitySource implements ChannelReachabilitySource {
  constructor(
    private readonly db: Queryable,
    private readonly appChannelReachable: boolean,
  ) {}

  async report(): Promise<ChannelReachabilityReport> {
    const reachable: ChannelReachability = { web: true, app: this.appChannelReachable };
    let keys: string[] = [];
    try {
      const result = await this.db.query<{ key: string }>(SELECT_APP_EXCLUSIVE_BENEFITS_SQL);
      keys = result.rows.map((row) => row.key);
    } catch {
      // Cannot read the benefit configuration; report reachability without the
      // configured-item list rather than failing the probe.
      return { attributed: reachable.app ? "app" : "web", reachable, ungrantable: [] };
    }
    return evaluateChannelReachability(reachable, keys);
  }
}
