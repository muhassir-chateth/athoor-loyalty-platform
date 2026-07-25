/**
 * Tests for the spec-defined `POST /v1/redeem` handler (task GAP 2; design.md
 * route table `POST /v1/redeem` → RedemptionResult, Data Flow: Redemption;
 * Req 3.2/3.3/3.7/3.10/3.11, 11.12).
 *
 * The handler drives the EXISTING `redeem` engine, so these tests wire a fake
 * `RedeemDeps` (fake ledger repo + transactor + Queryable + recording enqueuer)
 * that simulates the engine's SQL, and assert the HTTP handler maps each
 * outcome/typed error to the right status:
 *   - success (fresh spend)         → 200 with the redemption + a queued job;
 *   - insufficient points           → 409;
 *   - unknown reward                → 400 invalid_reward;
 *   - unauthenticated               → 401 (auth preHandler rejects);
 *   - idempotent replay             → 200 with the existing redemption, no job;
 *   - rate limit exceeded           → 429 (Req 11.12).
 *
 * Plus a unit test for the one authorized new adapter,
 * {@link PgBossDiscountCodeEnqueuer}: it publishes to the discount-code queue
 * keyed by `redemptionId` (singletonKey).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { InMemoryCustomerResolver, FakeTokenVerifier } from "../auth/identity.js";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import type { DiscountCodeEnqueuer, RedeemDeps, Transactor } from "../redemption/redeem.js";
import {
  PgBossDiscountCodeEnqueuer,
  DISCOUNT_CODE_JOB,
  type JobPublisher,
} from "../redemption/generateDiscountCode.js";
import type { Clock } from "../plugins/rateLimit.js";

const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";

/** A recording enqueuer standing in for the pg-boss discount-code hand-off. */
class RecordingDiscountCodeEnqueuer implements DiscountCodeEnqueuer {
  readonly jobs: Array<{ redemptionId: string }> = [];
  async enqueueDiscountCode(job: { redemptionId: string }): Promise<void> {
    this.jobs.push(job);
  }
}

interface FakeDbConfig {
  /** Spendable balance the SPENDABLE projection returns. */
  spendable?: number;
  /** An existing redemption row for the idempotency guard (replay), else none. */
  existingRedemption?: QueryResultRow | null;
  /** When set, the customer-lock query throws this (e.g. a pg lock-timeout). */
  lockError?: unknown;
  /** Whether the locked customer row exists. */
  customerExists?: boolean;
}

/**
 * A fake {@link Queryable} + {@link Transactor} that simulates the exact SQL the
 * `redeem` engine issues, dispatching on unique substrings of each statement.
 */
class FakeRedeemDb implements Queryable, Transactor {
  constructor(private readonly cfg: FakeDbConfig = {}) {}

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const rows = (r: QueryResultRow[]): QueryResult<R> =>
      ({ rows: r as R[], rowCount: r.length, command: "", oid: 0, fields: [] });

    if (sql.includes("lock_timeout")) {
      return rows([]);
    }
    if (sql.includes("FROM customers")) {
      if (this.cfg.lockError) {
        throw this.cfg.lockError;
      }
      return (this.cfg.customerExists ?? true) ? rows([{ id: params[0] as string }]) : rows([]);
    }
    if (sql.includes("FROM redemptions")) {
      const existing = this.cfg.existingRedemption ?? null;
      return existing ? rows([existing]) : rows([]);
    }
    if (sql.includes("SUM(remaining_points)")) {
      return rows([{ spendable: String(this.cfg.spendable ?? 0) }]);
    }
    if (sql.includes("INSERT INTO redemptions")) {
      return rows([
        {
          id: "redemption-new",
          customer_id: params[0],
          reward_id: params[1],
          points_spent: params[2],
          value_gbp: params[3],
          status: params[4],
          idempotency_key: params[5],
          discount_code_id: null,
          channel: params[6],
          created_at: new Date("2024-01-01T00:00:00.000Z"),
        },
      ]);
    }
    if (sql.includes("INSERT INTO ledger_entries")) {
      return rows([
        {
          id: "ledger-1",
          customer_id: params[0],
          entry_type: params[1],
          points: params[2],
          reason: params[3],
          order_reference: params[4],
          point_lot_id: params[5],
          redemption_id: params[6],
          source_event_id: params[7],
          created_at: new Date("2024-01-01T00:00:00.000Z"),
        },
      ]);
    }
    if (sql.includes("ORDER BY earned_at")) {
      // Consumable lots for FIFO consumption — one lot covering the cost.
      return rows([
        { id: "lot-1", remaining_points: 100000, earned_at: new Date("2023-01-01T00:00:00.000Z"), expires_at: null },
      ]);
    }
    if (sql.includes("UPDATE point_lots")) {
      return rows([]);
    }
    throw new Error(`Unexpected SQL in FakeRedeemDb: ${sql}`);
  }
}

interface BuildOpts {
  db: FakeRedeemDb;
  enqueuer?: DiscountCodeEnqueuer;
  redeemRateLimit?: { maxRequests?: number; windowMs?: number; clock?: Clock };
}

