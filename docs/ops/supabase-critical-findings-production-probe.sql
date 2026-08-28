-- =============================================================================
-- READ-ONLY production exposure probe — Supabase project `athoor-loyalty-production1`
-- =============================================================================
--
-- PURPOSE
--   Establish, from the production catalogue itself, exactly which relations and
--   columns are reachable by the Supabase Data API roles (`anon`,
--   `authenticated`), and therefore exactly what is behind the two CRITICAL
--   Security Advisor findings `rls_disabled_in_public` and
--   `sensitive_columns_exposed`.
--
-- WHY THIS IS OWNER-RUN RATHER THAN AUTOMATED
--   Production credentials are deliberately absent from this repository. The only
--   DATABASE_URL present in the working tree points at the retired dev/staging
--   project (ref zgmdosehusllotkpdshw), whose figures were explicitly discarded
--   in docs/ops/phase0-production-baseline.md. Guessing that staging and
--   production share a posture would repeat the exact error that document was
--   written to prevent — correct query, wrong target, confident conclusion.
--   Staging has since been measured and is CLEAN, which makes it useless as
--   evidence about production: production is the instance that raised the alert.
--
-- SAFETY
--   Every statement below is a SELECT against system catalogues. There is no
--   INSERT, UPDATE, DELETE, GRANT, REVOKE, ALTER or CREATE anywhere in this file.
--   It reads NO application row data: no email, no customer id, no balance —
--   only relation names, column names and privilege bits. It is safe to run on a
--   live production database during traffic, and it changes nothing.
--
-- HOW TO RUN
--   1. Supabase Dashboard -> project `athoor-loyalty-production1` -> SQL Editor.
--   2. Paste this entire file and run it.
--   3. Copy the single JSON result back.
--
--   The whole report is ONE row of JSON on purpose, so nothing is lost to
--   scrolling or to copying only the first of several result grids.
-- =============================================================================

WITH api_roles AS (
    -- Only roles that actually exist, so the probe cannot error on an instance
    -- where one is absent.
    SELECT rolname::text AS role
      FROM pg_roles
     WHERE rolname IN ('anon', 'authenticated')
),

relations AS (
    SELECT c.oid,
           c.relname::text                                   AS name,
           c.relkind,
           c.relrowsecurity                                  AS rls_enabled,
           c.relforcerowsecurity                             AS rls_forced,
           pg_get_userbyid(c.relowner)::text                 AS owner,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
),

-- Effective table privileges. has_table_privilege() is used rather than a plain
-- grant listing because it resolves role inheritance and privileges granted to
-- PUBLIC, both of which a relacl scan alone would miss.
rel_privs AS (
    SELECT r.name,
           r.relkind,
           r.rls_enabled,
           r.rls_forced,
           r.owner,
           r.policies,
           a.role,
           ARRAY_REMOVE(ARRAY[
               CASE WHEN has_table_privilege(a.role, r.oid, 'SELECT')     THEN 'SELECT'     END,
               CASE WHEN has_table_privilege(a.role, r.oid, 'INSERT')     THEN 'INSERT'     END,
               CASE WHEN has_table_privilege(a.role, r.oid, 'UPDATE')     THEN 'UPDATE'     END,
               CASE WHEN has_table_privilege(a.role, r.oid, 'DELETE')     THEN 'DELETE'     END,
               CASE WHEN has_table_privilege(a.role, r.oid, 'TRUNCATE')   THEN 'TRUNCATE'   END,
               CASE WHEN has_table_privilege(a.role, r.oid, 'REFERENCES') THEN 'REFERENCES' END,
               CASE WHEN has_table_privilege(a.role, r.oid, 'TRIGGER')    THEN 'TRIGGER'    END
           ], NULL)::text[] AS privileges
      FROM relations r
      CROSS JOIN api_roles a
),

