/**
 * Concrete {@link ServiceController} for the metafield rollback (task 33).
 *
 * WHAT THIS IS, HONESTLY
 * ----------------------
 * `runMetafieldRollback` (Req 14.9) calls `stop()` and then `isRunning()`, and
 * ABORTS without touching a single metafield if the service is still running, so
 * the restore can never race the metafield-cache writer. It needs a production
 * implementation of that seam.
 *
 * The Loyalty_Service runs on Render Free and there is NO committed automation
 * that can suspend it (no API key, no deploy hook, no orchestrator). So this
 * controller does not pretend to stop anything:
 *
 *   - {@link OperatorSuspendedServiceController.stop} DOES NOT STOP THE SERVICE.
 *     It cannot. It records/logs that suspension is a MANUAL operator action
 *     (Render dashboard → the service → Suspend, or scale to zero) and returns.
 *   - {@link OperatorSuspendedServiceController.isRunning} PROBES `GET /health`
 *     and returns true if the service answers. This is the part that carries the
 *     real value: it turns "the service is stopped" from an assumption the
 *     operator asserts into a fact that is verified against the live deployment.
 *
 * Consequence, and it is the intended behaviour: rollback FAILS CLOSED. Until the
 * operator has genuinely suspended the service, `isRunning()` keeps answering
 * true and `runMetafieldRollback` keeps returning `aborted_service_running`
 * without writing a single metafield. The rollback becomes possible only once the
 * suspension has actually happened.
 *
 * WHY THREE CONSECUTIVE PROBES
 * ----------------------------
 * A single failed request is not evidence that a service is down — a transient
 * network blip would report "stopped" and unlock the restore while the service
 * was still writing the cache. So "down" requires
 * {@link DEFAULT_REQUIRED_CONSECUTIVE_FAILURES} consecutive failed probes spaced
 * {@link DEFAULT_PROBE_INTERVAL_MS} apart (both configurable). Any single answer
 * short-circuits to "running" immediately — the asymmetry is deliberate: proving
 * "up" needs one observation, concluding "down" needs several.
 *
 * A probe "answers" if an HTTP response comes back AT ALL, including a 5xx: a
 * service returning 503 is still a running process that can write metafields.
 * Only a transport-level failure (connection refused, DNS failure, timeout)
 * counts as a failed probe.
 *
 * SAFETY: this module only issues `GET /health` against the URL it is given. It
 * writes nothing, needs no credentials, and is never wired into `src/index.ts`.
 */
import type { ServiceController } from "./rollback.js";

/** Consecutive failed probes required before concluding the service is down. */
export const DEFAULT_REQUIRED_CONSECUTIVE_FAILURES = 3 as const;

/** Delay between consecutive probes (~2s), so a blip cannot span all of them. */
export const DEFAULT_PROBE_INTERVAL_MS = 2000 as const;

/** Default health path probed. */
export const DEFAULT_HEALTH_PATH = "/health" as const;

/** The notice `stop()` records, verbatim, so the log says exactly what happened. */
export const MANUAL_SUSPENSION_NOTICE: string =
  "stop() did NOT stop the Loyalty_Service: suspension is a MANUAL operator action on Render " +
  "(dashboard → the service → Suspend, or scale to zero). Rollback will keep aborting with " +
  "aborted_service_running until GET /health stops answering.";

/** The minimal response shape the probe reads. */
export interface ProbeResponse {
  readonly ok: boolean;
  readonly status: number;
}

/** The injectable `fetch` seam for the health probe (the Node global satisfies it). */
export type ProbeFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<ProbeResponse>;

/** A pauser between probes; injected so tests run instantly. */
export type ProbeSleeper = (ms: number) => Promise<void>;

/** One probe's outcome, surfaced so an operator sees the evidence, not a verdict. */
export interface ProbeOutcome {
  /** 1-based probe number within this `isRunning()` call. */
  attempt: number;
  /** True when an HTTP response came back at all (service is up). */
  answered: boolean;
  /** HTTP status when the service answered. */
  status: number | null;
  /** Transport-level error message when the probe failed (never a secret). */
  error: string | null;
}

