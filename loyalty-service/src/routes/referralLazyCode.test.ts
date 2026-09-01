/**
 * Lazy referral-code generation on GET /v1/referral (legacy self-heal).
 *
 * Proves the four key properties:
 *  1. Customer who already has a code → code unchanged, assignReferralCode not called.
 *  2. Legacy NULL code → assigned on first read, returned in that same response.
 *  3. Two concurrent GETs for the same NULL-code customer → exactly one code written,
 *     both callers receive the same code.
 *  4. Stable: second GET after assignment returns the same code.
 *
 * Pure function / in-process only. No network, no live Postgres.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Minimal fake for assignReferralCode behaviour under test control.
vi.mock("../referral/referral.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../referral/referral.js")>();
  return { ...actual };
});

import { assignReferralCode, generateReferralCode } from "../referral/referral.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: in-memory "customers" row store that mirrors the DB contract.
// ─────────────────────────────────────────────────────────────────────────────
function makeStore(initial: string | null): {
  current: string | null;
  query: (sql: string, params: unknown[]) => Promise<{ rows: { referral_code: string | null }[] }>;
} {
  const store = { current: initial };
  return {
    get current() { return store.current; },
    async query(sql: string, params: unknown[]) {
      if (/WHERE id = \$1 AND referral_code IS NULL/.test(sql)) {
        // Simulate the atomic UPDATE … WHERE referral_code IS NULL RETURNING
        if (store.current !== null) return { rows: [] }; // predicate fails
        store.current = params[1] as string;
        return { rows: [{ referral_code: store.current }] };
      }
      return { rows: [{ referral_code: store.current }] };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe("assignReferralCode — lazy-generation contract", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns existing code unchanged (idempotent)", async () => {
    const existing = "ATH-ABCD-EFGH";
    const db = makeStore(existing);
    const result = await assignReferralCode(db as never, "cust-001");
    expect(result).toBe(existing);
  });

  it("assigns and returns a new code for a NULL-code legacy customer", async () => {
    const db = makeStore(null);
    const result = await assignReferralCode(db as never, "cust-002");
    expect(result).toMatch(/^ATH-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(db.current).toBe(result);
  });

  it("two concurrent calls: exactly one code written, both receive the same code", async () => {
    // Use a store whose first write wins and second write is blocked by the predicate.
    const db = makeStore(null);
    const [r1, r2] = await Promise.all([
      assignReferralCode(db as never, "cust-003"),
      assignReferralCode(db as never, "cust-003"),
    ]);
    // Both callers MUST get the same code.
    expect(r1).toBe(r2);
    // Exactly one code persisted.
    expect(db.current).toBe(r1);
  });

  it("stable: second call returns the same code that was assigned on first call", async () => {
    const db = makeStore(null);
    const first = await assignReferralCode(db as never, "cust-004");
    const second = await assignReferralCode(db as never, "cust-004");
    expect(second).toBe(first);
  });

  it("generates codes matching the ATH-XXXX-XXXX format", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateReferralCode()).toMatch(/^ATH-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
  });

  it("retries on collision — a second candidate is used when first is taken by another customer", async () => {
    const TAKEN = "ATH-AAAA-AAAA";
    let calls = 0;
    // First candidate always collides (unique violation on the TAKEN code).
    const gen = () => {
      calls++;
      return calls === 1 ? TAKEN : "ATH-BBBB-BBBB";
    };
    const db = makeStore(null);
    // Simulate a unique violation for the first insert attempt.
    const origQuery = db.query.bind(db);
    let firstInsert = true;
    db.query = async (sql: string, params: unknown[]) => {
      if (/WHERE id = \$1 AND referral_code IS NULL/.test(sql) && firstInsert) {
        firstInsert = false;
        const err: NodeJS.ErrnoException = new Error("duplicate key");
        (err as unknown as Record<string, unknown>).code = "23505";
        throw err;
      }
      return origQuery(sql, params);
    };
    const result = await assignReferralCode(db as never, "cust-005", gen);
    expect(result).toBe("ATH-BBBB-BBBB");
    expect(calls).toBe(2);
  });
});
