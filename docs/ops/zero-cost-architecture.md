# Zero-cost production architecture — design proposal

Task 24, redesigned with **"the platform must cost $0/month to operate"** as a
hard requirement. Supersedes the paid-instance recommendation in
[`scheduled-jobs.md`](./scheduled-jobs.md); that document's pg-boss findings
still stand and are the basis for this design.

**Status: proposal only. No code, spec or infrastructure has been changed.**

## The core problem, restated

From `pg-boss@10.4.2` source (`src/timekeeper.js`), a schedule fires only when
its previous cron occurrence is **under 60 seconds old**, evaluated only while
the process is alive. A window that elapses during sleep is skipped silently and
never replayed.

On a free host that sleeps after 15 idle minutes, a 02:00 daily scan therefore
almost never runs. **A cron-window design is fundamentally incompatible with a
sleeping host** — so the fix is not a better scheduler, it is to stop depending
on cron windows.

### The insight the design rests on

pg-boss has two mechanisms with opposite durability:

| Mechanism | Behaviour when the process is asleep |
|---|---|
| **Cron schedule** (`boss.schedule`) | Window evaluated in memory → **lost forever** |
| **Queued job** (`pgboss.job` row) | Row persists in Postgres → **drains on next wake** |

Every scheduled job today uses the first. If time-triggered work instead becomes
*due work derived from a persisted last-run timestamp*, then nothing is ever
lost — only **delayed** until the next wake. Delay is a trade-off we can reason
about and bound; silent loss is not.

## Audit of every scheduled and background job

Inventory taken from the code: three cron schedules and four queues.

### 1. `runExpiryScan` — cron `0 2 * * *`

**Why scheduled.** Expiry is time-based: a lot matures 12 months after earning,
and Req 5.2 wants one negative expiry entry per matured lot, zeroing its
remainder.

**Can it be event-driven?** Yes, as due work — and it is far less critical than
it appears. **Spendable_Balance already excludes expired lots at read time**, via
`expires_at IS NULL OR expires_at > now()`. So a member can never spend expired
points even if the scan never runs. The scan writes *bookkeeping*: the ledger
history entry and the zeroed remainder. It is also already idempotent per lot
(Property 9), so running it late, or twice, or for several missed days at once,
is safe.

**Trade-off.** The expiry ledger entry may appear hours late in a member's
history. Against a 12-month window, immaterial. Spec wording that promises a
daily scan needs softening.

### 2. `reconcileCaches` — cron `0 3 * * *`

**Why scheduled.** Safety net recomputing cached balances/tiers and repairing
Metafield_Cache drift from the ledger (Req 1.7, 13.7).

**Can it be event-driven?** Largely already is. The Finding 3 work made every
committed balance change enqueue a cache refresh for that customer, so drift is
now corrected at source rather than waiting for the nightly sweep. The full
sweep becomes a genuine backstop: run it as due work on wake, plus the existing
`POST /v1/admin/operations/reconciliation` for on-demand use.

**Trade-off.** Req 13.7's "at least once every 24 hours" becomes best-effort.
Because the per-change refresh now exists, the sweep's practical value is
catching writes lost to an Admin API outage — rare, and self-correcting on the
next run.

### 3. `refreshAnalyticsAggregates` — hourly

**Why scheduled.** Keeps three materialized views fresh for admin analytics
(Req 20.3), which reports a `computedAt` timestamp.

**Can it be event-driven?** Yes — and this schedule can be **deleted outright**.
Analytics has exactly one consumer: an admin opening the dashboard. Refresh
lazily on read when the views are older than the freshness budget, then serve.
`analytics_aggregate_refresh.refreshed_at` already records the last refresh, so
the staleness check needs no new state.

**Trade-off.** The first admin request after a quiet period pays the refresh
cost. On this data volume that is a sub-second concern. Strictly *better* than
today: figures are guaranteed fresh at read time rather than up to an hour old.

### 4. Pre-expiry notification sweep (inside `runExpiryScan`)

**Why scheduled.** Must warn a member while their lot is still inside the
configured window before expiry (default 30 days).

**Can it be event-driven?** Only as due work — this is the one genuinely
time-sensitive item. It is per-lot deduplicated, so a late run still notifies
rather than skipping. With a 30-day window and daily-ish wakes, a delay of hours
consumes a negligible slice of the window.

