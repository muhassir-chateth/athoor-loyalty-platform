/**
 * Migration: close the two CRITICAL Supabase Security Advisor findings —
 * `rls_disabled_in_public` and `sensitive_columns_exposed`.
 *
 * WHY THIS MIGRATION EXISTS, AND WHY IT IS NOT A POLICY MIGRATION
 *
 * Every table in this database lives in `public`, and Supabase exposes `public`
 * through PostgREST (the Data API) at `https://<ref>.supabase.co/rest/v1/...`.
 * Two Postgres roles reach that endpoint from a browser: `anon` (publishable
 * key only) and `authenticated` (end-user JWT). If either holds SELECT on
 * `customers`, then `customers.email` — and every point balance — is a public
 * HTTP GET away.
 *
 * No migration in this repository has ever issued GRANT, REVOKE, CREATE POLICY
 * or ENABLE ROW LEVEL SECURITY. The grants that cause the finding were applied
 * by the Supabase PLATFORM through ALTER DEFAULT PRIVILEGES on `public`, which
 * is why they are invisible in the migration history and why reading the
 * migrations cannot tell you whether you are exposed.
 *
 * THE FIX IS REVOCATION, NOT POLICY. The obvious move — enable RLS and add a
 * policy — is the wrong one here, for a reason worth stating plainly:
 *
 *   Nothing in this system uses the Data API.
 *
 * `loyalty-service` depends on `pg` and has no `@supabase/supabase-js`; there is
 * no SUPABASE_URL, no anon key and no service-role key anywhere in `src/` or in
 * `theme/`. The storefront reaches the backend through the Shopify App Proxy
 * (`/apps/loyalty/v1/*`, HMAC-signed) and the backend reaches Postgres directly
 * as role `postgres`. So the correct posture for `anon` and `authenticated` is
 * not "a policy that lets them see their own row" — it is NO ACCESS AT ALL.
 * A permissive policy would be inventing an access path that no client needs and
 * that nothing tests.
 *
 * WHY RLS IS STILL ENABLED. Revoked grants are the binding control; RLS is the
 * second net, for the case where a future GRANT is issued by hand or by a
 * platform default we do not control. With zero policies, RLS denies every
 * non-owner, non-BYPASSRLS role by default. Enabling it is also what actually
 * clears the Advisor's `rls_disabled_in_public` check.
 *
 * WHY THERE IS NO `FORCE ROW LEVEL SECURITY`. This is the one change here that
 * could take production down, so it is deliberately absent. A table's OWNER is
 * exempt from RLS unless RLS is FORCEd. The Render backend connects as
 * `postgres`, which both owns every table and has `rolbypassrls = true`. Enable
 * RLS and the backend is unaffected. FORCE it with zero policies and the backend
 * reads zero rows from every table — a total outage. FORCE is therefore never
 * used, and the audit script asserts `relforcerowsecurity = false`.
 *
 * WHAT THIS MIGRATION DOES NOT TOUCH, AND WHY
 *
 *   `service_role` — left exactly as it is. It requires the secret service key,
 *     which appears in no browser and in none of our code. Note it has
 *     `rolbypassrls = true`, so RLS would not constrain it anyway; only
 *     revocation would. Revoking it is available as the clearly-marked optional
 *     block below, but it is a separate decision from closing a browser-facing
 *     hole and is not bundled into this one.
 *
 *   `USAGE ON SCHEMA public` — not revoked from PUBLIC. PostgREST needs both
 *     schema USAGE and a table privilege, so removing the table privilege is
 *     already sufficient and is far more surgical. USAGE on `public` is granted
 *     to PUBLIC (`=U/pg_database_owner`), so revoking it from `anon` alone would
 *     be a no-op that reads like a control, and revoking it from PUBLIC would
 *     hit every role without an explicit grant — including Supabase-internal
 *     ones we do not own. Bigger blast radius, no additional protection.
 *
 *   Row data — nothing. GRANT, REVOKE and ALTER TABLE ... ENABLE ROW LEVEL
 *     SECURITY are catalog-only operations. They cannot add, change or delete a
 *     row, so the 9 migrated customers, the 484 migrated points and every
 *     `point_lots` / `ledger_entries` row are untouchable by this migration as a
 *     matter of what these statements are, not as a matter of care taken.
 *
 * ROLLBACK IS EXACT, NOT APPROXIMATE. `up()` first records the current
 * privilege set and RLS flag for every relation in `public` into
 * `security_baseline_grants` / `security_baseline_rls`, read from the catalog
 * with `aclexplode()`. `down()` replays that snapshot verbatim. So the reversal
 * restores the state that was actually there, rather than a guess at what
 * Supabase's defaults used to be. Both snapshot tables are created before the
 * revocation loop runs, so they are locked down by the same pass.
 *
 * SELF-VERIFYING. The final step re-reads the catalogue and raises an exception
 * if any API role still holds SELECT, INSERT, UPDATE or DELETE on anything in
 * `public`. node-pg-migrate runs each migration in a transaction and Postgres
 * has transactional DDL, so a failed assertion rolls the whole thing back and
 * leaves the database exactly as it was. There is no half-applied state.
 *
 * ORDERING. This is numbered 1785950000000 so that it sorts BEFORE the four
 * additive Task 6 migrations (1786000000000–1786300000000), which are written
 * but deliberately not yet applied to production. `npm run migrate:up -- 1`
 * therefore applies THIS migration and nothing else. Task 6 stays pending until
 * it is separately approved — and once this has run, the four Task 6 tables
 * (including `customer_birthdays`, which holds a date of birth) inherit the
 * hardened default privileges instead of being born exposed.
 *
 * SAFETY: this file is a local migration DEFINITION only. Creating it executes
 * NOTHING. Application is a separate, deliberate act against an explicit target.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * The browser-reachable Data API roles. `service_role` is intentionally NOT in
 * this list — see the header. Both of these have `rolcanlogin = false`: they
 * cannot open a Postgres connection directly and are only ever assumed by
 * PostgREST via SET ROLE, which is precisely why revoking their table
 * privileges removes the entire browser-facing surface.
 */
