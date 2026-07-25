# Athoor Loyalty Service

Standalone loyalty microservice for Athoor London (`myathoorlondon.myshopify.com`).
Node.js + TypeScript + Fastify, with PostgreSQL as the single source of truth via
an immutable ledger. This is **local code scaffolding only** — it does not touch
the live Shopify store, live metafields, or any production database.

> Status: task **1.2 — Immutable ledger schema migration**. The project skeleton
> (task 1.1) plus the ledger-core schema migration are in place. Business logic
> (ledger repository, earning, redemption, …) is added by later tasks.

## Database schema (task 1.2)

`migrations/*_create-ledger-core.ts` is a `node-pg-migrate` migration that creates
the seven core tables exactly as specified in `design.md` → *Data Models*:
`customers`, `ledger_entries`, `point_lots`, `redemptions`, `discount_codes`,
`webhook_events`, `referrals` — with the indexes (`idx_ledger_customer`,
`idx_lots_fifo`, `idx_lots_expiry`) and the CHECK / UNIQUE constraints
(`original_points > 0`, `remaining_points >= 0`, `remaining_points <= original_points`,
`referrer_id <> referred_id`, `UNIQUE (customer_id, idempotency_key)`, unique
`shopify_webhook_id`, unique `shopify_customer_id`). A `down` migration tears the
schema down in reverse dependency order.

Apply it at deploy time against the target Postgres:

```bash
npm run migrate:up      # apply
npm run migrate:down    # roll back one step
```

**No live/production database is touched by this repo.** Because no local Postgres
or Docker is available in this environment, the schema is verified without a live
DB by `src/migrations.test.ts`, which runs the migration's `up`/`down` against a
capturing builder and asserts the emitted DDL matches the design (all tables,
indexes, and constraints). Applying against real Postgres is deferred to deploy time.

## Stack

- **Runtime:** Node.js v24.x
- **Web framework:** Fastify 5
- **Validation:** zod
- **Database:** PostgreSQL via `pg`; migrations via `node-pg-migrate`
- **Job queue:** `pg-boss` (backed by Postgres — no extra infra)
- **Tests:** Vitest (+ `fast-check` for property tests in later tasks)

## Scripts

```bash
npm install          # install dependencies
npm run build        # typecheck + compile to dist/
npm run typecheck    # typecheck only (no emit)
npm start            # run the compiled service (dist/index.js)
npm run dev          # run from source with --watch
npm test             # run the test suite (vitest run)
npm run migrate      # node-pg-migrate CLI (schema added in task 1.2)
```

## Configuration & secrets

All secrets load from the environment (or a secrets manager) — never committed
(Requirement 11.6). Copy `.env.example` to `.env` and fill in real values locally.

| Variable | Purpose |
|---|---|
| `SHOPIFY_ADMIN_API_TOKEN` | Admin API token for the dedicated custom app |
| `SHOPIFY_WEBHOOK_SECRET` | Verifies inbound webhook HMAC-SHA256 signatures |
| `SHOPIFY_APP_PROXY_SECRET` | Verifies signed App Proxy storefront requests |
| `DATABASE_URL` / `PG*` | PostgreSQL connection credentials |

Guardrails enforced at boot:

- **HTTPS (Req 11.11):** `REQUIRE_HTTPS` must be `true` in production.
- **No MCP token reuse (Req 11.7):** a `shpat_`-prefixed Admin token is rejected
  in production. Do **not** reuse the local MCP token from
  `.kiro/settings/mcp.json`.

### Least-privilege Admin API scopes (Req 11.11)

Defined as configuration in `src/config.ts` (`ADMIN_API_SCOPES`):
`read_customers`, `read_orders`, `read_products`, `write_discounts`,
`write_price_rules`, plus webhook subscription scopes for
`customers/create`, `orders/paid`, `refunds/create`, `orders/cancelled`.

> No Shopify app is created and no webhooks are registered by this task — that is
> task 3.2. The scope/topic lists here are configuration/documentation only.

## Versioned `/v1` API (Req 9.1, 9.8)

