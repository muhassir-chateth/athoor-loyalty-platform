/**
 * Pluggable transactional email / ESP provider for pre-expiry notifications
 * (task 10.2, assumption A5 — the ESP is TBC and modelled as an injectable
 * dependency).
 *
 * The pre-expiry sweep ({@link import("./preExpiryNotify.js").runPreExpiryNotify})
 * enqueues one `preExpiryEmail` job per qualifying lot (queue name
 * {@link PRE_EXPIRY_NOTIFY_JOB}). This module is the CONSUMER side of that queue:
 * a worker that validates each delivered job and hands it to an injected
 * {@link EmailProvider}. It sends nothing itself.
 *
 * Two provider concerns are deliberately separated:
 *   1. {@link EmailProvider} — the pluggable boundary to the ESP. A real
 *      HTTP-based provider (SendGrid/Postmark/SES/etc.) can be added later
 *      without touching the worker; it just implements this one method.
 *   2. {@link LoggingEmailProvider} — the SAFE DEFAULT used when no real ESP is
 *      configured. It only logs and NEVER throws fatally, so the whole system
 *      boots and runs green without any ESP wired up.
 *
 * DELIVERY / RETRY SEMANTICS:
 *   - A MALFORMED job payload is a poison message: it is logged and SKIPPED
 *     (never re-thrown) so it cannot retry forever and cannot crash the worker.
 *   - A provider FAILURE (a real ESP rejecting) propagates out of the handler so
 *     pg-boss applies its own retry policy. The worker process itself is never
 *     brought down — the only effect is a pg-boss retry.
 *
 * SAFETY: this module touches no live/production system on its own. Real mail is
 * only ever sent through an injected {@link EmailProvider}; the default provider
 * logs and does nothing else. Every path is unit-tested with a fake consumer and
 * a recording provider.
 */
import { z } from "zod";
import {
  PRE_EXPIRY_NOTIFY_JOB,
  type PreExpiryNotification,
} from "./preExpiryNotify.js";

/**
 * The pluggable boundary to the ESP. Production supplies an implementation that
 * dispatches a transactional pre-expiry email (customer + expiring amount +
 * expiry date); tests supply a recording fake; when no ESP is configured the
 * safe {@link LoggingEmailProvider} default is used.
 *
 * The payload is the same {@link PreExpiryNotification} the sweep produced, so
 * an implementation has the customer, the expiring amount and the expiry date.
 */
export interface EmailProvider {
  sendPreExpiryEmail(notification: PreExpiryNotification): Promise<void>;
}

/**
 * A minimal, injectable logging surface (defaults to `console`). Kept structural
 * so a real app logger (pino/fastify's `log`) satisfies it without a hard
 * dependency, and so tests can assert what was logged.
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** The default logger — thin wrapper over `console`. */
export const consoleLogger: Logger = {
  info(message, meta) {
    if (meta) console.info(message, meta);
    else console.info(message);
  },
  warn(message, meta) {
    if (meta) console.warn(message, meta);
    else console.warn(message);
  },
  error(message, meta) {
    if (meta) console.error(message, meta);
    else console.error(message);
  },
};

/**
 * The SAFE DEFAULT provider used when no real ESP is configured. It only logs
 * the intent to send and NEVER throws fatally — even if the injected logger
 * itself misbehaves — so the system can run end-to-end without an ESP.
 */
export class LoggingEmailProvider implements EmailProvider {
  constructor(private readonly logger: Logger = consoleLogger) {}

  async sendPreExpiryEmail(notification: PreExpiryNotification): Promise<void> {
    try {
      this.logger.info(
        "[preExpiryEmail] no ESP configured — logging pre-expiry notification instead of sending",
        {
          customerId: notification.customerId,
          pointLotId: notification.pointLotId,
          pointsExpiring: notification.pointsExpiring,
          expiresAt: notification.expiresAt.toISOString(),
        },
      );
    } catch {
      // A no-op default must never bring down the worker. Swallow any logger
      // failure: there is no real side-effect to protect here.
    }
  }
}

/**
 * A recording provider — the fake used by tests (and a safe in-memory default).
 * Records each notification it is asked to send so callers/tests can assert
 * exactly one send per delivered job with the correct amount and date.
 */
export class RecordingEmailProvider implements EmailProvider {
  readonly sent: PreExpiryNotification[] = [];
  async sendPreExpiryEmail(notification: PreExpiryNotification): Promise<void> {
    this.sent.push({ ...notification });
  }
}

