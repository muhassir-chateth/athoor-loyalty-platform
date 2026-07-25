/**
 * Unit tests for the pre-expiry email worker + provider (task 10.2).
 *
 * Verifies, against a fake pg-boss consumer and a recording provider, that:
 *   - registration binds to the `preExpiryEmail` queue (PRE_EXPIRY_NOTIFY_JOB);
 *   - each delivered VALID job produces EXACTLY ONE provider send, carrying the
 *     customer, expiring amount and expiry date rehydrated from the payload;
 *   - a MALFORMED payload is skipped safely — no send, no throw, worker survives;
 *   - a PROVIDER FAILURE surfaces as a rejected handler (so pg-boss retries) and
 *     never crashes the worker beyond that; and
 *   - the default {@link LoggingEmailProvider} never throws fatally, even with a
 *     misbehaving logger, so the system runs without a real ESP.
 *
 * No live/production system is touched: no real email is sent and no queue is
 * connected — everything runs through in-memory fakes.
 */
import { describe, it, expect } from "vitest";
import {
  LoggingEmailProvider,
  RecordingEmailProvider,
  processPreExpiryEmailJob,
  registerPreExpiryEmailWorker,
  type EmailProvider,
  type Logger,
  type PreExpiryEmailJobConsumer,
} from "./emailProvider.js";
import {
  PRE_EXPIRY_NOTIFY_JOB,
  type PreExpiryNotification,
} from "./preExpiryNotify.js";

type Handler = (jobs: Array<{ data: unknown }>) => Promise<void>;

/** A fake pg-boss consumer that captures the queue name + handler it is given. */
function fakeConsumer(): PreExpiryEmailJobConsumer & {
  captured: { name: string; handler: Handler | undefined };
} {
  const captured: { name: string; handler: Handler | undefined } = {
    name: "",
    handler: undefined,
  };
  return {
    captured,
    async work(name: string, handler: Handler) {
      captured.name = name;
      captured.handler = handler;
      return "job-id";
    },
  };
}

/** A well-formed raw job payload as published by PgBossPreExpiryNotifier. */
function validJob(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    customerId: "cust-1",
    pointLotId: "lot-1",
    pointsExpiring: 120,
    expiresAt: new Date("2025-01-31T00:00:00.000Z").toISOString(),
    ...overrides,
  };
}

/** A recording logger for asserting skip/warn behaviour. */
function recordingLogger(): Logger & { infos: unknown[]; warns: unknown[]; errors: unknown[] } {
  const infos: unknown[] = [];
  const warns: unknown[] = [];
  const errors: unknown[] = [];
  return {
    infos,
    warns,
    errors,
    info: (m, meta) => infos.push({ m, meta }),
    warn: (m, meta) => warns.push({ m, meta }),
    error: (m, meta) => errors.push({ m, meta }),
  };
}

describe("registerPreExpiryEmailWorker", () => {
  it("binds to the preExpiryEmail queue by default", async () => {
    const consumer = fakeConsumer();
    const provider = new RecordingEmailProvider();

    const id = await registerPreExpiryEmailWorker(consumer, { provider });

    expect(id).toBe("job-id");
    expect(consumer.captured.name).toBe(PRE_EXPIRY_NOTIFY_JOB);
    expect(consumer.captured.name).toBe("preExpiryEmail");
  });

  it("sends EXACTLY ONE email per delivered valid job, with the right amount and date", async () => {
    const consumer = fakeConsumer();
    const provider = new RecordingEmailProvider();
    await registerPreExpiryEmailWorker(consumer, { provider });

    await consumer.captured.handler?.([
      { data: validJob({ pointLotId: "lot-1", pointsExpiring: 10 }) },
      { data: validJob({ pointLotId: "lot-2", pointsExpiring: 20 }) },
    ]);

    expect(provider.sent).toHaveLength(2);
    const first = provider.sent[0] as PreExpiryNotification;
    expect(first.customerId).toBe("cust-1");
    expect(first.pointLotId).toBe("lot-1");
    expect(first.pointsExpiring).toBe(10);
    expect(first.expiresAt).toBeInstanceOf(Date);
    expect(first.expiresAt.toISOString()).toBe("2025-01-31T00:00:00.000Z");
    expect((provider.sent[1] as PreExpiryNotification).pointsExpiring).toBe(20);
  });

  it("delivers one send per job across separate batches (idempotent per job, not per batch)", async () => {
    const consumer = fakeConsumer();
    const provider = new RecordingEmailProvider();
    await registerPreExpiryEmailWorker(consumer, { provider });

    await consumer.captured.handler?.([{ data: validJob({ pointLotId: "lot-1" }) }]);
    await consumer.captured.handler?.([{ data: validJob({ pointLotId: "lot-2" }) }]);

    expect(provider.sent.map((n) => n.pointLotId)).toEqual(["lot-1", "lot-2"]);
  });
});