**Trade-off.** No guaranteed notification *time*. If the service were unreachable
for the entire remaining window, a warning could be missed — bounded by the
pinger's reliability, below.

### 5–8. Event-driven queues — `webhook.process`, `generateDiscountCode`, `writeMetafieldCache`, `preExpiryEmail`

**Already event-driven and already durable.** Each is a `pgboss.job` row created
by a request or webhook, so it survives sleep and drains on wake. No redesign
needed.

Worth noting they are *unaffected* by the host sleeping in the cases that matter:
a redemption enqueues its discount-code job during a request, while the process
is necessarily awake, so minting still happens immediately and Req 3.8's
"visible within 10 seconds" holds.

## What cannot remain fully automatic — and honestly cannot be free

Three items where a free architecture forces a real reduction in guarantee, not
just a change of mechanism.

### Backups and point-in-time recovery — Req 13.6 **cannot be met**

Req 13.6 requires PITR, automated backups and WAL retention ≥ 7 days. Per
Supabase's pricing and docs, the free plan has **no backup retention and no
PITR**, and free projects are **paused after one week of inactivity** (recoverable,
but offline). This is the hardest conflict in the whole proposal: it is a data-loss
exposure, not an inconvenience.

*Best free mitigation:* a scheduled `pg_dump` from a free CI runner, retained as
a build artifact. That converts the guarantee from point-in-time recovery to
**recovery to the last dump**, so the RPO becomes the dump interval (e.g. 24h)
instead of near-zero. For a loyalty ledger — the authoritative record of what
members are owed — losing up to a day of entries is a real business risk that
should be an explicit, documented acceptance rather than an oversight.

### Guaranteed execution *time*

Free hosting cannot promise that anything happens at 02:00. Everything becomes
"soon after the next wake". Acceptable for expiry bookkeeping and reconciliation;
it is the pre-expiry notification whose value is most time-shaped.

### Cold-start latency versus Req 8.1

Req 8.1 gives the dashboard a 3-second budget. A cold start takes roughly a
minute, so the first visit after idle blows that budget badly. This is
addressable by keeping the service warm — but warmth costs free instance-hours,
which is the binding constraint below.

## The free-hours budget — the real design constraint

Render grants **750 free instance-hours per workspace per month**, and a free
service consumes them only while running. Exhausting them **suspends all free
web services until the next month** — a total outage, self-inflicted by
over-pinging. A month is ~730 hours, so "always warm" sits at ~730/750: it fits,
barely, with no room for a second service and no margin for error.

| Ping cadence | Hours/month | Dashboard cold starts | Free-hour headroom |
|---|---|---|---|
| Every 10 min (always warm) | ~730 | None | ~20h — dangerously thin |
| Every 10 min, 07:00–23:00 only | ~490 | Only outside trading hours | Comfortable |
| Hourly, 24/7 | ~180 | Frequent (each wake ~1 min) | Large |

**Recommended: warm during trading hours, sleep overnight.** Members browse in
the daytime, so Req 8.1 is met when it matters; the overnight sleep is exactly
when expiry and reconciliation would have run, and those become catch-up-on-wake
work anyway.

## Proposed architecture

Five parts, all free, no new mutating public endpoints.

1. **Render Free web service** — unchanged.
2. **A free external pinger** — Cloudflare Cron Triggers, GitHub Actions cron, or cron-job.org calling `GET /health` on the cadence above. `/health` is already public and **side-effect-free**: it wakes the process and nothing more.
3. **An internal due-work evaluator** — replaces pg-boss cron. On boot and on an interval while awake, read a small `scheduled_runs` table (`job_name`, `last_run_at`), and for any job past its interval enqueue the existing pg-boss job. The existing handlers are untouched and already idempotent.
4. **Lazy analytics refresh** — drop the hourly schedule; refresh on admin read when `refreshed_at` is older than the freshness budget.
5. **Free logical backups** — scheduled `pg_dump` on a free CI runner, retained as an artifact, with the Req 13.6 deviation documented and accepted.

Optionally the same pinger doubles as the **watchdog**: have `/health` report whether any job is overdue, and let the ping fail loudly when it is. Free, and it closes the silent-failure gap that made the staging misses invisible.

