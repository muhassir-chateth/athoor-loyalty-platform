/**
 * `scripts/migration/_shared.mjs` — the operator CLI redactor.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `redact()` promises, in its own docstring, that "printed output can never carry a
 * customer email address or a secret". It used to mask two shapes: a Shopify token
 * and an email address. A Postgres connection string is a secret, and it was not
 * masked — so the function did not keep its own contract.
 *
 * The repository already knew. `migrateDownGuard.test.ts` contains
 *
 *     it("does not use runMain, whose redact does not mask a connection string")
 *
 * and `migrate-down-guard.mjs` was written without `runMain` for exactly that
 * reason. But that workaround covered ONE of four exposed scripts: `m0-export.mjs`,
 * `m1-backfill.mjs` and `m1-recovery.mjs` all call `runMain` and all connect using
 * `DATABASE_URL`, so any unexpected throw printed an error message through the
 * unmasking redactor. Those three are the production cutover scripts.
 *
 * ── THE ORACLE IS THE SERVICE'S OWN DEFINITION ───────────────────────────────
 * The patterns asserted below are transcribed from
 * `src/observability/logCapture.gate.test.ts`, which is the repository's existing
 * statement of what counts as secret-shaped in a log line. Two redactors with
 * different ideas of what a secret is was the underlying problem, so the test uses
 * the stricter one as the standard rather than inventing a third.
 *
 * SAFETY: pure string functions. No network, no database, no process spawned. Every
 * credential below is a fake with an obvious bait marker.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a `.mjs` operator script with no type declarations; it is
// plain JavaScript by design (it must run under bare `node` with no build step).
import { redact, redactString } from "../../scripts/migration/_shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "..", "..", "scripts", "migration");

/** Obvious fakes. Each carries a bait marker so a real leak is never mistaken for one. */
const FAKE = {
  pgUrl: "postgres://loyalty_user:FAKE_BAIT_PG_PASSWORD@db.example.invalid:5432/loyalty",
  pgUrlNoCreds: "postgresql://db.example.invalid:5432/loyalty",
  mysqlUrl: "mysql://root:FAKE_BAIT_MYSQL_PW@mysql.example.invalid:3306/app",
  mongoUrl: "mongodb+srv://svc:FAKE_BAIT_MONGO_PW@cluster.example.invalid/db",
  amqpUrl: "amqps://svc:FAKE_BAIT_AMQP_PW@queue.example.invalid:5671/vhost",
  adminToken: "shpat_FAKEBAITADMINTOKEN0123456789",
  secret: "shpss_FAKEBAITSHAREDSECRET0123456789",
  storefront: "shppa_FAKEBAITSTOREFRONT0123456789",
  customerAccount: "shpca_FAKEBAITCUSTOMERACCT0123456789",
  userToken: "shpus_FAKEBAITUSERTOKEN0123456789",
  bearer: "Bearer FAKEBAITBEARERVALUE0123456789",
  basic: "Basic ZmFrZTpiYWl0cGFzc3dvcmQxMjM0",
  email: "bait.customer@example.invalid",
  privateKey:
    "-----BEGIN PRIVATE KEY-----\nFAKEBAITPRIVATEKEYLINE1\nFAKEBAITPRIVATEKEYLINE2\n-----END PRIVATE KEY-----",
} as const;

/** The password substrings that must never survive redaction. */
const MUST_NOT_SURVIVE: readonly string[] = [
  "FAKE_BAIT_PG_PASSWORD",
  "FAKE_BAIT_MYSQL_PW",
  "FAKE_BAIT_MONGO_PW",
  "FAKE_BAIT_AMQP_PW",
  "FAKEBAITADMINTOKEN",
  "FAKEBAITSHAREDSECRET",
  "FAKEBAITSTOREFRONT",
  "FAKEBAITCUSTOMERACCT",
  "FAKEBAITUSERTOKEN",
  "FAKEBAITBEARERVALUE",
  "ZmFrZTpiYWl0cGFzc3dvcmQxMjM0",
  "bait.customer",
  "FAKEBAITPRIVATEKEYLINE1",
];