/** Options for {@link OperatorSuspendedServiceController}. */
export interface OperatorSuspendedServiceControllerOptions {
  /** Path probed on the base URL; defaults to `/health`. */
  healthPath?: string;
  /** Consecutive failures required to conclude "down"; defaults to 3. */
  requiredConsecutiveFailures?: number;
  /** Milliseconds between probes; defaults to 2000. */
  probeIntervalMs?: number;
  /** Injected fetch; defaults to the global `fetch`. */
  fetchImpl?: ProbeFetchLike;
  /** Injected sleeper; defaults to real `setTimeout`. */
  sleep?: ProbeSleeper;
  /** Where notices/probe results are recorded; defaults to `console.warn`/`console.log`. */
  log?: (message: string) => void;
  /** Called with each probe outcome, for structured operator output. */
  onProbe?: (outcome: ProbeOutcome) => void;
}

/** Real-time sleeper used in production. */
const realSleep: ProbeSleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Default fetch adapter (module-level so it is not part of the method surface). */
const defaultProbeFetch: ProbeFetchLike = (url, init) =>
  globalThis.fetch(url, init as RequestInit) as unknown as Promise<ProbeResponse>;

/** Joins a base URL and a path without doubling or dropping the slash. */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * A {@link ServiceController} that verifies suspension instead of performing it.
 *
 * Only two methods exist — `isRunning` and `stop` — matching the interface
 * exactly; a test asserts that runtime surface.
 */
export class OperatorSuspendedServiceController implements ServiceController {
  private readonly healthUrl: string;
  private readonly requiredConsecutiveFailures: number;
  private readonly probeIntervalMs: number;
  private readonly fetchImpl: ProbeFetchLike;
  private readonly sleep: ProbeSleeper;
  private readonly log: (message: string) => void;
  private readonly onProbe: ((outcome: ProbeOutcome) => void) | undefined;

  constructor(baseUrl: string, options: OperatorSuspendedServiceControllerOptions = {}) {
    if (!baseUrl) {
      throw new Error(
        "A base URL is required so the controller can probe /health; without it, " +
          "'is the service stopped?' would be an assumption again.",
      );
    }
    this.healthUrl = joinUrl(baseUrl, options.healthPath ?? DEFAULT_HEALTH_PATH);
    this.requiredConsecutiveFailures =
      options.requiredConsecutiveFailures ?? DEFAULT_REQUIRED_CONSECUTIVE_FAILURES;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.fetchImpl = options.fetchImpl ?? defaultProbeFetch;
    this.sleep = options.sleep ?? realSleep;
    this.log = options.log ?? ((message: string) => console.warn(message));
    this.onProbe = options.onProbe;
  }

  /**
   * Records that suspension is a manual operator action and returns. It stops
   * NOTHING — see the module header. Rollback then aborts on `isRunning()` until
   * the operator has genuinely suspended the service.
   */
  async stop(): Promise<void> {
    this.log(`${MANUAL_SUSPENSION_NOTICE} (health probe target: ${this.healthUrl})`);
  }

  /**
   * Probes `GET /health`. Returns true as soon as ANY probe answers; returns
   * false only after {@link requiredConsecutiveFailures} consecutive probes fail,
   * spaced {@link probeIntervalMs} apart, so a transient blip cannot be mistaken
   * for a suspended service.
   */
  async isRunning(): Promise<boolean> {
    for (let attempt = 1; attempt <= this.requiredConsecutiveFailures; attempt++) {
      let outcome: ProbeOutcome;
      try {
        const res = await this.fetchImpl(this.healthUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        // Any HTTP answer — including 5xx — means a live process is there.
        outcome = { attempt, answered: true, status: res.status, error: null };
      } catch (err) {
        outcome = {
          attempt,
          answered: false,
          status: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      this.onProbe?.(outcome);

      if (outcome.answered) {
        this.log(
          `Health probe ${attempt}/${this.requiredConsecutiveFailures} ANSWERED ` +
            `(HTTP ${String(outcome.status)}): the service is still running.`,
        );
        return true;
      }

      this.log(
        `Health probe ${attempt}/${this.requiredConsecutiveFailures} failed ` +
          `(${outcome.error ?? "no response"}).`,
      );

      if (attempt < this.requiredConsecutiveFailures) {
        await this.sleep(this.probeIntervalMs);
      }
    }

    this.log(
      `${this.requiredConsecutiveFailures} consecutive health probes failed: treating the ` +
        `service as stopped.`,
    );
    return false;
  }
}