-- Columns whose NAME suggests personal or bearer data, and which an API role can
-- actually read. Column names only; no value is ever selected.
--
-- WHY THE PREDICATE IS EXPLICIT RATHER THAN SHORT
--   `sensitive_columns_exposed` below is a COUNT, and it is the number that maps to
--   Supabase's CRITICAL advisory. A count is only useful if each member earns its
--   place, so the alternation names whole column names rather than short fragments.
--   Measured against the 109 columns the migrations actually create, the previous
--   predicate produced three false positives out of twelve matches — 25% noise in the
--   number a security decision rests on — and missed a genuine bearer value.
--
--   REMOVED, with the column that proved it:
--     bare `code`  -> matched `markets.code` (a market code such as "GB"),
--                     `idempotency_keys.status_code` (an HTTP status integer) and
--                     `redemptions.discount_code_id` (an opaque UUID foreign key that
--                     reveals no code). `referral_code` stays in the alternation; the
--                     genuinely redeemable `discount_codes.code` is table-scoped below,
--                     because it is named just `code`.
--     bare `birth` -> matched `customer_communication_preferences.birthday_messages`,
--                     which is a BOOLEAN opt-in toggle and holds no birth date.
--                     Replaced by the specific date columns.
--
--   ADDED, with the reason:
--     `idempotency_key` -> `redemptions.idempotency_key` is a replay credential: a
--                     reader who has it can observe, and correlate, a redemption.
--                     It was matched by nothing before.
--     `signature`   -> an HMAC or App Proxy signature is a bearer value. No such
--                     column exists today; it is listed so one added later is caught
--                     on the first run rather than after an incident.
--     `postal_code`, `zip` -> the non-UK spellings of `postcode`. Same reason.
--
--   DELIBERATELY NOT ADDED — both were tried and rejected on the evidence:
--     `name`  -> there is no customer-name column anywhere in this schema. Shopify
--                owns identity, so the only matches would be `benefits.name` (a
--                catalogue label) and `scheduled_runs.job_name`. Adding it would add
--                two false positives and catch no PII.
--     `key`   -> would match `benefits.key`, a benefit identifier such as
--                `free_shipping`, which is not sensitive. The one `key` column that
--                IS sensitive is named table-scoped below instead.
sensitive AS (
    SELECT r.name AS relation,
           att.attname::text AS column_name,
           a.role
      FROM relations r
      JOIN pg_attribute att ON att.attrelid = r.oid
      CROSS JOIN api_roles a
     WHERE att.attnum > 0
       AND NOT att.attisdropped
       AND (
             att.attname::text ~* '(email|phone|birth_month|birth_day|birth_date|date_of_birth|dob|token|secret|password|hash|ip_address|user_agent|address|postcode|postal_code|zip|shopify_customer_id|referral_code|idempotency_key|signature)'
             -- TABLE-SCOPED, for the two columns a name-only heuristic cannot decide.
             --
             -- `idempotency_keys.key` is the stored idempotency key itself: a replay
             -- credential. `benefits.key` is a catalogue identifier such as
             -- `free_shipping` and is not. Naming the relation catches one, not both.
             --
             -- `discount_codes.code` is a REDEEMABLE code — the one genuinely bearer
             -- value among the `code` columns. It cannot be reached by matching
             -- `discount_code`, because the column is named just `code`; that fragment
             -- matches only `redemptions.discount_code_id`, an opaque UUID foreign key
             -- that reveals no code at all. Matching the fragment and missing the code
             -- was precisely the wrong way round, so the relation is named instead.
             OR (r.name = 'idempotency_keys' AND att.attname::text = 'key')
             OR (r.name = 'discount_codes'   AND att.attname::text = 'code')
           )
       AND has_column_privilege(a.role, r.oid, att.attname::text, 'SELECT')
),

-- A SECURITY DEFINER function reachable as a PostgREST RPC runs with its owner's
-- rights. Functions returning a pseudo-type (trigger / event_trigger) are
-- EXCLUDED because Postgres refuses to invoke them directly and PostgREST cannot
-- expose them, so counting them produces a false critical.
definer_fns AS (
    SELECT p.proname::text AS function_name,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_catalog.format_type(p.prorettype, NULL) AS return_type,
           t.typtype = 'p' AS returns_pseudo_type,
           ARRAY(SELECT a.role FROM api_roles a
                  WHERE has_function_privilege(a.role, p.oid, 'EXECUTE'))::text[] AS executable_by
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_type t      ON t.oid = p.prorettype
     WHERE n.nspname = 'public'
       AND p.prosecdef IS TRUE
)