function buildRedeemApp(opts: BuildOpts): { app: FastifyInstance; enqueuer: RecordingDiscountCodeEnqueuer } {
  const app = Fastify({ logger: false });
  registerVersioning(app);

  const enqueuer = (opts.enqueuer as RecordingDiscountCodeEnqueuer) ?? new RecordingDiscountCodeEnqueuer();
  const redeemDeps: RedeemDeps = {
    repo: new LedgerRepository(opts.db),
    transactor: opts.db,
    enqueuer,
  };

  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    redeemDeps,
    redeemRateLimit: opts.redeemRateLimit,
  });

  return { app, enqueuer };
}

let keyCounter = 0;
async function redeem(app: FastifyInstance, body: Record<string, unknown>) {
  keyCounter += 1;
  return app.inject({
    method: "POST",
    url: "/v1/redeem",
    headers: {
      authorization: `Bearer ${BEARER_TOKEN}`,
      "idempotency-key": `idem-${keyCounter}`,
      "content-type": "application/json",
    },
    payload: body,
  });
}

describe("POST /v1/redeem (GAP 2)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns 200 with the redemption and enqueues a discount-code job on success (Req 3.2/3.5)", async () => {
    const built = buildRedeemApp({ db: new FakeRedeemDb({ spendable: 500 }) });
    app = built.app;
    await app.ready();

    const res = await redeem(app, { rewardId: "reward_5", idempotencyKey: "abc-123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "redemption-new",
      rewardId: "reward_5",
      pointsSpent: 100,
      status: "pending_code",
    });
    // A fresh spend enqueues exactly one discount-code job for the redemption.
    expect(built.enqueuer.jobs).toEqual([{ redemptionId: "redemption-new" }]);
  });

  it("returns 409 when the customer has insufficient points (Req 3.3/5.7)", async () => {
    const built = buildRedeemApp({ db: new FakeRedeemDb({ spendable: 50 }) });
    app = built.app;
    await app.ready();

    const res = await redeem(app, { rewardId: "reward_5", idempotencyKey: "abc-123" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "insufficient_points" });
    expect(built.enqueuer.jobs).toHaveLength(0);
  });

  it("returns 400 invalid_reward for an unknown reward id (Req 3.10)", async () => {
    const built = buildRedeemApp({ db: new FakeRedeemDb({ spendable: 500 }) });
    app = built.app;
    await app.ready();

    const res = await redeem(app, { rewardId: "reward_999", idempotencyKey: "abc-123" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_reward" });
  });

  it("returns 401 for an unauthenticated request (Req 9.3)", async () => {
    const built = buildRedeemApp({ db: new FakeRedeemDb({ spendable: 500 }) });
    app = built.app;
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/v1/redeem",
      headers: { "idempotency-key": "idem-unauth", "content-type": "application/json" },
      payload: { rewardId: "reward_5", idempotencyKey: "abc-123" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });

  it("returns 200 with the existing redemption on idempotent replay, without a new job (Req 3.7)", async () => {
    const built = buildRedeemApp({
      db: new FakeRedeemDb({
        spendable: 500,
        existingRedemption: {
          id: "redemption-existing",
          customer_id: LOCAL_CUSTOMER_ID,
          reward_id: "reward_5",
          points_spent: 100,
          value_gbp: 5,
          status: "issued",
          idempotency_key: "abc-123",
          discount_code_id: "dc-1",
          channel: "app",
          created_at: new Date("2024-01-01T00:00:00.000Z"),
        },
      }),
    });
    app = built.app;
    await app.ready();

    const res = await redeem(app, { rewardId: "reward_5", idempotencyKey: "abc-123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: "redemption-existing", status: "issued" });
    // Replay never enqueues a new discount-code job (at most one code per spend).
    expect(built.enqueuer.jobs).toHaveLength(0);
  });

  it("rejects the over-limit request with 429 (Req 11.12)", async () => {
    // A fake clock keeps everything in one window; maxRequests=1 → 2nd is blocked.
    const clock: Clock = { now: () => 1000 };
    const built = buildRedeemApp({
      db: new FakeRedeemDb({
        spendable: 500,
        existingRedemption: {
          id: "redemption-existing",
          customer_id: LOCAL_CUSTOMER_ID,
          reward_id: "reward_5",
          points_spent: 100,
          value_gbp: 5,
          status: "issued",
          idempotency_key: "abc-123",
          discount_code_id: "dc-1",
          channel: "app",
          created_at: new Date("2024-01-01T00:00:00.000Z"),
        },
      }),
      redeemRateLimit: { maxRequests: 1, clock },
    });
    app = built.app;
    await app.ready();

    const first = await redeem(app, { rewardId: "reward_5", idempotencyKey: "abc-123" });
    expect(first.statusCode).toBe(200);

    const second = await redeem(app, { rewardId: "reward_5", idempotencyKey: "abc-123" });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: "rate_limit_exceeded" });
  });
});

describe("PgBossDiscountCodeEnqueuer (GAP 2 adapter)", () => {
  it("publishes to the discount-code queue keyed by redemptionId (singletonKey)", async () => {
    const send = vi.fn(async () => "job-1");
    const boss: JobPublisher = { send };
    const enqueuer = new PgBossDiscountCodeEnqueuer(boss);

    await enqueuer.enqueueDiscountCode({ redemptionId: "redemption-42" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      DISCOUNT_CODE_JOB,
      { redemptionId: "redemption-42" },
      { singletonKey: "redemption-42" },
    );
  });
});