- Every loyalty operation is mounted under `/v1` (breaking changes reserved for
  a future `/v2`; within-`v1` changes are additive-only).
- Request handling is stateless (no session state).
- A version identifier is emitted on **every** JSON response, two ways:
  - the `x-api-version` response header, and
  - an `apiVersion` field injected into every JSON object payload.

Endpoints available after this task:

- `GET /health` — liveness/readiness probe.
- `GET /v1/version` — version discovery.

## Project layout

```
loyalty-service/
├── src/
│   ├── index.ts              # entrypoint (listen + graceful shutdown)
│   ├── app.ts                # Fastify app builder (health + /v1 mount)
│   ├── config.ts             # env/secrets loading + scopes + guardrails
│   ├── version.ts            # API version identifier constants
│   ├── db.ts                 # PostgreSQL pool factory
│   ├── queue.ts              # pg-boss job-queue factory
│   ├── plugins/versioning.ts # version identifier on every response
│   ├── routes/v1.ts          # versioned /v1 router
│   ├── app.test.ts           # boot + /v1 version identifier test
│   └── config.test.ts        # config + security guardrail tests
├── migrations/               # node-pg-migrate migrations (task 1.2)
├── .env.example              # placeholders only — never commit real secrets
└── ...
```

## Backup & point-in-time recovery (task 12.2, Req 13.6)

The PostgreSQL deployment must have **point-in-time recovery (PITR)** and
**automated backups** enabled with **WAL retention of at least 7 days**
(`design.md` → *Reliability → Backup & recovery*). Because this is a property of
the managed database deployment, `src/reliability/backupVerification.ts` verifies
it as **configuration**, without connecting to, restoring, or mutating any live
database:

- `REQUIRED_BACKUP_SPEC` — the required settings: PITR on, daily automated
  backups (`≤ 24h` interval), and WAL + backup retention `≥ 7 days`.
- `verifyBackupConfiguration(provider, spec?)` — reads current settings from an
  injectable `BackupStatusProvider` and returns a pass/fail result listing every
  unmet requirement (`PITR_DISABLED`, `AUTOMATED_BACKUPS_DISABLED`,
  `BACKUPS_NOT_DAILY`, `WAL_RETENTION_TOO_SHORT`, `BACKUP_RETENTION_TOO_SHORT`).
- `assertBackupConfiguration(...)` — the same check but throws a descriptive
  Req 13.6 error, for boot-time / CI gating.

The `BackupStatusProvider` interface keeps the source of truth pluggable: in
production it can wrap the managed provider's API or an operator-maintained
config snapshot; tests use an in-memory fake (no live DB).

### Enabling PITR on the recommended managed Postgres (deploy time)

The design recommends **Railway / Render** managed Postgres for MVP (hosting
Option A), both of which offer managed backups/PITR — no self-managed WAL
archiving needed. Enable at deploy time, before go-live:

- **Railway** — provision the Postgres plugin/service, then in the database
  service settings enable **Backups** and turn on **Point-in-Time Recovery**.
  Set the **backup/PITR retention window to at least 7 days** (raise the default
  if it is lower). Railway's PITR continuously archives WAL, satisfying the
  "daily automated backups + WAL retention ≥ 7 days" requirement.
- **Render** — on the managed **PostgreSQL** instance, backups run daily
  automatically; enable **Point-in-Time Recovery** and set the recovery
  (retention) window to **≥ 7 days** in the instance settings.
- **Self-managed Postgres (not recommended for MVP)** — set `wal_level =
  replica` (or `logical`), archive WAL via `archive_mode = on` + `archive_command`
  (or a tool such as pgBackRest / WAL-G) to durable storage, take a daily base
  backup, and retain both base backups and WAL for at least 7 days.

After enabling, point a `BackupStatusProvider` at the deployment's reported
settings and run `assertBackupConfiguration(...)` (e.g. in a deploy smoke check)
to confirm compliance. This repo performs **no live backup/restore operations**;
enabling and verifying against the real provider happens at deploy time.
