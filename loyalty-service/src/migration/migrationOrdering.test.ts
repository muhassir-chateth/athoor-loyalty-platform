/**
 * Migration filename ordering — the invariant behind a duplicate timestamp.
 *
 * ── THE OBSERVATION ──────────────────────────────────────────────────────────
 * Two migrations share the prefix `1785000000000`:
 *
 *     1785000000000_create-device-tokens.ts
 *     1785000000000_create-market-config.ts
 *
 * `node-pg-migrate` orders by filename, so a tie is broken alphabetically. That is
 * deterministic, but it is determined by a coincidence of spelling rather than by
 * intent — and neither file says anything about the other.
 *
 * ── WHY IT IS SAFE HERE, ESTABLISHED RATHER THAN ASSUMED ─────────────────────
 * Their object sets are disjoint:
 *
 *     device-tokens  creates device_tokens, notification_events; references customers
 *     market-config  creates markets, earning_rule_sets, reward_rule_sets;
 *                    references markets, which it creates itself
 *
 * Neither references anything the other creates, so either order produces the same
 * schema. The duplicate is untidy, not dangerous.
 *
 * ── WHY THE FILES ARE NOT RENAMED ────────────────────────────────────────────
 * Both are applied in production. `pgmigrations` records the name that ran, so
 * renaming a file makes the recorded row and the file disagree: `node-pg-migrate`
 * would see an unrecognised migration and try to apply it again. Renaming an applied
 * migration to tidy a filename is a far larger risk than the ambiguity it removes.
 * So the files stay exactly as they are, and the SAFETY PROPERTY is asserted instead.
 *
 * ── WHAT THIS GUARDS AGAINST ─────────────────────────────────────────────────
 * The next duplicate. A future pair sharing a timestamp where one creates a table the
 * other references is a real ordering hazard, and alphabetical luck decides whether
 * the migration run succeeds. This test permits a duplicate only while the pair
 * remains order-independent, so that case fails at CI rather than during a deploy.
 *
 * SAFETY: reads the migration files. No database, nothing executed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

interface Migration {
  readonly file: string;
  readonly timestamp: string;
  /** Tables and other objects this migration CREATES. */
  readonly creates: readonly string[];
  /** Objects this migration REFERENCES but does not create. */
  readonly references: readonly string[];
}

function parseMigrations(): Migration[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  return files.map((file) => {
    const source = readFileSync(join(MIGRATIONS, file), "utf8");
    const creates = [
      ...source.matchAll(/create\s+table(?:\s+if\s+not\s+exists)?\s+"?([a-z_][a-z0-9_]*)"?/gi),
    ].map((m) => (m[1] ?? "").toLowerCase());
    const referenced = [...source.matchAll(/references\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) =>
      (m[1] ?? "").toLowerCase(),
    );
    // A self-reference (a table referencing one it creates) is not a cross-migration
    // dependency, so it is removed here — otherwise `market-config` would look
    // dependent on itself.
    const references = [...new Set(referenced)].filter((table) => !creates.includes(table));
    return {
      file,
      timestamp: (/^(\d+)_/.exec(file)?.[1] ?? ""),
      creates: [...new Set(creates)],
      references,
    };
  });
}

const MIGRATIONS_PARSED = parseMigrations();

describe("the migration parser reads the real directory", () => {
  it("found every migration and extracted its objects", () => {
    // A parser that returned nothing would make every assertion below vacuous.
    expect(MIGRATIONS_PARSED.length).toBeGreaterThan(20);
    expect(MIGRATIONS_PARSED.every((m) => m.timestamp !== "")).toBe(true);
    const totalCreates = MIGRATIONS_PARSED.flatMap((m) => m.creates);
    expect(totalCreates.length).toBeGreaterThan(20);
    // Spot-checks, so a silent regex regression is caught.
    const ledger = MIGRATIONS_PARSED.find((m) => m.file.includes("create-ledger-core"));
    expect(ledger?.creates).toContain("customers");
    const market = MIGRATIONS_PARSED.find((m) => m.file.includes("create-market-config"));
    expect(market?.creates).toContain("markets");
    // And the self-reference really is excluded.
    expect(market?.references).not.toContain("markets");
  });
});