describe("the operator redactor masks every secret shape, not only two", () => {
  it("masks the credentials in a Postgres connection string — the reported gap", () => {
    const out = redactString(FAKE.pgUrl) as string;
    expect(out).not.toContain("FAKE_BAIT_PG_PASSWORD");
    expect(out).not.toContain("loyalty_user");
    // The whole URI goes, because a full connection string is what must never be
    // pasted into a ticket.
    expect(out).toBe("[redacted-database-uri]");
  });

  it("masks a database URI even with no inline credentials", () => {
    expect(redactString(FAKE.pgUrlNoCreds)).toBe("[redacted-database-uri]");
  });

  it("masks credentials in a NON-database URI, keeping the host readable", () => {
    // The userinfo rule is not database-specific. A queue or webhook URL with
    // embedded credentials is the same class of leak, and here the host must survive
    // so the failure stays diagnosable.
    const out = redactString(FAKE.amqpUrl) as string;
    expect(out).not.toContain("FAKE_BAIT_AMQP_PW");
    expect(out).not.toContain("svc:");
    expect(out).toContain("[redacted-credentials]@");
    expect(out).toContain("queue.example.invalid");
  });

  it("masks mysql and mongodb+srv URIs too", () => {
    expect(redactString(FAKE.mysqlUrl)).not.toContain("FAKE_BAIT_MYSQL_PW");
    expect(redactString(FAKE.mongoUrl)).not.toContain("FAKE_BAIT_MONGO_PW");
  });

  it("masks all five Shopify credential prefixes, not just a two-letter shape", () => {
    for (const token of [
      FAKE.adminToken,
      FAKE.secret,
      FAKE.storefront,
      FAKE.customerAccount,
      FAKE.userToken,
    ]) {
      expect(redactString(token), `${token.slice(0, 6)} survived`).toBe("[redacted-token]");
    }
  });

  it("masks Bearer and Basic header values, keeping the scheme", () => {
    expect(redactString(FAKE.bearer)).toBe("Bearer [redacted-credential]");
    expect(redactString(FAKE.basic)).toBe("Basic [redacted-credential]");
  });

  it("masks a private key block whole", () => {
    const out = redactString(`key follows: ${FAKE.privateKey} :end`) as string;
    expect(out).not.toContain("FAKEBAITPRIVATEKEYLINE1");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).toContain("[redacted-private-key]");
  });

  it("still masks an email address", () => {
    expect(redactString(`from ${FAKE.email} sent`)).toBe("from [redacted-email] sent");
  });

  it("masks every secret in one string containing all of them", () => {
    const soup = Object.values(FAKE).join(" | ");
    const out = redactString(soup) as string;
    for (const secret of MUST_NOT_SURVIVE) {
      expect(out, `"${secret}" survived redaction`).not.toContain(secret);
    }
  });
});

describe("redact() applies the same masking through nested structures", () => {
  it("masks a connection string nested in an object, an array and a deep tree", () => {
    const payload = {
      phase: "m1",
      databaseUrl: FAKE.pgUrl,
      attempts: [{ error: `could not connect to ${FAKE.pgUrl}` }],
      nested: { deep: { deeper: { token: FAKE.adminToken } } },
    };
    const out = JSON.stringify(redact(payload));
    for (const secret of ["FAKE_BAIT_PG_PASSWORD", "FAKEBAITADMINTOKEN", "loyalty_user"]) {
      expect(out, `"${secret}" survived`).not.toContain(secret);
    }
    // The non-secret structure survives, or the tooling reports nothing useful.
    expect(out).toContain("m1");
    expect(out).toContain("attempts");
  });

  it("still drops email and emails keys entirely", () => {
    const out = redact({ email: FAKE.email, emails: [FAKE.email], id: "123" }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out)).toEqual(["id"]);
  });

  it("leaves IDENTIFIERS intact, which is the point of these scripts", () => {
    // The service's log gate also forbids long digit runs and UUIDs. Those are NOT
    // masked here, deliberately: `redact`'s contract is that "customers are
    // referenced by Shopify id only", so masking ids would remove the only thing the
    // cutover reports. The split is secrets-masked, identifiers-kept.
    const out = redact({
      shopifyCustomerId: "1234567890123",
      customerId: "0b3f4c2e-1111-4222-8333-444455556666",
      count: 4096,
    }) as Record<string, unknown>;
    expect(out.shopifyCustomerId).toBe("1234567890123");
    expect(out.customerId).toBe("0b3f4c2e-1111-4222-8333-444455556666");
    expect(out.count).toBe(4096);
  });

  it("preserves non-string scalars rather than stringifying them", () => {
    const out = redact({ n: 0, t: true, f: false, nul: null }) as Record<string, unknown>;
    expect(out).toEqual({ n: 0, t: true, f: false, nul: null });
  });
});