SELECT jsonb_pretty(jsonb_build_object(

  'probe', jsonb_build_object(
      'purpose',        'read-only Data API exposure audit',
      'captured_at',    now(),
      'connected_as',   current_user,
      'database',       current_database(),
      'server_version', current_setting('server_version'),
      'expected_target','athoor-loyalty-production1 — CONFIRM this is production before trusting the result'
  ),

  -- Decides whether hardening can break the Render backend. `postgres` is
  -- expected to show bypassrls = true and to own every relation; if so, enabling
  -- RLS cannot affect it. service_role showing bypassrls = true is also expected
  -- and is why REVOKE, not RLS, is the binding control.
  'roles', (
      SELECT jsonb_agg(jsonb_build_object(
                 'role',       rolname,
                 'can_login',  rolcanlogin,
                 'bypass_rls', rolbypassrls,
                 'superuser',  rolsuper
             ) ORDER BY rolname)
        FROM pg_roles
       WHERE rolname IN ('anon','authenticated','service_role','authenticator','postgres')
  ),

  'schema_public_acl', (
      SELECT COALESCE(nspacl::text[], ARRAY['(null)'])
        FROM pg_namespace WHERE nspname = 'public'
  ),

  -- What a NEWLY created table would inherit. This is the fact that determines
  -- whether the four pending Task 6 tables would be born exposed.
  'default_privileges', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
                 'granted_by', pg_get_userbyid(d.defaclrole),
                 'objtype',    d.defaclobjtype,
                 'acl',        d.defaclacl::text[]
             ))
        FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
       WHERE n.nspname = 'public'
  ), '[]'::jsonb),

  'counts', jsonb_build_object(
      'relations_in_public',        (SELECT count(*) FROM relations),
      'tables_with_rls_disabled',   (SELECT count(*) FROM relations WHERE relkind IN ('r','p') AND rls_enabled IS FALSE),
      'tables_with_rls_forced',     (SELECT count(*) FROM relations WHERE relkind IN ('r','p') AND rls_forced IS TRUE),
      'relations_readable_by_api',  (SELECT count(DISTINCT name) FROM rel_privs WHERE 'SELECT' = ANY(privileges)),
      'relations_writable_by_api',  (SELECT count(DISTINCT name) FROM rel_privs
                                      WHERE privileges && ARRAY['INSERT','UPDATE','DELETE']::text[]),
      'sensitive_columns_exposed',  (SELECT count(*) FROM sensitive)
  ),

  -- Confirms which migrations production has actually applied. Expect 15 and a
  -- latest of `1785900000000_benefit-request-lifecycle`: that is the state in
  -- which the four additive Task 6 migrations are still PENDING, which is the
  -- state this work is required to preserve.
  'migration_state', jsonb_build_object(
      'applied_count', (SELECT count(*) FROM pgmigrations),
      'latest',        (SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1),
      'task6_pending', NOT EXISTS (SELECT 1 FROM pgmigrations WHERE name LIKE '1786%'),
      'hardening_applied', EXISTS (SELECT 1 FROM pgmigrations WHERE name LIKE '1785950000000%')
  ),

  'per_relation', (
      SELECT jsonb_agg(x ORDER BY x->>'relation')
        FROM (
          SELECT jsonb_build_object(
                   'relation',      name,
                   'kind',          CASE relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned'
                                                 WHEN 'v' THEN 'view'  WHEN 'm' THEN 'materialized_view'
                                                 WHEN 'f' THEN 'foreign' END,
                   'owner',         owner,
                   'rls_enabled',   rls_enabled,
                   'rls_forced',    rls_forced,
                   'policies',      policies,
                   'anon',          COALESCE(MAX(CASE WHEN role='anon'          THEN privileges END), ARRAY[]::text[]),
                   'authenticated', COALESCE(MAX(CASE WHEN role='authenticated' THEN privileges END), ARRAY[]::text[])
                 ) AS x
            FROM rel_privs
           GROUP BY name, relkind, owner, rls_enabled, rls_forced, policies
        ) s
  ),

  'sensitive_columns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('relation', relation, 'column', column_name, 'readable_by', roles)
                       ORDER BY relation, column_name)
        FROM (SELECT relation, column_name, array_agg(role ORDER BY role)::text[] AS roles
                FROM sensitive GROUP BY relation, column_name) g
  ), '[]'::jsonb),

  'security_definer_functions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
                 'function',            function_name || '(' || args || ')',
                 'return_type',         return_type,
                 'not_directly_callable', returns_pseudo_type,
                 'executable_by',       executable_by
             ) ORDER BY function_name)
        FROM definer_fns WHERE cardinality(executable_by) > 0
  ), '[]'::jsonb),

  -- Staging carries an `ensure_rls` event trigger that auto-enables RLS on new
  -- tables, installed by hand and recorded in no migration. Its presence or
  -- absence here explains any staging/production divergence.
  'event_triggers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
                 'name',     evtname,
                 'event',    evtevent,
                 'enabled',  evtenabled,
                 'function', (SELECT p.proname FROM pg_proc p WHERE p.oid = e.evtfoid)
             ) ORDER BY evtname)
        FROM pg_event_trigger e
  ), '[]'::jsonb),

  'verdict', CASE
      WHEN (SELECT count(*) FROM rel_privs
             WHERE privileges && ARRAY['SELECT','INSERT','UPDATE','DELETE']::text[]) > 0
        THEN 'EXPOSED — at least one API role holds a data privilege in public. The CRITICAL findings are REAL.'
      WHEN (SELECT count(*) FROM relations WHERE relkind IN ('r','p') AND rls_enabled IS FALSE) > 0
        THEN 'PARTIAL — no API role holds a data privilege, but RLS is disabled somewhere. The Advisor finding is technically correct and not currently reachable.'
      ELSE 'CLEAN — no API role holds a data privilege and RLS is enabled everywhere. Treat the findings as already remediated and re-run the Advisor.'
  END

)) AS production_exposure_report;
