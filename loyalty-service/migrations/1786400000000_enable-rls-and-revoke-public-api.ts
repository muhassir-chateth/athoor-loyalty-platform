/**
 * Migration: close the anonymous PostgREST hole — enable RLS on every `public`
 * table and revoke the Supabase client-API roles from the schema entirely.
 *
 * Responds to two CRITICAL Supabase Security Advisor findings on project
 * `athoor-loyalty-production1`:
 *   - `rls_disabled_in_public`      — tables reachable through the Data API with
 *                                     no row-level security at all;
 *   - `sensitive_columns_exposed`   — those tables carry PII and secrets.
 *
 * THE SHARPEST EXPOSURE IS NOT PRIVACY, IT IS MONEY
 * =================================================
 * `discount_codes.code` is `TEXT UNIQUE NOT NULL`, sitting beside
 * `status TEXT NOT NULL DEFAULT 'active'` and `amount_off_gbp NUMERIC(8,2)`.
 * With `anon` holding SELECT on that table, anybody who has the project's
 * publishable anon key — which by design ships to browsers and is therefore
 * public — can issue one Data API read and enumerate every unredeemed discount
 * code together with its face value, then spend them. That is direct monetary
 * loss with no account takeover, no password, and no trace in the loyalty
 * service's own logs, because the request never reaches this application. Every
 * other exposure here (`customers.email`, `customers.referral_code`,
 * `customers.lifetime_points`, `customers.lifetime_spend_gbp`,
 * `referrals.referred_email`, `device_tokens.token`,
 * `customer_birthdays.birth_month`/`birth_day`, and the whole of
 * `ledger_entries`, `point_lots` and `redemptions`) is a serious privacy
 * breach. `discount_codes.code` is a cash register with the drawer open.
 *
 * ROOT CAUSE
 * ==========
 * Nothing in this repository ever granted those privileges. A fresh Supabase
 * project grants `anon` and `authenticated` default privileges on schema
 * `public`, and PostgREST exposes `public` as a REST surface. Nineteen
 * migrations created thirty tables into that schema and not one of them
 * mentioned `ROW LEVEL SECURITY`, `CREATE POLICY`, `GRANT` or `REVOKE`, so the
 * platform default stood. The hole was inherited, not written.
 *
 * WHY THERE ARE NO POLICIES IN THIS FILE
 * ======================================
 * Because nothing legitimately reaches these tables through the client API.
 * `@supabase/supabase-js` is not a dependency of this service, the theme or the
 * scripts; there is no `createClient`, no `SUPABASE_URL`, no anon key and no
 * `/rest/v1/` call anywhere in the codebase. The loyalty service talks to
 * Postgres over `pg` with `DATABASE_URL`. So the correct access-control answer
 * for the Data API is not "a narrower policy", it is "no access". RLS with zero
 * policies is exactly that: deny-by-default for every role that does not bypass
 * it. Adding a `USING (true)` policy would silence the advisor while leaving the
 * data every bit as readable, and is the anti-pattern this migration exists to
 * avoid.
 *
 * WHY THIS DOES NOT BREAK THE BACKEND
 * ===================================
 * The service connects as the role in `DATABASE_URL` — in production the
 * Supabase pooler form `postgres.<projectref>`, which resolves to `postgres`,
 * the role that created and therefore owns all thirty tables. **A table's owner
 * bypasses that table's row-level security** unless the table is additionally
 * marked `FORCE ROW LEVEL SECURITY`. This migration deliberately does NOT set
 * `FORCE` (see the prominent warning in step 4), so every existing query keeps
 * returning exactly the rows it returned before. The change is invisible to
 * Render and visible only to `anon` and `authenticated`.
 *
 * WHAT THIS MIGRATION CANNOT DO
 * =============================
 * PostgreSQL has no "default RLS for future tables". `ALTER DEFAULT PRIVILEGES`
 * (step 3) stops a future table from being GRANTed to the client-API roles, but
 * nothing makes a future table start life with RLS enabled. A table created
 * after this migration runs has RLS off until something enables it. Two things
 * cover that gap, and both need to stay in place:
 *   - `migrations.rls-lockdown.test.ts` fails CI if any migration creates a
 *     table absent from {@link RLS_TABLES}, so the roster cannot fall behind;
 *   - step 4b sweeps `pg_tables` at apply time and is idempotent, so
 *     re-applying the lockdown after a later migration adds tables is a safe,
 *     repeatable operation.
 *
 * SAFETY: this file is a local migration definition only. Creating it executes
 * nothing against any database. Application is a deliberate deploy-time action
 * (`npm run migrate:up`) against the target Postgres, and must be run as the
 * table owner — `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` requires ownership.
 *
 * SCOPE: schema `public` only. `pgboss` and every other schema are untouched.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The two Supabase client-API roles this migration locks out.
 *
 * `service_role` is deliberately ABSENT and must stay absent — see
 * {@link SERVICE_ROLE_RATIONALE}.
 */