describe("a duplicate migration timestamp is permitted only while the pair is order-independent", () => {
  /** Timestamps used by more than one migration. */
  function duplicateGroups(): Migration[][] {
    const byTimestamp = new Map<string, Migration[]>();
    for (const migration of MIGRATIONS_PARSED) {
      const group = byTimestamp.get(migration.timestamp) ?? [];
      group.push(migration);
      byTimestamp.set(migration.timestamp, group);
    }
    return [...byTimestamp.values()].filter((group) => group.length > 1);
  }

  it("records exactly which timestamps are duplicated, so a new one is visible", () => {
    // A census, not an allowance. A third file joining `1785000000000`, or a second
    // duplicated timestamp appearing, fails here and is reviewed.
    const groups = duplicateGroups().map((group) => group.map((m) => m.file).sort());
    expect(groups).toEqual([
      ["1785000000000_create-device-tokens.ts", "1785000000000_create-market-config.ts"],
    ]);
  });

  it("no duplicate pair has a dependency between them, so the order cannot matter", () => {
    // THE SAFETY PROPERTY. If one member creates a table the other references, the
    // alphabetical tie-break decides whether the run succeeds — and nothing declares
    // that. This is the assertion that would fail on such a pair.
    const offenders: string[] = [];
    for (const group of duplicateGroups()) {
      for (const a of group) {
        for (const b of group) {
          if (a.file === b.file) continue;
          const dependency = b.references.filter((table) => a.creates.includes(table));
          if (dependency.length > 0) {
            offenders.push(
              `${b.file} references ${dependency.join(", ")} created by ${a.file} — same timestamp, so the order is alphabetical luck`,
            );
          }
        }
      }
    }
    expect(offenders, `ordering-sensitive duplicate timestamps:\n  ${offenders.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("the known pair is disjoint in both directions, stated explicitly", () => {
    // The evidence for leaving the duplicate alone, asserted rather than described.
    const devices = MIGRATIONS_PARSED.find((m) => m.file.includes("create-device-tokens"));
    const markets = MIGRATIONS_PARSED.find((m) => m.file.includes("create-market-config"));
    expect(devices).toBeDefined();
    expect(markets).toBeDefined();
    for (const table of devices?.references ?? []) {
      expect(markets?.creates ?? [], `device-tokens depends on ${table}`).not.toContain(table);
    }
    for (const table of markets?.references ?? []) {
      expect(devices?.creates ?? [], `market-config depends on ${table}`).not.toContain(table);
    }
  });

  it("is NON-VACUOUS: the check fires on a pair that IS ordering-sensitive", () => {
    // Proves the comparison would catch a real hazard rather than always passing.
    const hazardous: Migration[] = [
      { file: "1790_a-create-parent.ts", timestamp: "1790", creates: ["parent"], references: [] },
      { file: "1790_b-create-child.ts", timestamp: "1790", creates: ["child"], references: ["parent"] },
    ];
    const offenders: string[] = [];
    for (const a of hazardous) {
      for (const b of hazardous) {
        if (a.file === b.file) continue;
        if (b.references.some((t) => a.creates.includes(t))) offenders.push(`${b.file} needs ${a.file}`);
      }
    }
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("b-create-child");

    // And that a disjoint pair produces no complaint, so it is not simply always-firing.
    const safe: Migration[] = [
      { file: "1790_a.ts", timestamp: "1790", creates: ["x"], references: [] },
      { file: "1790_b.ts", timestamp: "1790", creates: ["y"], references: [] },
    ];
    const none: string[] = [];
    for (const a of safe) {
      for (const b of safe) {
        if (a.file === b.file) continue;
        if (b.references.some((t) => a.creates.includes(t))) none.push(b.file);
      }
    }
    expect(none).toEqual([]);
  });
});

describe("applied migrations are never renamed or rewritten", () => {
  it("every migration filename still starts with a numeric timestamp", () => {
    // `pgmigrations` records the filename that ran. A rename makes the recorded row
    // and the file disagree, and node-pg-migrate then treats the file as new and
    // applies it again — which is why the duplicate above is documented, not tidied.
    for (const migration of MIGRATIONS_PARSED) {
      expect(migration.file, `${migration.file} has no timestamp prefix`).toMatch(/^\d{13}_/);
    }
  });

  it("timestamps are non-decreasing in filename order, so sort order is time order", () => {
    // The property the prefix exists to provide. Equal is permitted — that is the
    // duplicate above, whose safety is asserted separately.
    const timestamps = MIGRATIONS_PARSED.map((m) => Number(m.timestamp));
    for (let i = 1; i < timestamps.length; i += 1) {
      expect(
        timestamps[i] as number,
        `${MIGRATIONS_PARSED[i]?.file} sorts before an earlier timestamp`,
      ).toBeGreaterThanOrEqual(timestamps[i - 1] as number);
    }
  });
});
