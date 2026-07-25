/**
 * Unit + property tests for the idempotency store and key validation
 * (task 6.1, Requirements 9.6, 9.7).
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  InMemoryIdempotencyStore,
  isValidIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_WINDOW_MS,
  type StoredResponse,
} from "./store.js";

const sample = (overrides: Partial<StoredResponse> = {}): StoredResponse => ({
  statusCode: 200,
  payload: '{"ok":true}',
  contentType: "application/json; charset=utf-8",
  ...overrides,
});

describe("isValidIdempotencyKey (Req 9.6/9.7)", () => {
  it("accepts a 1-character key", () => {
    expect(isValidIdempotencyKey("a")).toBe(true);
  });

  it("accepts a 128-character key", () => {
    expect(isValidIdempotencyKey("x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toBe(true);
  });

  it("rejects a 129-character key", () => {
    expect(isValidIdempotencyKey("x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(isValidIdempotencyKey("   ")).toBe(false);
  });

  it("rejects missing / non-string values", () => {
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey(42)).toBe(false);
  });

  it("property: accepts iff trimmed length in [1,128] and raw length <= 128", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const expected = s.trim().length >= 1 && s.length <= IDEMPOTENCY_KEY_MAX_LENGTH;
        expect(isValidIdempotencyKey(s)).toBe(expected);
      }),
    );
  });
});

describe("InMemoryIdempotencyStore", () => {
  it("returns null for an unknown key", async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("returns the stored result for a repeated key (Req 9.6)", async () => {
    const store = new InMemoryIdempotencyStore();
    const response = sample({ statusCode: 201, payload: '{"id":"abc"}' });
    await store.put("k1", response);
    expect(await store.get("k1")).toEqual(response);
  });

  it("first write wins — a second put does not overwrite a live entry", async () => {
    const store = new InMemoryIdempotencyStore();
    const first = sample({ payload: '{"n":1}' });
    const second = sample({ payload: '{"n":2}' });
    await store.put("k", first);
    await store.put("k", second);
    expect(await store.get("k")).toEqual(first);
  });

  it("treats an entry older than the 24h window as absent (Req 9.6)", async () => {
    const store = new InMemoryIdempotencyStore();
    const t0 = new Date("2025-01-01T00:00:00.000Z");
    await store.put("k", sample(), t0);

    // Just inside the window: still present.
    const insideWindow = new Date(t0.getTime() + IDEMPOTENCY_WINDOW_MS - 1);
    expect(await store.get("k", insideWindow)).not.toBeNull();

    // Just outside the window: treated as absent.
    const outsideWindow = new Date(t0.getTime() + IDEMPOTENCY_WINDOW_MS + 1);
    expect(await store.get("k", outsideWindow)).toBeNull();
  });

  it("after the window elapses, a fresh put replaces the stale entry", async () => {
    const store = new InMemoryIdempotencyStore();
    const t0 = new Date("2025-01-01T00:00:00.000Z");
    await store.put("k", sample({ payload: '{"n":1}' }), t0);

    const later = new Date(t0.getTime() + IDEMPOTENCY_WINDOW_MS + 1000);
    await store.put("k", sample({ payload: '{"n":2}' }), later);
    expect(await store.get("k", later)).toEqual(sample({ payload: '{"n":2}' }));
  });

  it("property: any key put then immediately get returns the identical result", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 128 }),
        fc.integer({ min: 100, max: 499 }),
        fc.string(),
        async (key, statusCode, payload) => {
          const store = new InMemoryIdempotencyStore();
          const response = sample({ statusCode, payload });
          await store.put(key, response);
          expect(await store.get(key)).toEqual(response);
        },
      ),
    );
  });
});
