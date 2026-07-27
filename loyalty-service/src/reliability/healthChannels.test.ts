/**
 * `/health` publishes channel reachability (task 42, A19).
 *
 * Pins the contract at the HTTP boundary, and pins the guarantee that matters: a
 * reachability finding is informational and never degrades liveness, because
 * nothing about it changes a grant decision.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DbChannelReachabilitySource } from "../channel/reachability.js";
import type { ChannelReachabilitySource } from "../channel/reachability.js";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

const config = () => loadConfig({ NODE_ENV: "test" });

function db(keys: string[]): Queryable {
  return {
    query: async <R extends QueryResultRow>() => {
      const rows = keys.map((key) => ({ key }));
      return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<R>;
    },
  };
}

describe("/health channels block", () => {
  it("reports web reachable, app unreachable, nothing ungrantable", async () => {
    const app = buildApp(config(), {
      channelReachability: new DbChannelReachabilitySource(db([]), false),
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      channels: { attributed: "web", reachable: { web: true, app: false }, ungrantable: [] },
    });
    await app.close();
  });

  it("names an entitlement that is grantable to nobody, without failing liveness", async () => {
    const app = buildApp(config(), {
      channelReachability: new DbChannelReachabilitySource(db(["app_only_perk"]), false),
    });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    // Still ok: the gate is correct, the CONFIGURATION is the mistake — and it is
    // now visible instead of an entitlement silently vanishing for everyone.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().channels.ungrantable).toEqual([
      { kind: "benefit", id: "app_only_perk", requiresChannel: "app" },
    ]);
    await app.close();
  });

  it("keeps answering ok when the check itself throws", async () => {
    const exploding: ChannelReachabilitySource = {
      report: async () => {
        throw new Error("benefits unavailable");
      },
    };
    const app = buildApp(config(), { channelReachability: exploding });
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect("channels" in res.json()).toBe(false);
    await app.close();
  });

  it("omits the block entirely when not wired (payload unchanged)", async () => {
    const app = buildApp(config(), {});
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect("channels" in res.json()).toBe(false);
    await app.close();
  });
});