### Why this preserves the existing security model

- The externally-called endpoint stays `GET /health` — public, read-only, no customer data, no state change. Nothing new is exposed.
- **No admin credential leaves the platform.** Scheduling decisions are made *inside* the service from its own timestamps; the pinger cannot choose what runs.
- No new authenticated mutating endpoints, which is what Option 2 of the earlier evaluation would have required.
- One genuine caveat: the backup workflow needs the database URL as a CI secret. That is a new location for a high-value credential. If you would rather not, run the dump from a local machine or the operator toolchain instead and keep the credential off CI entirely.

## Recommended specification changes

Proposed, not applied. All are relaxations of *timing*; none weakens ledger
integrity, and no correctness property (1–17) changes.

| Requirement | Current | Proposed |
|---|---|---|
| 5.2 / 5.3 | Daily expiry scan | Runs at least once per day **when the service is reachable**; missed days are caught up on the next start; each lot still expires at most once (Property 9 unchanged) |
| 5.4 | Sweep enqueues one notification per qualifying lot | Unchanged in substance; timing becomes best-effort within the pre-expiry window |
| 13.6 | PITR, automated backups, WAL ≥ 7 days | **Explicit deviation** on the free plan: periodic logical backups with an RPO equal to the dump interval; PITR requires a paid database |
| 13.7 | Reconciliation at least every 24 hours | Per-change cache refresh (already implemented) plus a best-effort full sweep on wake and on demand |
| 20.3 | Hourly refreshed cached aggregates | Refreshed on read when stale, bounded by a freshness budget; `computedAt` semantics unchanged |
| 8.1 | Dashboard within 3 seconds | Add a cold-start caveat: met while warm; a first visit after idle incurs host spin-up |

I would also add an assumption recording that the platform targets zero-cost
hosting and therefore provides **best-effort scheduling with at-least-once,
catch-up-on-wake semantics** — so future readers understand the timing wording is
deliberate.

## Risks

| Risk | Severity | Notes |
|---|---|---|
| No PITR; up to one dump interval of ledger loss | **High** | The only unmitigable item. Needs explicit business acceptance, or a paid database (~$6/mo is the cheapest path to backups) |
| Free-hour exhaustion suspends the service for the rest of the month | **High** | Entirely avoidable with a conservative ping cadence, but must be budgeted and monitored |
| Pinger becomes a single point of failure | Medium | If it dies, nothing runs and Supabase eventually pauses the project after 7 days idle. The watchdog mitigates detection, not the dependency |
| Render may restart or suspend a free service at any time | Medium | Platform-documented. Durable queues mean work resumes rather than being lost |
| Cold-start latency on the storefront | Medium | Mitigated during trading hours; unavoidable outside them |
| No shell or one-off jobs on free instances | Low | Affects task 26's runbook; the operator scripts can run from a local machine against the database instead |

## Honest recommendation

This design meets the $0 requirement and is materially *more* robust than what is
deployed today, because it removes the silent-loss failure mode entirely: work
becomes durable and catch-up rather than fire-and-forget. Expiry, reconciliation
and analytics all survive a sleeping host.

The one place I would push back is **Req 13.6**. Everything else here is a
defensible engineering trade — timing precision for cost. Backups are different
in kind: a loyalty ledger is the record of what you owe your members, and the
free plan keeps no backups at all. If any part of this budget can flex, the
cheapest paid Postgres (~$6/mo) buys backup retention and removes both the
data-loss exposure and the 7-day pause risk. That is my recommendation to
consider alongside the zero-cost build — not because the free design fails, but
because that specific risk is the one that cannot be engineered away.

## Implementation sketch, if approved

Roughly, in dependency order — no work started:

1. `scheduled_runs` table plus the due-work evaluator; migrate the three schedules onto it and stop registering pg-boss cron.
2. Lazy analytics refresh on read; delete the hourly schedule.
3. Overdue reporting on `/health` (composes with task 23's traceability work).
4. Pinger configuration, committed as code so it is reviewable.
5. Backup workflow, plus the documented Req 13.6 deviation.
6. Spec updates from the table above, mirrored into `docs/specs/`.
