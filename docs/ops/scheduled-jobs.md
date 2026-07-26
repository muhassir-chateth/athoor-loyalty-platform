# Running scheduled jobs reliably in production

Task 24 of Phase 5. Decides how `runExpiryScan`, `reconcileCaches` and
`refreshAnalyticsAggregates` fire dependably once the platform is live.

> **SUPERSEDED.** This document recommended an always-on paid instance. A
> subsequent decision made zero-cost operation a hard requirement, so the
> recommendation no longer applies — see
> [`zero-cost-architecture.md`](./zero-cost-architecture.md).
>
> The pg-boss verification below is still authoritative and is the foundation of
> that redesign; the option comparison is retained for the record.

## The three jobs

| Schedule | Purpose | Consequence if it never runs |
|---|---|---|
| `runExpiryScan` | Daily FIFO expiry scan + pre-expiry notification sweep (Req 5.2–5.5) | Points never expire, so the 12-month window is unenforced and members are never warned before expiry |
| `reconcileCaches` | Recompute cached balances/tiers and repair Metafield_Cache drift from the ledger (Req 1.7, 13.7) | Cached values and storefront metafields drift from the ledger with no self-healing |
| `refreshAnalyticsAggregates` | Refresh the three analytics materialized views at least hourly (Req 20.3) | Admin analytics silently serve stale figures behind their `computedAt` timestamp |

All three are registered in `pgboss.schedule` and were confirmed present on
staging. The ledger stays correct regardless — these jobs affect enforcement,
cache convergence and reporting, not ledger integrity.

## Verified: pg-boss does NOT catch up a missed schedule

Read from the installed source, `pg-boss@10.4.2`, `src/timekeeper.js`:

```js
shouldSendIt (cron, tz) {
  const interval = cronParser.parseExpression(cron, { tz })
  const prevTime = interval.prev()
  const databaseTime = Date.now() + this.clockSkew
  const prevDiff = (databaseTime - prevTime.getTime()) / 1000
  return prevDiff < 60
}
```

A schedule fires only when its most recent cron occurrence was **less than 60
seconds ago**. `onCron` evaluates this on an interval (`cronMonitorIntervalSeconds`,
capped at 45s) and only while the process is alive; queued sends are further
debounced with `singletonSeconds: 60`.

So when the process is asleep as a window elapses, on wake `interval.prev()` is
more than 60 seconds in the past, `shouldSendIt` returns false, and **the run is
skipped silently and never replayed**. There is no catch-up, no backlog, and no
error — which is exactly why the missed staging runs were invisible.

Our `createQueue` passes no overrides, so these defaults apply (`config.schedule`
defaults to `true`).

**Why this is decisive.** On the current Free instance the host spins down after
15 minutes without inbound traffic. A daily expiry scan therefore only runs if
the instance happens to be awake within ~60 seconds of that instant. Overnight,
with no storefront traffic, it essentially never will. This is not a tuning
problem — a schedule-driven design on an idling host cannot work.

Render's own guidance is explicit that Free instances are not for production, and
they may also be restarted at any time.

## Options

Prices are Render's published rates as of this evaluation (USD, prorated by the
second). Workspace plan is billed separately from compute: Hobby $0/mo, Pro
$25/mo.

### Option 1 — Always-on paid instance

Move the web service off Free so the process never idles out and pg-boss keeps
its own schedules.

- **Cost** — Starter $7/mo (512 MB, 0.5 CPU) or Standard $25/mo (2 GB, 1 CPU), on top of the workspace plan. Supabase Postgres is unchanged.
- **Complexity** — one setting change. No new services, no new credentials, no new failure modes.
- **Reliability** — schedules fire as designed. A deploy or platform restart can still clip a window, since pg-boss will not replay it; the daily jobs are idempotent, so the following day self-corrects, and analytics refreshes hourly. Also unlocks shell access and one-off jobs, which Free withholds and which the M0–M2 runbook (task 26) will want.
- **Security** — nothing new exposed. No additional secrets, no new inbound surface.
- **Code changes** — **none.**

### Option 2 — Free instance + external scheduler

Keep the host on Free and have an outside scheduler (GitHub Actions, cron-job.org, a Render Cron Job) call trigger endpoints.