/**
 * Zod schema for the RAW `preExpiryEmail` job payload as published by
 * {@link import("./preExpiryNotify.js").PgBossPreExpiryNotifier} — note
 * `expiresAt` arrives as an ISO-8601 string (it was serialised with
 * `Date#toISOString()` before enqueue), and `pointsExpiring` is a positive
 * whole number of points.
 */
export const preExpiryEmailJobSchema = z.object({
  customerId: z.string().min(1),
  pointLotId: z.string().min(1),
  pointsExpiring: z.number().int().positive(),
  expiresAt: z.string().datetime(),
});

/** The validated raw job payload shape. */
export type PreExpiryEmailJob = z.infer<typeof preExpiryEmailJobSchema>;

/** Rehydrates a validated job payload into the sweep's domain notification. */
function toNotification(job: PreExpiryEmailJob): PreExpiryNotification {
  return {
    customerId: job.customerId,
    pointLotId: job.pointLotId,
    pointsExpiring: job.pointsExpiring,
    expiresAt: new Date(job.expiresAt),
  };
}

/** Dependencies for {@link processPreExpiryEmailJob} / the worker. */
export interface PreExpiryEmailWorkerDeps {
  /** The pluggable ESP boundary (A5). Defaults to {@link LoggingEmailProvider} at the call site. */
  provider: EmailProvider;
  /** Injectable logger for skipped/poison payloads (defaults to {@link consoleLogger}). */
  logger?: Logger;
}

/** The outcome of processing one `preExpiryEmail` job. */
export type PreExpiryEmailJobOutcome =
  | { status: "sent"; notification: PreExpiryNotification }
  | { status: "skipped_invalid_payload"; issues: string };

/**
 * Processes ONE `preExpiryEmail` job:
 *   1. validates the raw payload with {@link preExpiryEmailJobSchema}; a
 *      malformed payload is a poison message — it is logged and SKIPPED (never
 *      re-thrown) so it neither retries forever nor crashes the worker, then
 *   2. hands the rehydrated {@link PreExpiryNotification} to the injected
 *      {@link EmailProvider} (exactly one send per delivered valid job).
 *
 * A provider failure is intentionally NOT caught here: it propagates so pg-boss
 * can apply its retry policy. The safe default provider never throws, so a
 * system without a real ESP always resolves `sent`.
 */
export async function processPreExpiryEmailJob(
  data: unknown,
  deps: PreExpiryEmailWorkerDeps,
): Promise<PreExpiryEmailJobOutcome> {
  const logger = deps.logger ?? consoleLogger;
  const parsed = preExpiryEmailJobSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    // Poison message: skip safely, do NOT re-throw (that would retry forever).
    try {
      logger.warn("[preExpiryEmail] skipping malformed job payload", { issues });
    } catch {
      // Logging must never turn a skip into a crash.
    }
    return { status: "skipped_invalid_payload", issues };
  }

  const notification = toNotification(parsed.data);
  await deps.provider.sendPreExpiryEmail(notification);
  return { status: "sent", notification };
}

/**
 * A minimal structural view of the job queue's consumer side (pg-boss `work`),
 * declared locally so wiring the worker does not hard-couple to pg-boss types
 * (mirrors {@link import("../shopify/metafieldCache.js").MetafieldCacheJobConsumer}
 * and the discount-code worker).
 */
export interface PreExpiryEmailJobConsumer {
  work(
    name: string,
    handler: (jobs: Array<{ data: unknown }>) => Promise<void>,
  ): Promise<string>;
}

/**
 * Registers the worker that consumes the `preExpiryEmail` queue
 * ({@link PRE_EXPIRY_NOTIFY_JOB}). Each delivered job is processed by
 * {@link processPreExpiryEmailJob}, which validates the payload and calls the
 * injected {@link EmailProvider}. Registration is intentionally thin — the
 * queue's own retry policy layers on top of a provider failure; all validation
 * and the send live in {@link processPreExpiryEmailJob}, which is unit-tested
 * directly.
 */
export async function registerPreExpiryEmailWorker(
  consumer: PreExpiryEmailJobConsumer,
  deps: PreExpiryEmailWorkerDeps,
  queueName: string = PRE_EXPIRY_NOTIFY_JOB,
): Promise<string> {
  return consumer.work(queueName, async (jobs) => {
    for (const job of jobs) {
      await processPreExpiryEmailJob(job.data, deps);
    }
  });
}
