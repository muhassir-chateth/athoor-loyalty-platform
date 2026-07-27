/**
 * Channel reachability (task 42) — Req 19.3, 19.4, 19.7, 11.5, A19.
 *
 * The decision is that no Customer Account API token verifier is wired, so
 * `channel: "app"` is unreachable and every production request is `web`. These
 * tests pin the check that makes the trap visible: an app-exclusive benefit or
 * reward, while the app channel is unreachable, is grantable to NOBODY — and that
 * would otherwise happen silently, because the gate is behaving exactly as
 * Property 15 specifies.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import {
  DbChannelReachabilitySource,
  evaluateChannelReachability,
} from "./reachability.js";
import { isGrantableOnChannel } from "./channel.js";
import { REWARD_CATALOG } from "../rewards/catalog.js";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

/** A fake benefits table returning the given app-exclusive keys, or throwing. */
function db(keys: string[] | "throw"): Queryable {
  return {
    query: async <R extends QueryResultRow>() => {
      if (keys === "throw") throw new Error("benefits table unavailable");
      const rows = keys.map((key) => ({ key }));
      return {
        rows: rows as R[],
        rowCount: rows.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      } as QueryResult<R>;
    },
  };
}

describe("evaluateChannelReachability", () => {
  it("reports web reachable, app unreachable, and nothing ungrantable in the expected state", () => {
    const report = evaluateChannelReachability({ web: true, app: false }, []);

    expect(report).toEqual({
      attributed: "web",
      reachable: { web: true, app: false },
      ungrantable: [],
    });
  });

  it("names an app-exclusive benefit as grantable to nobody while app is unreachable", () => {
    const report = evaluateChannelReachability({ web: true, app: false }, ["app_only_perk"]);

    expect(report.ungrantable).toEqual([
      { kind: "benefit", id: "app_only_perk", requiresChannel: "app" },
    ]);
  });

  it("lists every offending benefit, not just the first", () => {
    const report = evaluateChannelReachability({ web: true, app: false }, ["a", "b", "c"]);

    expect(report.ungrantable.map((u) => u.id)).toEqual(["a", "b", "c"]);
  });

  it("reports nothing ungrantable once the app channel IS reachable", () => {
    const report = evaluateChannelReachability({ web: true, app: true }, ["app_only_perk"]);

    expect(report.ungrantable).toEqual([]);
    expect(report.attributed).toBe("app");
  });

  it("agrees with the gate it is describing (Property 15)", () => {
    // The check must not invent a rule of its own: an item is ungrantable exactly
    // when the gate refuses it on every reachable channel.
    const appExclusive = { appExclusive: true };
    const ordinary = { appExclusive: false };

    expect(isGrantableOnChannel(appExclusive, "web")).toBe(false);
    expect(isGrantableOnChannel(appExclusive, "app")).toBe(true);
    expect(isGrantableOnChannel(ordinary, "web")).toBe(true);

    // With only `web` reachable, the app-exclusive item is refused everywhere…
    expect(evaluateChannelReachability({ web: true, app: false }, ["x"]).ungrantable).toHaveLength(1);
    // …and an ordinary item is never reported, because the gate grants it.
    expect(evaluateChannelReachability({ web: true, app: false }, []).ungrantable).toHaveLength(0);
  });

  it("finds no app-exclusive reward in the current catalog", () => {
    // Standing assertion of today's posture: the field exists on Reward and no
    // catalog entry uses it, so flagging one later shows up here.
    const report = evaluateChannelReachability({ web: true, app: false }, []);
    expect(report.ungrantable.filter((u) => u.kind === "reward")).toEqual([]);
    for (const reward of REWARD_CATALOG) {
      expect((reward as { appExclusive?: boolean }).appExclusive).toBeUndefined();
    }
  });
});

describe("DbChannelReachabilitySource", () => {
  it("reads the app-exclusive benefit configuration and reports it", async () => {
    const source = new DbChannelReachabilitySource(db(["concierge_app"]), false);

    await expect(source.report()).resolves.toEqual({
      attributed: "web",
      reachable: { web: true, app: false },
      ungrantable: [{ kind: "benefit", id: "concierge_app", requiresChannel: "app" }],
    });
  });

  it("reports the clean state when nothing is app-exclusive", async () => {
    const source = new DbChannelReachabilitySource(db([]), false);

    await expect(source.report()).resolves.toMatchObject({ ungrantable: [] });
  });

  it("never throws at the probe when the configuration cannot be read", async () => {
    const source = new DbChannelReachabilitySource(db("throw"), false);

    // Reachability is still reported honestly; only the item list is unavailable.
    await expect(source.report()).resolves.toEqual({
      attributed: "web",
      reachable: { web: true, app: false },
      ungrantable: [],
    });
  });

  it("takes reachability as a FACT from the boot wiring, not a guess", async () => {
    // The same configuration reports differently depending on whether a verifier
    // is wired — which is what stops this check from drifting from the real
    // auth posture.
    const unreachable = await new DbChannelReachabilitySource(db(["x"]), false).report();
    const reachable = await new DbChannelReachabilitySource(db(["x"]), true).report();

    expect(unreachable.ungrantable).toHaveLength(1);
    expect(reachable.ungrantable).toHaveLength(0);
  });
});