export const LOCKED_OUT_ROLES = ["anon", "authenticated"] as const;

/**
 * Why `service_role` is left with its privileges intact.
 *
 * `service_role` is created `BYPASSRLS`, and Supabase's own platform internals
 * authenticate as it. Revoking from it would not improve safety — a `BYPASSRLS`
 * role ignores step 4 regardless — and would risk breaking platform features
 * that depend on it. The control that matters for `service_role` is
 * operational, not SQL: its key is a SECRET. It must live only in server-side
 * configuration and must never be shipped to a browser, a theme asset or a
 * mobile client. If it ever leaks, this migration will not save you, because
 * bypassing RLS is precisely what that role is for.
 */
export const SERVICE_ROLE_RATIONALE = "service_role is BYPASSRLS and is used by Supabase internals; keep it, but never ship its key to a client";

/**
 * Every table this migration puts behind RLS, as established by the audit:
 * thirty tables, all in schema `public`.
 *
 * WHY A WRITTEN ROSTER *AND* A CATALOGUE SWEEP
 * -------------------------------------------
 * The roster is the auditable artefact — it is what a reviewer reads, what the
 * test gate compares against every `CREATE TABLE` in the migration directory,
 * and what makes a forgotten table a CI failure rather than a silent exposure.
 * The sweep in step 4b is the belt to that braces: it enables RLS on whatever
 * `pg_tables` actually reports, so a table nobody wrote down is still covered
 * at apply time.
 *
 * WHY EVERY ENTRY IS EXISTENCE-GUARDED
 * ------------------------------------
 * Five of these tables (`customer_birthdays`, `birthday_grants`,
 * `customer_fragrance_preferences`, `customer_communication_preferences`,
 * `customer_erasure_requests`) are created by the portal migration stack, which
 * is not yet merged to `main`. This migration must be mergeable and applicable
 * on its own, so step 4a skips any roster entry the catalogue does not report
 * rather than failing on it. When the portal stack lands, those five are already
 * named here and are covered by the next apply — and by the sweep in any case.
 */
export const RLS_TABLES = [
  // --- ledger core (1784817408986): the money and the identity ---------------
  "customers", // email CITEXT, referral_code, lifetime_points, lifetime_spend_gbp
  "ledger_entries", // the immutable points ledger
  "point_lots", // per-lot balances and expiry
  "redemptions", // what was spent
  "discount_codes", // code TEXT UNIQUE — the monetary exposure described above
  "webhook_events",
  "referrals", // referred_email CITEXT
  // --- benefits (1784818000000) --------------------------------------------
  "benefits",
  "benefit_requests",
  // --- profile / preferences (1784904000000) -------------------------------
  "customer_favourites",
  "customer_wishlist",
  "customer_recently_viewed",
  "tier_change_history",
  "portal_visits",
  // --- admin audit (1784990000000) -----------------------------------------
  "admin_audit_log",
  // --- devices and notifications (1785000000000) ---------------------------
  "device_tokens", // token TEXT — a push credential
  "notification_events",
  // --- market configuration (1785000000000) --------------------------------
  "markets",
  "earning_rule_sets",
  "reward_rule_sets",
  // --- operational tables (1785200000000 – 1785600000000) ------------------
  "pre_expiry_notifications",
  "analytics_aggregate_refresh",
  "scheduled_runs",
  "idempotency_keys",
  "backup_runs",
  // --- portal stack (1786000000000 – 1786300000000, not yet on main) -------
  "customer_birthdays", // birth_month / birth_day
  "birthday_grants",
  "customer_fragrance_preferences",
  "customer_communication_preferences",
  "customer_erasure_requests",
] as const;

