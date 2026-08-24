/**
 * Tests for the portal authorisation choke point.
 *
 * Two kinds of guarantee are checked, and the type-level ones matter most: they
 * are what make every future call site safe without anyone having to remember a
 * rule. `@ts-expect-error` is used as an ASSERTION — each one fails the build if
 * the construction it forbids ever starts compiling.
 */
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  ScopeUnavailableError,
  requireCustomerScope,
  scopedCustomerId,
  type CustomerScope,
} from "./customerScope.js";
import type { AuthCtx } from "./identity.js";

/** A request carrying whatever `authCtx` a test wants to present. */
const reqWith = (authCtx: unknown): FastifyRequest =>
  ({ authCtx } as unknown as FastifyRequest);

const VALID: AuthCtx = {
  customerId: "1f0c7c4e-0000-4000-8000-000000000001",
  channel: "web",
  source: "app_proxy",
};

describe("requireCustomerScope is the only way in", () => {
  it("returns a scope carrying the resolved identity", () => {
    const scope = requireCustomerScope(reqWith(VALID));
    expect(scope.customerId).toBe(VALID.customerId);
    expect(scope.channel).toBe("web");
    expect(scope.source).toBe("app_proxy");
  });

  it("carries the app channel through for a bearer-token request", () => {
    const scope = requireCustomerScope(
      reqWith({ customerId: "x-1", channel: "app", source: "customer_account_api" }),
    );
    expect(scope.channel).toBe("app");
    expect(scope.source).toBe("customer_account_api");
  });

  it("refuses when the auth middleware resolved no identity", () => {
    expect(() => requireCustomerScope(reqWith(undefined))).toThrow(ScopeUnavailableError);
  });

  it.each([
    ["null", null],
    ["a bare string", "1f0c7c4e"],
    ["a number", 42],
    ["an empty object", {}],
    ["an empty customerId", { customerId: "", channel: "web", source: "app_proxy" }],
    ["a non-string customerId", { customerId: 7, channel: "web", source: "app_proxy" }],
    ["an unknown channel", { customerId: "x", channel: "kiosk", source: "app_proxy" }],
    ["an unknown source", { customerId: "x", channel: "web", source: "guessing" }],
    ["a missing channel", { customerId: "x", source: "app_proxy" }],
  ])("refuses %s rather than trusting it", (_label, authCtx) => {
    expect(() => requireCustomerScope(reqWith(authCtx))).toThrow(ScopeUnavailableError);
  });

  it("reads ONLY authCtx — a body, query or header cannot select the customer", () => {
    // The attack this module exists to prevent: a client nominating an id.
    const hostile = {
      authCtx: VALID,
      body: { customerId: "attacker-chosen" },
      query: { customerId: "attacker-chosen" },
      headers: { "x-customer-id": "attacker-chosen" },
      params: { customerId: "attacker-chosen" },
    } as unknown as FastifyRequest;

    const scope = requireCustomerScope(hostile);
    expect(scope.customerId).toBe(VALID.customerId);
    expect(scope.customerId).not.toBe("attacker-chosen");
  });

  it("refuses even when a hostile id is present but authCtx is absent", () => {
    // Fails CLOSED: a missing identity must not fall back to anything.
    const hostile = {
      body: { customerId: "attacker-chosen" },
      query: { customerId: "attacker-chosen" },
    } as unknown as FastifyRequest;
    expect(() => requireCustomerScope(hostile)).toThrow(ScopeUnavailableError);
  });
});

describe("ScopeUnavailableError leaks nothing and matches the existing contract", () => {
  it("uses the same code the auth layer already returns", () => {
    // So a portal route and a pre-existing /v1 route fail identically and the
    // client contract does not fork.
    expect(new ScopeUnavailableError().code).toBe("identity_resolution_failed");
  });

  it("is a real Error with a stable name", () => {
    const err = new ScopeUnavailableError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ScopeUnavailableError");
  });

  it("carries no customer id, resource id, or reason detail", () => {
    // An authorisation failure must not become an enumeration oracle.
    const serialised = JSON.stringify({
      name: new ScopeUnavailableError().name,
      message: new ScopeUnavailableError().message,
      code: new ScopeUnavailableError().code,
    });
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(serialised.toLowerCase()).not.toContain("order");
    expect(serialised.toLowerCase()).not.toContain("not your");
  });
});

describe("the brand cannot be forged (type-level assertions)", () => {
  it("rejects an object literal shaped like a scope", () => {
    // @ts-expect-error the brand property is unconstructable outside the module
    const forged: CustomerScope = {
      customerId: "attacker-chosen",
      channel: "web",
      source: "app_proxy",
    };
    // Runtime is irrelevant here; the assertion is that the line above does not compile.
    expect(forged.customerId).toBe("attacker-chosen");
  });

  it("rejects a bare string", () => {
    // @ts-expect-error a customer id is not an authorisation decision
    const forged: CustomerScope = "1f0c7c4e-0000-4000-8000-000000000001";
    expect(typeof forged).toBe("string");
  });

  it("rejects a plain AuthCtx, which is unverified as far as callers know", () => {
    // @ts-expect-error AuthCtx lacks the brand, so it is not a scope
    const forged: CustomerScope = VALID;
    expect(forged.customerId).toBe(VALID.customerId);
  });

  it("rejects spreading a real scope with a different customerId", () => {
    const real = requireCustomerScope(reqWith(VALID));
    // @ts-expect-error spreading drops the brand, so escalation does not compile
    const escalated: CustomerScope = { ...real, customerId: "someone-else" };
    expect(escalated.customerId).toBe("someone-else");
  });

  it("a real scope IS assignable, so the safe path stays ergonomic", () => {
    const real: CustomerScope = requireCustomerScope(reqWith(VALID));
    expect(scopedCustomerId(real)).toBe(VALID.customerId);
  });

  it("rejects an unbranded argument to a scope-typed function", () => {
    // @ts-expect-error the whole point: engines cannot be handed an unverified id
    expect(() => scopedCustomerId("1f0c7c4e" as unknown as never)).not.toThrow();
  });
});

describe("scopedCustomerId is the single deliberate unwrap", () => {
  it("returns the local customers.id unchanged", () => {
    const scope = requireCustomerScope(reqWith(VALID));
    expect(scopedCustomerId(scope)).toBe(VALID.customerId);
  });

  it("agrees with reading the property directly", () => {
    const scope = requireCustomerScope(reqWith(VALID));
    expect(scopedCustomerId(scope)).toBe(scope.customerId);
  });
});

describe("a scope is immutable once issued", () => {
  it("does not let a handler retarget it at another customer", () => {
    const scope = requireCustomerScope(reqWith(VALID));
    // @ts-expect-error customerId is readonly
    expect(() => { scope.customerId = "someone-else"; }).toThrow(TypeError);
    expect(scope.customerId).toBe(VALID.customerId);
  });
});