describe("runMain prints nothing unredacted — message, code or stack", () => {
  /**
   * The inconsistency this closes.
   *
   * A V8 stack BEGINS with `${name}: ${message}`. The old code redacted `err.stack`
   * and printed `err.message` raw on the line above it, so the same text was masked
   * once and leaked once, two lines apart.
   */
  const source = readFileSync(join(SCRIPTS, "_shared.mjs"), "utf8");
  const body = /export async function runMain\([\s\S]*?\n}/.exec(source)?.[0] ?? "";

  it("has a runMain whose catch block is fully covered", () => {
    expect(body, "runMain not found").not.toBe("");
    // Every printed expression is wrapped. Asserted as "no bare interpolation of an
    // error field", which is the shape of the defect.
    expect(body).not.toMatch(/\$\{\s*err\.message\s*\}/);
    expect(body).not.toMatch(/\$\{\s*String\(err\)\s*\}/);
    expect(body).not.toMatch(/\$\{\s*String\(err\.code\)\s*\}/);
    expect(body).toMatch(/redactString\(err instanceof Error \? err\.message : String\(err\)\)/);
    expect(body).toMatch(/redactString\(String\(err\.code\)\)/);
    expect(body).toMatch(/redactString\(err\.stack\)/);
  });

  it("a thrown error carrying a connection string is masked on EVERY printed line", () => {
    // The end-to-end behaviour, simulated over the three strings runMain prints.
    const err = Object.assign(
      new Error(`connect ECONNREFUSED for ${FAKE.pgUrl}`),
      { code: `ENOTFOUND ${FAKE.pgUrl}` },
    );
    const printed = [
      redactString(err.message),
      redactString(String(err.code)),
      redactString(err.stack ?? ""),
    ].join("\n");
    expect(printed).not.toContain("FAKE_BAIT_PG_PASSWORD");
    expect(printed).not.toContain("loyalty_user");
    // And the diagnosis survives: the operator still learns what failed.
    expect(printed).toContain("ECONNREFUSED");
    expect(printed).toContain("ENOTFOUND");
  });

  /**
   * The previous implementation, reproduced exactly, so the tests above demonstrably
   * assert a change rather than restating behaviour that already held.
   */
  const oldRedact = (v: string): string =>
    v
      .replace(/shp[a-z]{2}_[A-Za-z0-9]+/g, "[redacted-token]")
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[redacted-email]");

  it("is NON-VACUOUS: the old redactor leaked a password whenever the host had no dot", () => {
    // ── THE MOST IMPORTANT CASE ────────────────────────────────────────────────
    // The old rules had no URI rule at all. A password was masked only BY ACCIDENT,
    // when `password@host.tld` happened to match the EMAIL pattern. That accident
    // requires a dot in the host — so `localhost`, a Docker service name and a
    // Kubernetes service name all leaked the password in full.
    for (const host of ["localhost", "postgres", "db-primary"]) {
      const url = `postgres://svc:FAKE_BAIT_DOTLESS_PW@${host}:5432/loyalty`;
      expect(oldRedact(url), `old rules masked a dotless host (${host})`).toContain(
        "FAKE_BAIT_DOTLESS_PW",
      );
      expect(redactString(url), `new rules leak on ${host}`).not.toContain("FAKE_BAIT_DOTLESS_PW");
    }
  });

  it("is NON-VACUOUS: the old redactor leaked a password prefix on any special character", () => {
    // The email pattern's local-part is `[\w.+-]+`, so it can only start matching
    // after the last character the password contains outside that set. Everything
    // before that point survives — and generated database passwords routinely contain
    // `$`, `!`, `/`, `%` and `#`.
    for (const [password, survivingPrefix] of [
      ["Pa$$w0rd!x", "Pa$$w0rd!"],
      ["ab/cd+ef", "ab/"],
      ["se%2Fcret", "se%"],
      ["hunter#2", "hunter#"],
    ] as const) {
      const url = `postgres://svc:${password}@db.example.invalid:5432/loyalty`;
      expect(oldRedact(url), `old rules masked "${password}"`).toContain(survivingPrefix);
      expect(redactString(url), `new rules leak "${password}"`).not.toContain(survivingPrefix);
    }
  });

  it("is NON-VACUOUS: the old redactor kept the username in every case", () => {
    // Even where the accident masked the password, the username always survived.
    expect(oldRedact(FAKE.pgUrl)).toContain("loyalty_user");
    expect(redactString(FAKE.pgUrl)).not.toContain("loyalty_user");
  });

  it("is NON-VACUOUS: the old redactor missed Bearer headers and private keys entirely", () => {
    expect(oldRedact(FAKE.bearer)).toContain("FAKEBAITBEARERVALUE");
    expect(oldRedact(FAKE.privateKey)).toContain("FAKEBAITPRIVATEKEYLINE1");
    expect(redactString(FAKE.bearer)).not.toContain("FAKEBAITBEARERVALUE");
    expect(redactString(FAKE.privateKey)).not.toContain("FAKEBAITPRIVATEKEYLINE1");
  });

  it("is NON-VACUOUS: the old redactor missed three of five Shopify prefixes", () => {
    // `shp[a-z]{2}_[A-Za-z0-9]+` has no `_` in its body, so it truncated at the first
    // underscore rather than masking the whole token.
    const withUnderscore = "shpat_FAKE_BAIT_TOKEN_WITH_UNDERSCORES";
    expect(oldRedact(withUnderscore)).toContain("BAIT");
    expect(redactString(withUnderscore)).toBe("[redacted-token]");
  });
});