/**
 * A bare, lower-case SQL identifier.
 *
 * Every name in {@link RLS_TABLES} is a literal written in this file, so this
 * guard is not defending against untrusted input — it is defending against a
 * future edit that pastes in something containing a quote and turns a generated
 * array literal into an injection. Cheap, and it fails at build time rather
 * than at apply time.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Renders {@link RLS_TABLES} as a plpgsql `text[]` literal. */
function rosterArrayLiteral(): string {
  for (const table of RLS_TABLES) {
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new Error(`RLS_TABLES contains an unsafe identifier: ${table}`);
    }
  }
  return RLS_TABLES.map((table) => `'${table}'`).join(",\n      ");
}

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Every role-dependent statement below is wrapped in a `pg_roles` existence
  // check. `anon`, `authenticated` and `service_role` are created by the
  // Supabase platform, not by this repository, so on a plain PostgreSQL
  // instance — a developer's laptop, a CI container, a self-hosted deployment —
  // they simply do not exist and an unguarded REVOKE would abort the migration.
  // The guards also make every step re-runnable: REVOKE on an already-revoked
  // privilege is a no-op, so applying this twice changes nothing.
  //
  // Each statement is issued through EXECUTE rather than written inline. That
  // keeps the role name a runtime string, so nothing in the block has to
  // resolve a role that may not exist at parse time.

  // -------------------------------------------------------------------------
  // STEP 1 — Schema lockout: take away the right to *enter* schema public.
  // -------------------------------------------------------------------------
  // This is the migration-based equivalent of removing `public` from the
  // project's "Exposed schemas" list in the Supabase dashboard, and it is
  // strictly better in one respect: dashboard state is invisible to code
  // review, is not versioned, and drifts. Anyone with project access can put
  // `public` back with two clicks and nothing records that it happened. This
  // statement lives in the repository, is reviewed like code, and is re-applied
  // on every deploy.
  //
  // Without USAGE on the schema, no privilege on any object inside it can be
  // exercised — a table-level SELECT is unreachable if you cannot enter the
  // schema that contains the table. Steps 2 to 4 are defence in depth behind
  // this one line, on the assumption that some day somebody re-grants USAGE.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE USAGE ON SCHEMA public FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE USAGE ON SCHEMA public FROM authenticated';
      END IF;
    END
    $$;
  `);

  // -------------------------------------------------------------------------
  // STEP 2 — Object revoke: strip the privileges Supabase already handed out.
  // -------------------------------------------------------------------------
  // Step 1 closed the door; this empties the room behind it. `ALL PRIVILEGES`
  // covers SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER in
  // one statement, so this does not depend on knowing which of them the
  // platform granted.
  //
  // SEQUENCES matter as well as TABLES: USAGE on a sequence lets a caller pull
  // `nextval()` and read `last_value`, which leaks row counts and lets an
  // attacker perturb identifier allocation. FUNCTIONS matter because EXECUTE on
  // a `SECURITY DEFINER` function is a way to read data the caller cannot read
  // directly — RLS on the tables would not stop it.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM authenticated';
      END IF;
    END
    $$;
  `);

  // -------------------------------------------------------------------------
  // STEP 3 — Default privileges: stop the hole re-opening on the next table.
  // -------------------------------------------------------------------------
  // Step 2 acts on objects that exist right now. Without this step, the next
  // `CREATE TABLE` would be granted to `anon` and `authenticated` all over
  // again by the project's default privileges, and the advisor finding would
  // come back with a table nobody remembered to check.
  //
  // LIMITATION, STATED PLAINLY: `ALTER DEFAULT PRIVILEGES` is scoped per
  // CREATING ROLE, not per schema. With no `FOR ROLE` clause it applies to the
  // role executing this statement — `current_user`, which in production is the
  // pooler's `postgres` and is the role `node-pg-migrate` runs as. It therefore
  // covers tables created by THAT role and no other. If a second role ever
  // creates objects in `public` (a dashboard-authored table owned by
  // `supabase_admin`, a future service with its own login), that role needs its
  // own `ALTER DEFAULT PRIVILEGES ... FOR ROLE <that role>` entry or its tables
  // will be granted to the client-API roles on creation. The NOTICE below
  // records which role was actually covered, so the apply log answers the
  // question rather than leaving it to be inferred.
  pgm.sql(`
    DO $$
    BEGIN
      RAISE NOTICE 'rls-lockdown: default privileges revoked for objects created by role %', current_user;

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated';
      END IF;
    END
    $$;
  `);

  // -------------------------------------------------------------------------
  // STEP 4a — Enable RLS on the audited roster of thirty tables. NO POLICIES.
  // -------------------------------------------------------------------------
  // A table with RLS enabled and zero policies denies every row to every role
  // that does not bypass RLS. That is the whole access-control decision, and it
  // is the right one here because no client-API caller has any business reading
  // these tables (see the file header).
  //
  // ############ DO NOT ADD `FORCE ROW LEVEL SECURITY`. ############
  // `FORCE` makes RLS apply to the TABLE OWNER as well. The loyalty service
  // connects as `postgres`, which owns every one of these tables, and there are
  // NO POLICIES — so `FORCE` would deny the backend every row of every table.
  // Balance reads would return zero, enrolment would fail, the ledger would
  // read empty. It would be a total production outage, and a confusing one,
  // because nothing would error: queries would succeed and return nothing.
  // `FORCE` is called out here because it LOOKS like the more secure option and
  // a future reviewer hardening this file is exactly who would add it. The
  // owner bypass is not a gap being tolerated; it is the mechanism that makes
  // this migration safe to apply to a live system. The backend is protected by
  // being the owner, not by a policy.
  //
  // Each entry is guarded on `pg_tables` so the five not-yet-merged portal
  // tables are skipped rather than aborting the migration.
  pgm.sql(`
    DO $$
    DECLARE
      target_table text;
      covered int := 0;
      skipped int := 0;
    BEGIN
      FOREACH target_table IN ARRAY ARRAY[
      ${rosterArrayLiteral()}
      ] LOOP
        IF EXISTS (
          SELECT 1 FROM pg_tables
          WHERE schemaname = 'public' AND tablename = target_table
        ) THEN
          EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
          covered := covered + 1;
        ELSE
          -- Not an error: expected for the portal tables until that stack merges.
          RAISE NOTICE 'rls-lockdown: roster table %.% not present, skipped', 'public', target_table;
          skipped := skipped + 1;
        END IF;
      END LOOP;

      RAISE NOTICE 'rls-lockdown: RLS enabled on % roster tables (% absent)', covered, skipped;
    END
    $$;
  `);

  // -------------------------------------------------------------------------
  // STEP 4b — Catalogue sweep: cover anything the roster does not name.
  // -------------------------------------------------------------------------
  // The roster is maintained by hand and the test gate keeps it honest, but a
  // security control should not depend on a list being complete. This reads the
  // catalogue and enables RLS on every remaining table in `public`, so a table
  // created outside the migration directory — from the dashboard, by an
  // extension, by a hotfix applied directly — is covered too.
  //
  // `AND NOT rowsecurity` makes this a true no-op on re-apply: after step 4a
  // the roster tables are already enabled, so this touches only the remainder.
  //
  // This intentionally includes `pgmigrations`, `node-pg-migrate`'s own
  // bookkeeping table, which lives in `public` and is flagged by the same
  // advisor rule as everything else. It is safe for the same reason the rest is
  // safe: the owner bypasses RLS, and `node-pg-migrate` connects as the owner.
  // NOTE the consequence, since it is the sharpest edge of the owner-bypass
  // design: if migrations were ever run as a NON-owner role, that role would
  // read `pgmigrations` as empty and try to re-apply the entire history. Run
  // migrations as the owner. This is the second reason `FORCE` must never be
  // added — it would create that failure for the owner too.
  //
  // Only `public` is swept. `pgboss` and every other schema are out of scope.
  pgm.sql(`
    DO $$
    DECLARE
      target_table text;
      swept int := 0;
    BEGIN
      FOR target_table IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND NOT rowsecurity
        ORDER BY tablename
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table);
        RAISE NOTICE 'rls-lockdown: swept table not on the roster: %.%', 'public', target_table;
        swept := swept + 1;
      END LOOP;

      RAISE NOTICE 'rls-lockdown: sweep enabled RLS on % further table(s)', swept;
    END
    $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // ##########################################################################
  // ## RUNNING THIS `down` RE-OPENS A CRITICAL VULNERABILITY.                ##
  // ##########################################################################
  //
  // This is not a normal rollback. It restores, exactly, the state that the
  // Supabase Security Advisor flagged as CRITICAL: `anon` — a role whose key is
  // published to every browser that loads the storefront — regains SELECT on
  // `discount_codes`, and can once again enumerate live discount codes and
  // their face values through the Data API, plus every customer email, referral
  // code, points balance, device push token and ledger row. The window is not
  // "until someone notices"; unauthenticated reads of the Data API do not
  // appear in this service's logs at all.
  //
  // SO DO NOT USE THIS AS A DEPLOY ROLLBACK. If a deploy that included this
  // migration goes wrong, the fix is to revert the APPLICATION CODE and leave
  // the database locked down. Nothing in this service reads or writes through
  // the client API, so no application failure can be caused by this migration
  // and no application failure can be fixed by reversing it. If the backend
  // does break after applying it, the cause is that the connecting role is not
  // the table owner — and the correct response is to fix the role, or to grant
  // that specific role what it needs, NOT to re-expose the schema to `anon`.
  //
  // It exists at all because a migration that cannot be reversed is a migration
  // that cannot be tested, and because `node-pg-migrate` needs a `down` to keep
  // the history coherent. The only legitimate use is a local, disposable
  // database.

  // Reverse of step 4b and 4a: RLS off. Sweep first — driven by the catalogue,
  // so it also releases tables the roster does not name.
  pgm.sql(`
    DO $$
    DECLARE
      target_table text;
    BEGIN
      FOR target_table IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND rowsecurity
        ORDER BY tablename
      LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', target_table);
      END LOOP;
    END
    $$;
  `);

  // Reverse of step 3: restore the default privileges that make every future
  // table readable by the client-API roles.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated';
      END IF;
    END
    $$;
  `);

  // Reverse of step 2: hand back the object privileges. `GRANT ALL ON ALL ...`
  // is what a fresh Supabase project applies, so this restores the platform
  // default rather than inventing a wider one.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon';
        EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon';
        EXECUTE 'GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated';
        EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated';
        EXECUTE 'GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated';
      END IF;
    END
    $$;
  `);

  // Reverse of step 1, and last on purpose: re-opening the schema door is the
  // statement that actually makes the data reachable again, so it happens only
  // once everything behind it has been restored.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO authenticated';
      END IF;
    END
    $$;
  `);
}
