/**
 * Credential VERIFICATION ISOLATION tests (task 19.3, Requirement 19.5).
 *
 * These tests are DISTINCT from `credential.test.ts` (which covers issuing,
 * round-tripping, and the general shape of the service). Here the single
 * concern is the ISOLATION guarantee of the verification endpoint:
 *
 *   A presented signed identifier resolves to MEMBERSHIP + TIER ONLY and NEVER
 *   returns any other customer's data (Req 19.5).
 *
 * Concretely we prove three things, using only the pure signing/verification
 * core with a self-contained in-memory tier source — NO live Shopify, Postgres,
 * or ledger is touched:
 *
 *   1. A validly-presented identifier verifies to EXACTLY `{ valid, tier }` —
 *      the response carries no member id, no customer id, no PII, and no other
 *      customer field, whatever data other members hold.
 *   2. A tampered / invalid / foreign-signed identifier FAILS CLOSED to
 *      `{ valid: false }` and still exposes nothing.
 *   3. One customer's credential can NEVER resolve to another customer's data:
 *      the verification result depends only on the credential presented, is
 *      independent of every other member enrolled, and cross-presentation
 *      between two members leaks neither member's identity.
 */
import { describe, expect, it } from "vitest";
import {
  DefaultMembershipCredentialService,
  InMemoryMembershipTierSource,
  type CredentialVerification,
} from "./credential.js";
import type { Tier } from "../tier/tier.js";

const KEY = "isolation-dedicated-signing-key-0123456789abcdef";
const FOREIGN_KEY = "some-other-tenants-signing-key-fedcba9876543210";

// Two DISTINCT members whose PII/identifiers must never bleed into a verify
// response. The raw customer ids and their derived member ids are the exact
// strings the isolation guarantee forbids from appearing.
const ALICE = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tier: "gold" as Tier };
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tier: "bronze" as Tier };

/** Build a self-contained service backed by an in-memory tier source. */
function serviceWith(
  members: ReadonlyArray<{ id: string; tier: Tier }>,
  key: string | undefined = KEY,
) {
  const source = new InMemoryMembershipTierSource(
    Object.fromEntries(members.map((m) => [m.id, m.tier])),
  );
  return new DefaultMembershipCredentialService(key, source);
}

/**
 * Assert a verification result carries ONLY the allowed fields and leaks none
 * of the forbidden identifiers/PII, whether valid or invalid.
 */
function expectNoLeak(result: CredentialVerification, forbidden: string[]): void {
  // Only ever `valid` (+ `tier` when valid). No member id / customer id key.
  const allowedKeys = result.valid ? ["valid", "tier"] : ["valid"];
  expect(Object.keys(result).sort()).toEqual(allowedKeys.sort());
  const serialized = JSON.stringify(result);
  for (const secret of forbidden) {
    expect(serialized).not.toContain(secret);
  }
}

describe("verification isolation — response carries membership + tier ONLY (Req 19.5)", () => {
  it("a valid identifier resolves to exactly { valid, tier } and leaks no id/PII", async () => {
    const svc = serviceWith([ALICE, BOB]);
    const cred = await svc.issueCredential(ALICE.id);

    const result = await svc.verifyCredential(cred.qrPayload);

    expect(result).toEqual({ valid: true, tier: ALICE.tier });
    // Never the raw customer id, the opaque member id, or the signature.
    expectNoLeak(result, [ALICE.id, BOB.id, cred.memberId, cred.signature]);
  });

  it("the response never contains a member id, customer id, or signature field", async () => {
    const svc = serviceWith([ALICE]);
    const cred = await svc.issueCredential(ALICE.id);

    const result = (await svc.verifyCredential(cred.qrPayload)) as unknown as Record<
      string,
      unknown
    >;

    expect(result).not.toHaveProperty("memberId");
    expect(result).not.toHaveProperty("customerId");
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("signature");
    expect(result).not.toHaveProperty("qrPayload");
  });
});