describe("malformed payloads are handled safely", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["empty object", {}],
    ["missing pointLotId", { customerId: "c", pointsExpiring: 5, expiresAt: "2025-01-31T00:00:00.000Z" }],
    ["negative points", validJob({ pointsExpiring: -5 })],
    ["zero points", validJob({ pointsExpiring: 0 })],
    ["non-integer points", validJob({ pointsExpiring: 1.5 })],
    ["blank customerId", validJob({ customerId: "" })],
    ["non-ISO expiresAt", validJob({ expiresAt: "not-a-date" })],
    ["Date object (not ISO string)", validJob({ expiresAt: new Date() })],
  ];

  for (const [label, data] of cases) {
    it(`skips (${label}) without sending or throwing`, async () => {
      const provider = new RecordingEmailProvider();
      const logger = recordingLogger();

      const outcome = await processPreExpiryEmailJob(data, { provider, logger });

      expect(outcome.status).toBe("skipped_invalid_payload");
      expect(provider.sent).toHaveLength(0);
      expect(logger.warns).toHaveLength(1);
    });
  }

  it("a malformed job in a batch does not stop the worker or crash it", async () => {
    const consumer = fakeConsumer();
    const provider = new RecordingEmailProvider();
    await registerPreExpiryEmailWorker(consumer, { provider, logger: recordingLogger() });

    // Only the valid job should send; the malformed one is skipped, not thrown.
    await expect(
      consumer.captured.handler?.([
        { data: {} },
        { data: validJob({ pointLotId: "lot-ok" }) },
      ]),
    ).resolves.toBeUndefined();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.pointLotId).toBe("lot-ok");
  });
});

describe("provider failure surfaces as a pg-boss retry, not a worker crash", () => {
  it("propagates the provider error out of the handler (so pg-boss retries the job)", async () => {
    const failing: EmailProvider = {
      async sendPreExpiryEmail() {
        throw new Error("ESP 503");
      },
    };
    const consumer = fakeConsumer();
    await registerPreExpiryEmailWorker(consumer, { provider: failing });

    // The handler rejects — pg-boss's own retry policy handles it; the failure
    // is not swallowed and does not otherwise crash the worker process.
    await expect(
      consumer.captured.handler?.([{ data: validJob() }]),
    ).rejects.toThrow("ESP 503");
  });

  it("a later job still processes on a fresh delivery after a provider failure", async () => {
    let calls = 0;
    const flaky: EmailProvider = {
      async sendPreExpiryEmail() {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      },
    };
    const consumer = fakeConsumer();
    await registerPreExpiryEmailWorker(consumer, { provider: flaky });

    await expect(consumer.captured.handler?.([{ data: validJob() }])).rejects.toThrow("transient");
    // pg-boss redelivers; the retry succeeds and does not crash the worker.
    await expect(consumer.captured.handler?.([{ data: validJob() }])).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("LoggingEmailProvider (safe default without a real ESP)", () => {
  it("logs the notification and resolves without throwing", async () => {
    const logger = recordingLogger();
    const provider = new LoggingEmailProvider(logger);

    await expect(
      provider.sendPreExpiryEmail({
        customerId: "cust-1",
        pointLotId: "lot-1",
        pointsExpiring: 42,
        expiresAt: new Date("2025-02-01T00:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();

    expect(logger.infos).toHaveLength(1);
  });

  it("never throws fatally even if the injected logger throws", async () => {
    const brokenLogger: Logger = {
      info() {
        throw new Error("logger down");
      },
      warn() {
        throw new Error("logger down");
      },
      error() {
        throw new Error("logger down");
      },
    };
    const provider = new LoggingEmailProvider(brokenLogger);

    await expect(
      provider.sendPreExpiryEmail({
        customerId: "c",
        pointLotId: "l",
        pointsExpiring: 1,
        expiresAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });

  it("drives the worker green end-to-end as the default provider", async () => {
    const consumer = fakeConsumer();
    const provider = new LoggingEmailProvider(recordingLogger());
    await registerPreExpiryEmailWorker(consumer, { provider });

    await expect(
      consumer.captured.handler?.([{ data: validJob() }, { data: validJob({ pointLotId: "lot-2" }) }]),
    ).resolves.toBeUndefined();
  });
});
