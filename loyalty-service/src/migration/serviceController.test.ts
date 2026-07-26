/**
 * Unit tests for the operator-suspended service controller (task 33).
 *
 * The point of this controller is that rollback FAILS CLOSED until the service
 * has genuinely been suspended, and that "it is stopped" is a verified fact
 * rather than an assumption. These tests pin both, plus the consecutive-probe
 * rule that stops a transient blip unlocking a restore.
 */
import { describe, expect, it } from "vitest";
import { runMetafieldRollback, type M0Backup } from "./rollback.js";
import {
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_REQUIRED_CONSECUTIVE_FAILURES,
  MANUAL_SUSPENSION_NOTICE,
  OperatorSuspendedServiceController,
  type ProbeFetchLike,
  type ProbeOutcome,
} from "./serviceController.js";

const BASE_URL = "https://athoor-loyalty-platform.onrender.com";

function recordingSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

/** A probe fetch driven by a script of statuses / thrown transport errors. */
function scriptedProbe(script: Array<number | Error>): {
  fetchImpl: ProbeFetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const queue = [...script];
  const fetchImpl: ProbeFetchLike = async (url) => {
    urls.push(url);
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    const status = next ?? 200;
    return { ok: status >= 200 && status < 300, status };
  };
  return { fetchImpl, urls };
}

describe("OperatorSuspendedServiceController — method surface", () => {
  it("exposes exactly isRunning and stop", () => {
    const { fetchImpl } = scriptedProbe([200]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, { fetchImpl });

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(controller))
      .filter((name) => name !== "constructor")
      .filter(
        (name) => typeof (controller as unknown as Record<string, unknown>)[name] === "function",
      )
      .sort();

    expect(surface).toEqual(["isRunning", "stop"]);
  });

  it("requires a base URL so 'is it stopped?' cannot become an assumption again", () => {
    expect(() => new OperatorSuspendedServiceController("")).toThrow(/base URL is required/);
  });
});

describe("OperatorSuspendedServiceController.stop", () => {
  it("stops nothing and records that suspension is a manual operator action", async () => {
    const logs: string[] = [];
    const { fetchImpl, urls } = scriptedProbe([]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      log: (m) => logs.push(m),
    });

    await controller.stop();

    // No request of any kind was made: it cannot stop the service.
    expect(urls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(MANUAL_SUSPENSION_NOTICE);
    expect(logs[0]).toContain(`${BASE_URL}/health`);
  });
});

describe("OperatorSuspendedServiceController.isRunning", () => {
  it("probes GET /health and reports running on the first answer", async () => {
    const probes: ProbeOutcome[] = [];
    const { fetchImpl, urls } = scriptedProbe([200]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      log: () => {},
      onProbe: (p) => probes.push(p),
    });

    await expect(controller.isRunning()).resolves.toBe(true);
    expect(urls).toEqual([`${BASE_URL}/health`]);
    expect(probes).toEqual([{ attempt: 1, answered: true, status: 200, error: null }]);
  });

  it("treats any HTTP answer — including 5xx — as a running process", async () => {
    const { fetchImpl } = scriptedProbe([503]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      log: () => {},
    });

    await expect(controller.isRunning()).resolves.toBe(true);
  });

  it("does not conclude 'stopped' from a single transient failure", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetchImpl, urls } = scriptedProbe([new Error("ECONNRESET"), 200]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      sleep,
      log: () => {},
    });

    await expect(controller.isRunning()).resolves.toBe(true);
    expect(urls).toHaveLength(2);
    expect(delays).toEqual([DEFAULT_PROBE_INTERVAL_MS]);
  });

  it("does not conclude 'stopped' from two consecutive failures either", async () => {
    const { sleep } = recordingSleeper();
    const { fetchImpl } = scriptedProbe([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      200,
    ]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      sleep,
      log: () => {},
    });

    await expect(controller.isRunning()).resolves.toBe(true);
  });

  it("reports stopped only after 3 consecutive failed probes spaced ~2s apart", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetchImpl, urls } = scriptedProbe([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
    ]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      sleep,
      log: () => {},
    });

    await expect(controller.isRunning()).resolves.toBe(false);
    expect(urls).toHaveLength(DEFAULT_REQUIRED_CONSECUTIVE_FAILURES);
    // One gap between each pair of probes, none after the last.
    expect(delays).toEqual([DEFAULT_PROBE_INTERVAL_MS, DEFAULT_PROBE_INTERVAL_MS]);
  });

  it("honours configured probe count and interval", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetchImpl, urls } = scriptedProbe([new Error("down"), new Error("down")]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      sleep,
      log: () => {},
      requiredConsecutiveFailures: 2,
      probeIntervalMs: 250,
    });

    await expect(controller.isRunning()).resolves.toBe(false);
    expect(urls).toHaveLength(2);
    expect(delays).toEqual([250]);
  });

  it("probes a configured health path and joins the URL cleanly", async () => {
    const { fetchImpl, urls } = scriptedProbe([200]);
    const controller = new OperatorSuspendedServiceController(`${BASE_URL}/`, {
      fetchImpl,
      log: () => {},
      healthPath: "healthz",
    });

    await controller.isRunning();
    expect(urls).toEqual([`${BASE_URL}/healthz`]);
  });
});

describe("rollback wired to the real controller", () => {
  const backup: M0Backup = {
    schemaVersion: "1.0",
    kind: "m0-metafield-export",
    exportedAt: "2026-07-26T15:20:23.665Z",
    storeDomain: "athoor-loyalty-staging.myshopify.com",
    totalExpected: 1,
    enrolledExpected: 1,
    totalExported: 1,
    enrolledExported: 1,
    customers: [
      {
        id: "9034269556935",
        gid: "gid://shopify/Customer/9034269556935",
        email: null,
        enrolled: true,
        lifetimeSpendGBP: 0,
        metafields: [
          { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "50" },
        ],
        loyalty: {
          pointsBalance: 50,
          lifetimePoints: 50,
          tier: "bronze",
          pointsExpiryDate: null,
          referralCode: null,
          referralCount: null,
          activityLog: null,
        },
      },
    ],
  };

  it("aborts without touching a metafield while the service still answers /health", async () => {
    const calls: string[] = [];
    const { fetchImpl } = scriptedProbe([200]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      log: () => {},
    });

    const result = await runMetafieldRollback({
      backup,
      service: controller,
      client: {
        restoreCustomerMetafields: async () => void calls.push("restore"),
        readCustomerMetafields: async () => {
          calls.push("read");
          return [];
        },
      },
    });

    expect(result.status).toBe("aborted_service_running");
    expect(calls).toEqual([]);
  });

  it("proceeds once three consecutive probes fail (service genuinely suspended)", async () => {
    const { sleep } = recordingSleeper();
    const { fetchImpl } = scriptedProbe([
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
      new Error("ECONNREFUSED"),
    ]);
    const controller = new OperatorSuspendedServiceController(BASE_URL, {
      fetchImpl,
      sleep,
      log: () => {},
    });

    const result = await runMetafieldRollback({
      backup,
      service: controller,
      client: {
        restoreCustomerMetafields: async () => {},
        readCustomerMetafields: async () => backup.customers[0]!.metafields,
      },
    });

    expect(result.status).toBe("rolled_back");
    if (result.status === "rolled_back") {
      expect(result.serviceStopped).toBe(true);
      expect(result.customersRestored).toBe(1);
    }
  });
});