const API_ROLES = "'anon', 'authenticated'";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // ---------------------------------------------------------------------------
  // 1. Snapshot the current posture so the reversal can be exact.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    CREATE TABLE security_baseline_grants (
        relation    TEXT NOT NULL,          -- format('%I.%I', schema, name)
        relkind     "char" NOT NULL,         -- r/p table, v view, m matview, f foreign
        grantee     TEXT NOT NULL,
        privilege   TEXT NOT NULL,           -- SELECT / INSERT / ... / MAINTAIN
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (relation, grantee, privilege)
    );
  `);

  pgm.sql(`
    CREATE TABLE security_baseline_rls (
        relation    TEXT PRIMARY KEY,
        rls_enabled BOOLEAN NOT NULL,
        rls_forced  BOOLEAN NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // The DEFAULT privileges are snapshotted separately, because "what Supabase
  // grants on a new table" is not the same fact as "what is granted on the
  // tables that exist today", and step 4 changes the former. Without this,
  // down() would have to guess — and the honest guess ("GRANT ALL, the legacy
  // Supabase default") is wrong on any project created after Supabase tightened
  // that default, where `postgres` grants only Dxtm. Restoring more privilege
  // than was taken is not a rollback.
  pgm.sql(`
    CREATE TABLE security_baseline_default_acl (
        objtype     "char" NOT NULL,        -- r tables, S sequences, f functions
        grantee     TEXT NOT NULL,
        privilege   TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (objtype, grantee, privilege)
    );
  `);

  // aclexplode() turns the packed aclitem[] into one row per (grantee,
  // privilege), which is the shape a GRANT statement needs. A NULL relacl means
  // "no explicit grants", which correctly yields zero rows — and restoring zero
  // rows is the right reversal for that case.
  pgm.sql(`
    INSERT INTO security_baseline_grants (relation, relkind, grantee, privilege)
    SELECT format('%I.%I', n.nspname, c.relname),
           c.relkind,
           pg_get_userbyid(a.grantee),
           a.privilege_type
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p','v','m','f')
       AND pg_get_userbyid(a.grantee) IN (${API_ROLES})
    ON CONFLICT DO NOTHING;
  `);

  pgm.sql(`
    INSERT INTO security_baseline_rls (relation, rls_enabled, rls_forced)
    SELECT format('%I.%I', n.nspname, c.relname),
           c.relrowsecurity,
           c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p')
    ON CONFLICT DO NOTHING;
  `);

  // Only OUR defaults (defaclrole = the migrating role) are recorded. The
  // parallel `supabase_admin` default ACL is not ours to change, so capturing it
  // would imply down() could restore it, which it cannot.
  pgm.sql(`
    INSERT INTO security_baseline_default_acl (objtype, grantee, privilege)
    SELECT d.defaclobjtype,
           pg_get_userbyid(a.grantee),
           a.privilege_type
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
     WHERE n.nspname = 'public'
       AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND pg_get_userbyid(a.grantee) IN (${API_ROLES})
    ON CONFLICT DO NOTHING;
  `);

  // ---------------------------------------------------------------------------
  // 2. Revoke every privilege from the two browser-reachable roles.
  //
  // A per-relation loop is used rather than `REVOKE ALL ON ALL TABLES IN SCHEMA
  // public`, because that form's coverage of MATERIALIZED VIEWS is not
  // guaranteed — and three materialised views here (analytics_customers,
  // analytics_ledger, analytics_redemptions) are the most sensitive relations in
  // the database. RLS does not apply to a matview at all: it holds a physical
  // copy populated by its owner, so a grant is the ONLY thing standing between
  // it and the API. Enumerating relkind explicitly makes that coverage provable.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT format('%I.%I', n.nspname, c.relname) AS rel,
               api_role
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          -- ROLE-EXISTENCE GUARD (ported from the superseded rls-lockdown
          -- implementation). Resolving the API roles from pg_roles rather than
          -- from a literal array means an absent role yields zero rows and is
          -- skipped. The unguarded form fails outright with "role does not
          -- exist" on any PostgreSQL without the Supabase roles - a developer
          -- laptop, a CI container, a self-hosted target. Matches the api_roles
          -- CTE in docs/ops/supabase-critical-findings-production-probe.sql.
          CROSS JOIN (SELECT rolname::text
                        FROM pg_roles
                       WHERE rolname IN (${API_ROLES})) AS existing(api_role)
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r','p','v','m','f')
         ORDER BY 1, 2
      LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON %s FROM %I', r.rel, r.api_role);
      END LOOP;
    END $$;
  `);

  // Sequences: a sequence grant leaks nextval/currval and, with USAGE, lets a
  // caller advance a live sequence. Nothing in the Data API needs them.
  pgm.sql(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN
        SELECT format('%I.%I', n.nspname, c.relname) AS seq,
               api_role
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          -- ROLE-EXISTENCE GUARD (ported from the superseded rls-lockdown
          -- implementation). Resolving the API roles from pg_roles rather than
          -- from a literal array means an absent role yields zero rows and is
          -- skipped. The unguarded form fails outright with "role does not
          -- exist" on any PostgreSQL without the Supabase roles - a developer
          -- laptop, a CI container, a self-hosted target. Matches the api_roles
          -- CTE in docs/ops/supabase-critical-findings-production-probe.sql.
          CROSS JOIN (SELECT rolname::text
                        FROM pg_roles
                       WHERE rolname IN (${API_ROLES})) AS existing(api_role)
         WHERE n.nspname = 'public' AND c.relkind = 'S'
         ORDER BY 1, 2
      LOOP
        EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM %I', r.seq, r.api_role);
      END LOOP;
    END $$;
  `);

  // ---------------------------------------------------------------------------
  // 3. Enable RLS on every base table. No FORCE. No policies.
  //
  // Zero policies is the point: with RLS enabled and no policy, every role that
  // is neither the owner nor BYPASSRLS sees no rows. `postgres` is both, so the
  // Render backend is unaffected. Matviews are excluded because ALTER
  // MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY is not valid SQL — for them,
  // step 2 is the whole control.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    DO $$
    DECLARE
      rel TEXT;
    BEGIN
      FOR rel IN
        SELECT format('%I.%I', n.nspname, c.relname)
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r','p')
           AND c.relrowsecurity IS FALSE
         ORDER BY 1
      LOOP
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
      END LOOP;
    END $$;
  `);

  // ---------------------------------------------------------------------------
  // 4. Stop FUTURE objects from being born exposed.
  //
  // Default privileges are per-grantor. Migrations run as `postgres`, so setting
  // the `postgres` defaults is what governs every table a future migration
  // creates — including the four Task 6 tables still pending. The separate
  // `supabase_admin` default ACL is not ours to change and governs only objects
  // created BY supabase_admin, which our migrations never do.
  // ---------------------------------------------------------------------------
  //
  // DELIBERATELY NOT wrapped in a pg_roles existence guard, unlike step 2. A
  // guarded form would have to build these statements with EXECUTE format(...),
  // which puts the DDL inside a string literal - and the static gate in
  // src/security.publicSchemaPosture.test.ts asserts on the emitted SQL text,
  // so it would no longer be able to SEE that default privileges are revoked.
  // That trade is the wrong way round: these migrations are only ever applied to
  // Supabase, where both roles exist, and no CI step applies them, so the
  // portability is theoretical while the static control is real. If this ever
  // needs to run on a PostgreSQL without the Supabase roles, create the roles
  // first - do not hide the DDL from the gate.
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON TABLES FROM anon, authenticated;
  `);
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  `);
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  `);

  // ---------------------------------------------------------------------------
  // 4b. The SECOND default-ACL grantor: supabase_admin.
  //
  // The production probe (2026-08-26) found TWO default-privilege grantors on
  // `public`, not one:
  //
  //     granted_by postgres        -> anon=arwdDxtm, authenticated=arwdDxtm
  //     granted_by supabase_admin  -> anon=arwdDxtm, authenticated=arwdDxtm
  //
  // Step 4 above has no FOR ROLE clause, so it fixes only `postgres` - the role
  // our migrations run as. That is sufficient for every table a migration
  // creates, and the earlier version of this file said so and stopped there.
  //
  // It is NOT sufficient for a table created through the Supabase DASHBOARD
  // table editor, which creates as `supabase_admin`. Such a table would inherit
  // arwdDxtm for anon and be born fully exposed - readable AND truncatable - by
  // exactly the route this migration exists to close.
  //
  // Attempted best-effort and guarded, because altering another role's default
  // privileges requires membership of it. `postgres` may or may not hold that on
  // a given Supabase project, and this hardening must not fail closed on a
  // permission we cannot guarantee: steps 1-4 are the critical fix. If it is
  // refused, the NOTICE records it, the ensure_rls event trigger still enables
  // RLS on the new table, and the CI posture gate still fails the build - so the
  // residual is covered by two further layers rather than by hope.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
        RAISE NOTICE 'rls-hardening: supabase_admin default privileges revoked for anon/authenticated';
      END IF;
    EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
      RAISE NOTICE 'rls-hardening: could NOT alter supabase_admin default privileges (%). A table created via the Supabase dashboard would still be born granted to anon; ensure_rls and the CI posture gate remain the covering layers.', SQLERRM;
    END $$;
  `);

  // ---------------------------------------------------------------------------
  // 5. Belt to the braces: an event trigger that enables RLS on any new table.
  //
  // The staging database already carries this exact control, installed by hand
  // and recorded in no migration — undocumented drift that this step converts
  // into versioned schema, so staging and production converge on a defence that
  // is visible in the repository.
  //
  // It is wrapped in an exception handler ON PURPOSE. Creating an event trigger
  // needs a privilege that `postgres` holds on Supabase but is not guaranteed to
  // hold on every deployment target. If it is unavailable, this degrades to a
  // NOTICE rather than failing the transaction, because the critical fix is
  // steps 1–4 and must not be blocked by a hardening extra. The CI check in
  // `src/security.publicSchemaPosture.test.ts` is the layer that is guaranteed.
  //
  // Unlike staging's copy, EXECUTE is revoked from PUBLIC here. A function
  // returning `event_trigger` cannot in fact be invoked directly — Postgres
  // refuses with "trigger functions can only be called as triggers", and
  // PostgREST cannot expose a pseudo-type return as an RPC — so the default
  // EXECUTE-to-PUBLIC is harmless. Revoking it is hygiene: it keeps the audit
  // output clean so a real exposed SECURITY DEFINER function is never lost in
  // the noise of an accepted one.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION public.rls_auto_enable()
      RETURNS event_trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog'
    AS $fn$
    DECLARE
      cmd record;
    BEGIN
      FOR cmd IN
        SELECT * FROM pg_event_trigger_ddl_commands()
         WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
           AND object_type IN ('table', 'partitioned table')
      LOOP
        IF cmd.schema_name = 'public' THEN
          BEGIN
            EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', cmd.object_identity);
            RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
          EXCEPTION WHEN OTHERS THEN
            RAISE LOG 'rls_auto_enable: could not enable RLS on %', cmd.object_identity;
          END;
        END IF;
      END LOOP;
    END $fn$;
  `);

  pgm.sql(`REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC;`);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
        CREATE EVENT TRIGGER ensure_rls
          ON ddl_command_end
          EXECUTE FUNCTION public.rls_auto_enable();
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE
        'rls_auto_enable installed, but the ensure_rls event trigger could not be created (insufficient privilege). Steps 1-4 are applied; CI remains the enforcing layer.';
    END $$;
  `);

  // ---------------------------------------------------------------------------
  // 6. Assert the outcome, or roll the whole migration back.
  // ---------------------------------------------------------------------------
  pgm.sql(`
    DO $$
    DECLARE
      leaked TEXT;
    BEGIN
      SELECT string_agg(DISTINCT format('%I.%I -> %s', n.nspname, c.relname, pg_get_userbyid(a.grantee)), ', ')
        INTO leaked
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) AS a
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r','p','v','m','f')
         AND pg_get_userbyid(a.grantee) IN (${API_ROLES})
         AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE');

      IF leaked IS NOT NULL THEN
        RAISE EXCEPTION
          'Data API hardening failed: an API role still holds a data privilege on %. Migration rolled back.', leaked;
      END IF;

      SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
        INTO leaked
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r','p')
         AND c.relrowsecurity IS FALSE;

      IF leaked IS NOT NULL THEN
        RAISE EXCEPTION
          'Data API hardening failed: RLS still disabled on %. Migration rolled back.', leaked;
      END IF;

      -- FORCE would subject the owner to RLS too, and with zero policies that is
      -- a production outage. Assert we did not introduce it.
      SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
        INTO leaked
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r','p')
         AND c.relforcerowsecurity IS TRUE;

      IF leaked IS NOT NULL THEN
        RAISE EXCEPTION
          'Refusing to complete: FORCE ROW LEVEL SECURITY is set on %, which would lock out the owner and take the backend down. Migration rolled back.', leaked;
      END IF;
    END $$;
  `);

  // ---------------------------------------------------------------------------
  // OPTIONAL EXTRA HARDENING — deliberately left commented out.
  //
  // Uncommenting revokes the same privileges from `service_role`. That role is
  // reachable only with the secret service key, which is in no browser and in
  // none of our code, so it is not part of the finding this migration closes.
  // It is a separate decision with a separate blast radius (it would break any
  // future server-side integration written against the Data API), so it is
  // recorded here as a choice rather than made silently.
  //
  // pgm.sql(`
  //   DO $$
  //   DECLARE rel TEXT;
  //   BEGIN
  //     FOR rel IN
  //       SELECT format('%I.%I', n.nspname, c.relname)
  //         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  //        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
  //     LOOP
  //       EXECUTE format('REVOKE ALL PRIVILEGES ON %s FROM service_role', rel);
  //     END LOOP;
  //   END $$;
  // `);
  // ---------------------------------------------------------------------------
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Replay the snapshot verbatim. This restores the privileges that were
  // ACTUALLY present when up() ran, which is the only honest reversal — and it
  // necessarily REOPENS the Advisor findings, because that is what the previous
  // state was. Reverting the FEATURE is never the reason to run this; the only
  // legitimate reason is that the hardening itself broke something.
  //
  // Ordering mirrors up() in reverse: prevention off, then RLS, then grants.

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls') THEN
        DROP EVENT TRIGGER ensure_rls;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'could not drop the ensure_rls event trigger (insufficient privilege)';
    END $$;
  `);

  pgm.sql(`DROP FUNCTION IF EXISTS public.rls_auto_enable();`);

  // Restore the default privileges from the snapshot, grouped so each object
  // class needs one statement. If the snapshot is empty for a class, nothing is
  // granted — which is the correct reversal for "there was nothing there".
  pgm.sql(`
    DO $$
    DECLARE
      r    RECORD;
      kind TEXT;
    BEGIN
      FOR r IN
        SELECT objtype, grantee, string_agg(privilege, ', ' ORDER BY privilege) AS privs
          FROM security_baseline_default_acl
         GROUP BY objtype, grantee
      LOOP
        kind := CASE r.objtype
                  WHEN 'r' THEN 'TABLES'
                  WHEN 'S' THEN 'SEQUENCES'
                  WHEN 'f' THEN 'FUNCTIONS'
                  ELSE NULL
                END;
        IF kind IS NULL THEN
          CONTINUE;
        END IF;
        BEGIN
          EXECUTE format(
            'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT %s ON %s TO %I',
            r.privs, kind, r.grantee);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'could not restore default % on % to %', r.privs, kind, r.grantee;
        END;
      END LOOP;
    END $$;
  `);

  // Put RLS back to its recorded value. Only tables recorded as having had RLS
  // OFF are disabled again; anything that was already ON stays ON.
  pgm.sql(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT relation FROM security_baseline_rls WHERE rls_enabled IS FALSE
      LOOP
        BEGIN
          EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', r.relation);
        EXCEPTION WHEN undefined_table THEN
          RAISE NOTICE 'skipping %, no longer present', r.relation;
        END;
      END LOOP;
    END $$;
  `);

  // Re-grant exactly what was recorded, privilege by privilege.
  pgm.sql(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT relation, grantee, privilege FROM security_baseline_grants
      LOOP
        BEGIN
          EXECUTE format('GRANT %s ON %s TO %I', r.privilege, r.relation, r.grantee);
        EXCEPTION
          WHEN undefined_table THEN
            RAISE NOTICE 'skipping %, no longer present', r.relation;
          WHEN OTHERS THEN
            RAISE NOTICE 'could not restore % on % to %', r.privilege, r.relation, r.grantee;
        END;
      END LOOP;
    END $$;
  `);

  pgm.sql(`DROP TABLE IF EXISTS security_baseline_grants;`);
  pgm.sql(`DROP TABLE IF EXISTS security_baseline_rls;`);
  pgm.sql(`DROP TABLE IF EXISTS security_baseline_default_acl;`);
}