describe("verification isolation — tampered / invalid / foreign fails closed (Req 19.5)", () => {
  it("a tampered tier fails closed and still leaks nothing", async () => {
    const svc = serviceWith([BOB]);
    const cred = await svc.issueCredential(BOB.id);
    const [version, memberId, , signature] = cred.qrPayload.split(".");
    // Upgrade the tier segment but keep the original signature.
    const forged = `${version}.${memberId}.royal_vip.${signature}`;

    const result = await svc.verifyCredential(forged);

    expect(result).toEqual({ valid: false });
    expectNoLeak(result, [BOB.id, cred.memberId, cred.signature]);
  });

  it("a tampered signature fails closed", async () => {
    const svc = serviceWith([ALICE]);
    const cred = await svc.issueCredential(ALICE.id);
    const [version, memberId, tier] = cred.qrPayload.split(".");
    const forged = `${version}.${memberId}.${tier}.forged-signature-value`;

    const result = await svc.verifyCredential(forged);

    expect(result).toEqual({ valid: false });
    expectNoLeak(result, [ALICE.id, cred.memberId]);
  });

  it("a credential signed by a foreign key fails closed (no cross-key trust)", async () => {
    const issuer = serviceWith([ALICE], KEY);
    const cred = await issuer.issueCredential(ALICE.id);

    // A verifier holding a DIFFERENT dedicated key must not trust it.
    const foreignVerifier = serviceWith([ALICE], FOREIGN_KEY);
    const result = await foreignVerifier.verifyCredential(cred.qrPayload);

    expect(result).toEqual({ valid: false });
    expectNoLeak(result, [ALICE.id, cred.memberId, cred.signature]);
  });

  it("malformed / empty payloads fail closed to { valid: false }", async () => {
    const svc = serviceWith([ALICE]);
    for (const bad of ["", "   ", "not-a-credential", "a.b.c", "a.b.c.d.e", "WRONG.m.gold.s"]) {
      const result = await svc.verifyCredential(bad);
      expect(result).toEqual({ valid: false });
      expectNoLeak(result, [ALICE.id]);
    }
  });
});

describe("verification isolation — one customer never resolves to another's data (Req 19.5)", () => {
  it("Alice's credential resolves only to Alice's tier, never Bob's", async () => {
    const svc = serviceWith([ALICE, BOB]);
    const aliceCred = await svc.issueCredential(ALICE.id);
    const bobCred = await svc.issueCredential(BOB.id);

    const aliceResult = await svc.verifyCredential(aliceCred.qrPayload);
    const bobResult = await svc.verifyCredential(bobCred.qrPayload);

    // Each resolves to its OWN tier only.
    expect(aliceResult).toEqual({ valid: true, tier: ALICE.tier });
    expect(bobResult).toEqual({ valid: true, tier: BOB.tier });
    // Neither response exposes the other member's identifiers.
    expectNoLeak(aliceResult, [BOB.id, bobCred.memberId, bobCred.signature]);
    expectNoLeak(bobResult, [ALICE.id, aliceCred.memberId, aliceCred.signature]);
  });

  it("the verification result is independent of who else is enrolled", async () => {
    // Issue Alice's credential in a service that ALSO knows Bob...
    const withBob = serviceWith([ALICE, BOB]);
    const aliceCred = await withBob.issueCredential(ALICE.id);

    // ...and verify it in a service that has never heard of any member (verify
    // is self-contained via the signature, not a lookup). Same result.
    const emptyVerifier = serviceWith([], KEY);
    const result = await emptyVerifier.verifyCredential(aliceCred.qrPayload);

    expect(result).toEqual({ valid: true, tier: ALICE.tier });
    expectNoLeak(result, [ALICE.id, BOB.id, aliceCred.memberId]);
  });

  it("splicing Bob's member id into Alice's credential fails closed (no substitution)", async () => {
    const svc = serviceWith([ALICE, BOB]);
    const aliceCred = await svc.issueCredential(ALICE.id);
    const bobCred = await svc.issueCredential(BOB.id);

    const [version, , tier, signature] = aliceCred.qrPayload.split(".");
    // Present Bob's member id with Alice's tier + signature — must not verify,
    // and must not resolve to either member's data.
    const spliced = `${version}.${bobCred.memberId}.${tier}.${signature}`;
    const result = await svc.verifyCredential(spliced);

    expect(result).toEqual({ valid: false });
    expectNoLeak(result, [ALICE.id, BOB.id, aliceCred.memberId, bobCred.memberId]);
  });

  it("presenting Bob's full credential never yields Alice's tier", async () => {
    const svc = serviceWith([ALICE, BOB]);
    const bobCred = await svc.issueCredential(BOB.id);

    const result = await svc.verifyCredential(bobCred.qrPayload);

    // Resolves to Bob's tier; Alice's higher tier is never returned.
    expect(result).toEqual({ valid: true, tier: BOB.tier });
    expect(result.tier).not.toBe(ALICE.tier);
  });
});
