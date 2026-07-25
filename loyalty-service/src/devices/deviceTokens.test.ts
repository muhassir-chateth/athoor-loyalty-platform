/**
 * Unit tests for the Device_Token store + notification-event model (task 19.1,
 * Requirement 19.1, 19.2).
 *
 * No live/production system is touched: the tests run entirely against the
 * in-memory store. They verify:
 *   - registration is idempotent per (customer, token) and re-activates a
 *     previously de-registered token (Req 19.1);
 *   - de-registration removes a token from the active set and is a no-op for an
 *     unknown/already-revoked token (Req 19.1);
 *   - tokens are scoped per customer (a customer never sees another's tokens);
 *   - a notification event resolves to a customer's ACTIVE device tokens, so it
 *     targets devices directly without a web client (Req 19.2);
 *   - the registration schema accepts valid bodies and rejects invalid ones.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryDeviceTokenStore,
  deviceRegistrationSchema,
  resolveNotificationTargets,
} from "./deviceTokens.js";

const CUSTOMER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("InMemoryDeviceTokenStore registration (Req 19.1)", () => {
  it("registers a token and lists it as active", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });

    const active = await store.listActiveTokens(CUSTOMER_A);
    expect(active).toEqual([{ token: "tok-1", platform: "ios" }]);
  });

  it("is idempotent per (customer, token): re-registering does not duplicate", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "android" });

    const active = await store.listActiveTokens(CUSTOMER_A);
    // One entry, platform refreshed by the latest registration.
    expect(active).toEqual([{ token: "tok-1", platform: "android" }]);
  });

  it("re-activates a previously de-registered token on re-registration", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });
    await store.deregister(CUSTOMER_A, "tok-1");
    expect(await store.listActiveTokens(CUSTOMER_A)).toEqual([]);

    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });
    expect(await store.listActiveTokens(CUSTOMER_A)).toEqual([{ token: "tok-1", platform: "ios" }]);
  });
});

describe("InMemoryDeviceTokenStore de-registration (Req 19.1)", () => {
  it("removes a token from the active set", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });
    await store.register(CUSTOMER_A, { token: "tok-2", platform: "android" });

    await store.deregister(CUSTOMER_A, "tok-1");

    expect(await store.listActiveTokens(CUSTOMER_A)).toEqual([
      { token: "tok-2", platform: "android" },
    ]);
  });

  it("is a no-op for an unknown token (idempotent)", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });

    await expect(store.deregister(CUSTOMER_A, "does-not-exist")).resolves.toBeUndefined();
    await expect(store.deregister(CUSTOMER_A, "tok-1")).resolves.toBeUndefined();
    // De-registering twice is safe.
    await expect(store.deregister(CUSTOMER_A, "tok-1")).resolves.toBeUndefined();
    expect(await store.listActiveTokens(CUSTOMER_A)).toEqual([]);
  });
});

describe("Device_Tokens are scoped per customer", () => {
  it("never returns another customer's tokens", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "a-tok", platform: "ios" });
    await store.register(CUSTOMER_B, { token: "b-tok", platform: "android" });

    expect(await store.listActiveTokens(CUSTOMER_A)).toEqual([{ token: "a-tok", platform: "ios" }]);
    expect(await store.listActiveTokens(CUSTOMER_B)).toEqual([
      { token: "b-tok", platform: "android" },
    ]);
  });

  it("returns an empty list for a customer with no devices", async () => {
    const store = new InMemoryDeviceTokenStore();
    expect(await store.listActiveTokens(CUSTOMER_A)).toEqual([]);
  });
});

describe("notification event targeting (Req 19.2)", () => {
  it("resolves an event to the customer's active device tokens (no web client needed)", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });
    await store.register(CUSTOMER_A, { token: "tok-2", platform: "android" });

    const targets = await resolveNotificationTargets(store, {
      customerId: CUSTOMER_A,
      type: "points_expiring",
      payload: { amount: 100, expiresAt: "2025-01-01T00:00:00.000Z" },
    });

    expect(targets).toEqual([
      { token: "tok-1", platform: "ios" },
      { token: "tok-2", platform: "android" },
    ]);
  });

  it("excludes de-registered devices from a notification's targets", async () => {
    const store = new InMemoryDeviceTokenStore();
    await store.register(CUSTOMER_A, { token: "tok-1", platform: "ios" });
    await store.register(CUSTOMER_A, { token: "tok-2", platform: "android" });
    await store.deregister(CUSTOMER_A, "tok-1");

    const targets = await resolveNotificationTargets(store, {
      customerId: CUSTOMER_A,
      type: "reward_ready",
    });

    expect(targets).toEqual([{ token: "tok-2", platform: "android" }]);
  });

  it("resolves to an empty target set for a customer with no devices (not an error)", async () => {
    const store = new InMemoryDeviceTokenStore();
    const targets = await resolveNotificationTargets(store, {
      customerId: CUSTOMER_A,
      type: "tier_upgraded",
    });
    expect(targets).toEqual([]);
  });
});

describe("deviceRegistrationSchema", () => {
  it("accepts a valid ios registration", () => {
    const parsed = deviceRegistrationSchema.safeParse({ token: "tok-1", platform: "ios" });
    expect(parsed.success).toBe(true);
  });

  it("accepts a valid android registration", () => {
    const parsed = deviceRegistrationSchema.safeParse({ token: "tok-1", platform: "android" });
    expect(parsed.success).toBe(true);
  });

  it("trims the token and strips unknown keys", () => {
    const parsed = deviceRegistrationSchema.parse({
      token: "  tok-1  ",
      platform: "ios",
      extra: "ignored",
    });
    expect(parsed).toEqual({ token: "tok-1", platform: "ios" });
  });

  it("rejects an empty token", () => {
    expect(deviceRegistrationSchema.safeParse({ token: "", platform: "ios" }).success).toBe(false);
  });

  it("rejects an unknown platform", () => {
    expect(
      deviceRegistrationSchema.safeParse({ token: "tok-1", platform: "windows" }).success,
    ).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(deviceRegistrationSchema.safeParse({ platform: "ios" }).success).toBe(false);
  });
});
