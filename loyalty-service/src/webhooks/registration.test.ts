import { describe, expect, it } from "vitest";
import {
  ALL_WEBHOOK_TOPICS,
  CLAWBACK_WEBHOOK_TOPICS,
  REGISTERED_WEBHOOK_TOPICS,
  WEBHOOK_CALLBACK_PATH,
  buildAllWebhookRegistrations,
  buildClawbackWebhookRegistrations,
  buildWebhookRegistrations,
  registerAllWebhookTopics,
  registerClawbackWebhookTopics,
  registerWebhookTopics,
  type WebhookRegistration,
  type WebhookRegistrationClient,
} from "./registration.js";

/**
 * Task 3.2 — deploy-time topic registration. These tests exercise the plan and
 * the apply-through-client helper with a FAKE client. No live Shopify store is
 * ever contacted (the helper only acts on an injected client).
 */

describe("buildWebhookRegistrations", () => {
  it("registers exactly customers/create and orders/paid", () => {
    expect([...REGISTERED_WEBHOOK_TOPICS]).toEqual(["customers/create", "orders/paid"]);
  });

  it("builds one HTTPS JSON registration per topic to the receiver path", () => {
    const plan = buildWebhookRegistrations("https://loyalty.athoor.example/");
    expect(plan).toHaveLength(2);
    for (const reg of plan) {
      expect(reg.address).toBe(`https://loyalty.athoor.example${WEBHOOK_CALLBACK_PATH}`);
      expect(reg.format).toBe("json");
    }
    expect(plan.map((r) => r.topic)).toEqual(["customers/create", "orders/paid"]);
  });

  it("does not include the clawback topics in the MVP (task 3.2) set", () => {
    const topics = buildWebhookRegistrations("https://x.example").map((r) => r.topic);
    expect(topics).not.toContain("refunds/create");
    expect(topics).not.toContain("orders/cancelled");
  });
});

describe("clawback topic registration (task 9.1)", () => {
  it("registers exactly refunds/create and orders/cancelled", () => {
    expect([...CLAWBACK_WEBHOOK_TOPICS]).toEqual(["refunds/create", "orders/cancelled"]);
  });

  it("builds one HTTPS JSON registration per clawback topic to the receiver path", () => {
    const plan = buildClawbackWebhookRegistrations("https://loyalty.athoor.example/");
    expect(plan.map((r) => r.topic)).toEqual(["refunds/create", "orders/cancelled"]);
    for (const reg of plan) {
      expect(reg.address).toBe(`https://loyalty.athoor.example${WEBHOOK_CALLBACK_PATH}`);
      expect(reg.format).toBe("json");
    }
  });

  it("ALL_WEBHOOK_TOPICS is the union of the MVP and clawback sets", () => {
    expect([...ALL_WEBHOOK_TOPICS]).toEqual([
      "customers/create",
      "orders/paid",
      "refunds/create",
      "orders/cancelled",
    ]);
  });

  it("buildAllWebhookRegistrations covers every topic", () => {
    const topics = buildAllWebhookRegistrations("https://x.example").map((r) => r.topic);
    expect(topics).toEqual([...ALL_WEBHOOK_TOPICS]);
  });

  it("registerClawbackWebhookTopics / registerAllWebhookTopics apply via the injected client", async () => {
    const fakeClient: WebhookRegistrationClient = {
      async registerWebhook(reg) {
        return { id: `sub-${reg.topic}` };
      },
    };

    const clawbackResults = await registerClawbackWebhookTopics(
      fakeClient,
      "https://loyalty.athoor.example",
    );
    expect(clawbackResults).toEqual([
      { topic: "refunds/create", id: "sub-refunds/create" },
      { topic: "orders/cancelled", id: "sub-orders/cancelled" },
    ]);

    const allResults = await registerAllWebhookTopics(fakeClient, "https://loyalty.athoor.example");
    expect(allResults.map((r) => r.topic)).toEqual([...ALL_WEBHOOK_TOPICS]);
  });
});

describe("registerWebhookTopics (applies plan via injected client only)", () => {
  it("registers every planned topic through the client and returns their ids", async () => {
    const received: WebhookRegistration[] = [];
    const fakeClient: WebhookRegistrationClient = {
      async registerWebhook(reg) {
        received.push(reg);
        return { id: `sub-${reg.topic}` };
      },
    };

    const results = await registerWebhookTopics(fakeClient, "https://loyalty.athoor.example");

    expect(received.map((r) => r.topic)).toEqual(["customers/create", "orders/paid"]);
    expect(results).toEqual([
      { topic: "customers/create", id: "sub-customers/create" },
      { topic: "orders/paid", id: "sub-orders/paid" },
    ]);
  });
});