describe("every operator script that connects to Postgres is now covered", () => {
  /** Executable code only — these headers name the things they refuse to do. */
  function code(file: string): string {
    return readFileSync(join(SCRIPTS, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const CUTOVER_SCRIPTS = [
    "m0-export.mjs",
    "m1-backfill.mjs",
    "m1-recovery.mjs",
    "metafield-rollback.mjs",
    "migrate-down-guard.mjs",
  ] as const;

  it("the three DATABASE_URL scripts that use runMain are the ones this fix protects", () => {
    // Recorded as a census so the exposure is stated rather than implied. If a fourth
    // script starts using both, this list is where that becomes visible.
    const exposed = CUTOVER_SCRIPTS.filter((file) => {
      const c = code(file);
      return c.includes("runMain(") && c.includes("DATABASE_URL");
    });
    expect(exposed.sort()).toEqual(["m0-export.mjs", "m1-backfill.mjs", "m1-recovery.mjs"]);
  });

  it("no operator script prints DATABASE_URL directly", () => {
    for (const file of CUTOVER_SCRIPTS) {
      const c = code(file);
      expect(c, `${file} logs databaseUrl`).not.toMatch(/console\.(error|log)\([^)]*databaseUrl/);
      expect(c, `${file} logs process.env.DATABASE_URL`).not.toMatch(
        /console\.(error|log)\([^)]*process\.env\.DATABASE_URL/,
      );
    }
  });

  it("migrate-down-guard keeps avoiding runMain, as defence in depth", () => {
    // Its workaround is no longer the only protection, but it is still correct and is
    // not being removed: two independent guards on the most destructive script is the
    // right amount. Its own suite asserts this too; duplicated here so the reason is
    // recorded next to the fix that changed the context.
    expect(code("migrate-down-guard.mjs")).not.toContain("runMain(");
  });
});