- **Cost** — near zero. A Render Cron Job at Starter is $0.00016/min; the ~780 short runs a month needed here land inside the $1/mo floor. GitHub Actions is free within included minutes.
- **Complexity** — a second system to configure, monitor and keep credentialed, plus its own failure mode when the scheduler itself is silently disabled or throttled. GitHub Actions cron is explicitly best-effort and can be delayed under load or disabled after repository inactivity.
- **Reliability** — the weakest option, and not only because of the scheduler. Each trigger must first wake the instance, roughly a minute of cold start; Render may suspend a Free service for high service-initiated traffic; and Free services can be restarted arbitrarily. It also contradicts the platform's stated guidance for production.
- **Security** — worse. Expiry and analytics have no trigger endpoints today, so we would add new authenticated mutating endpoints reachable from the public internet and share the admin credential with an external system. That widens the attack surface for the sake of a few dollars.
- **Code changes** — **real work.** New trigger endpoints for the expiry scan and the analytics refresh (only reconciliation exists today, via `POST /v1/admin/operations/reconciliation`), their auth, tests, and the workflow definitions.

### Option 3 — Paid instance plus an external watchdog

Option 1 for execution, with an outside check that alerts when a schedule has not run inside its expected window.

- **Cost** — Option 1's compute plus ~$0 for the watchdog.
- **Complexity** — modest and additive. It never participates in execution, so it cannot break a job; it only observes.
- **Reliability** — the strongest, and it closes the one real gap in Option 1: because pg-boss skips silently, a schedule that stops firing is currently invisible. `analytics_aggregate_refresh.refreshed_at` already exposes a last-run timestamp; expiry and reconciliation do not record one yet.
- **Security** — a read-only health endpoint exposing last-run timestamps and no customer data. Modest and containable.
- **Code changes** — small: record a last-run timestamp per schedule and expose it for monitoring. Naturally pairs with task 23, which is already adding processing-state traceability.

## Recommendation

**Adopt Option 1 now — move the web service to the Starter instance at $7/mo —
and treat Option 3's watchdog as the follow-up once task 23 lands.**

Reasoning, given the brief of operational simplicity and reliability over lowest
cost:

1. The verified pg-boss behaviour makes an always-on process a *requirement*, not a preference. Skipped windows are never replayed, so any design that lets the process idle silently drops expiry runs.
2. Option 1 needs no code, no new credentials and no second system. Option 2 spends engineering effort and widens the security surface to save roughly $7 a month, which inverts the stated priority.
3. Starter's 512 MB / 0.5 CPU is comfortable for this workload — a few dozen customers, webhook-driven writes, three light schedules. Standard at $25/mo is the upgrade path if memory or CPU metrics say otherwise; that is one setting away and prorated by the second.
4. Option 3 is the right destination but not a blocker. Its value is *observability* of schedules, and it composes cleanly with task 23 rather than competing with it.

Expected steady-state cost: **$7/mo compute on a Hobby workspace**, or $32/mo if
you also want the Pro workspace for longer log retention and a second seat.

## Decisions needed

1. Approve moving the web service to **Starter ($7/mo)**, or prefer Standard ($25/mo) for headroom.
2. Workspace plan: stay on **Hobby ($0)**, accepting 7-day log retention and a single seat, or move to **Pro ($25/mo)**. For a production loyalty platform 7-day log retention is on the short side for incident forensics.
3. Confirm the watchdog is deferred to a follow-up task rather than bundled here.

## Residual risks after Option 1

- A deploy or platform restart can still clip a schedule window, and pg-boss will not replay it. The daily jobs are idempotent so the next day corrects itself; the practical exposure is one delayed day of expiry, which is acceptable against a 12-month window. Worth stating plainly in the runbook rather than assuming exactly-once execution.
- Schedules failing remains **unobserved** until the watchdog exists. This is the main reason not to leave Option 3 indefinitely.
- Unrelated but adjacent: `createQueue` builds pg-boss's connection without TLS options, so it currently relies on the global `NODE_TLS_REJECT_UNAUTHORIZED=0` set for the Supabase pooler. That is a staging workaround and should be replaced with a pinned CA before production. Tracked separately from this task.
