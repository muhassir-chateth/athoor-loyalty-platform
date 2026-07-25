/**
 * Tests for the Membership-Credential service (task 19.2, Req 19.5/19.6).
 *
 * Exercises the pure signing/verification core with an in-memory tier source —
 * NO live Shopify, Postgres, or ledger is touched. Verifies:
 *   - a member's issued credential is opaque, non-PII, and carries member id +
 *     tier for wallet-pass readiness (Req 19.6);
 *   - a validly-issued credential verifies as `{ valid, tier }` and returns the
 *     tier ONLY — never the member id or any customer identifier (Req 19.5);
 *   - a tampered / forged / malformed credential is rejected (Req 19.5);
 *   - a different signing key cannot verify another key's credential (Req 19.5);
 *   - the service fails closed when the dedicated key is unconfigured (Req 19.5);
 *   - issuing for a non-member is rejected.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DefaultMembershipCredentialService,
  InMemoryMembershipTierSource,
  MemberNotFoundError,
  MembershipKeyUnavailableError,
} from "./credential.js";
import { TIERS, type Tier } from "../tier/tier.js";

const KEY = "dedicated-membership-signing-key-0123456789abcdef";
const OTHER_KEY = "a-different-signing-key-fedcba9876543210";
const CUSTOMER = "11111111-1111-4111-8111-111111111111";

function serviceWith(tiers: Record<string, Tier>, key: string | undefined = KEY) {
  return new DefaultMembershipCredentialService(key, new InMemoryMembershipTierSource(tiers));
}

describe("issueCredential (Req 19.5/19.6)", () => {
  it("issues an opaque, non-PII credential carrying member id + tier", async () => {
    const svc = serviceWith({ [CUSTOMER]: "gold" });
    const cred = await svc.issueCredential(CUSTOMER);

    expect(cred.tier).toBe("gold");
    expect(cred.memberId).toBeTruthy();
    // Opaque + non-PII: the member id must not be (or contain) the raw customer id.
    expect(cred.memberId).not.toBe(CUSTOMER);
    expect(cred.memberId).not.toContain(CUSTOMER);
    expect(cred.signature).toBeTruthy();
    // The QR payload is the presentable signed identifier.
    expect(cred.qrPayload).toContain(cred.memberId);
    expect(cred.qrPayload).toContain(cred.signature);
  });

  it("derives a stable member id for the same customer (wallet-pass ready)", async () => {
    const svc = serviceWith({ [CUSTOMER]: "silver" });
    const a = await svc.issueCredential(CUSTOMER);
    const b = await svc.issueCredential(CUSTOMER);
    expect(a.memberId).toBe(b.memberId);
  });

  it("derives different member ids for different customers", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const svc = serviceWith({ [CUSTOMER]: "bronze", [other]: "bronze" });
    const a = await svc.issueCredential(CUSTOMER);
    const b = await svc.issueCredential(other);
    expect(a.memberId).not.toBe(b.memberId);
  });

  it("rejects issuing for a non-member", async () => {
    const svc = serviceWith({});
    await expect(svc.issueCredential("unknown")).rejects.toBeInstanceOf(MemberNotFoundError);
  });

  it("fails closed when the dedicated signing key is unconfigured (Req 19.5)", async () => {
    const svc = new DefaultMembershipCredentialService(
      undefined,
      new InMemoryMembershipTierSource({ [CUSTOMER]: "gold" }),
    );
    expect(svc.isAvailable).toBe(false);
    await expect(svc.issueCredential(CUSTOMER)).rejects.toBeInstanceOf(
      MembershipKeyUnavailableError,
    );
  });
});

describe("verifyCredential (Req 19.5)", () => {
  it("verifies a validly-issued credential and returns membership + tier ONLY", async () => {
    const svc = serviceWith({ [CUSTOMER]: "royal_vip" });
    const cred = await svc.issueCredential(CUSTOMER);

    const result = await svc.verifyCredential(cred.qrPayload);
    expect(result).toEqual({ valid: true, tier: "royal_vip" });
    // Never leaks the member id or any customer identifier.
    expect(Object.keys(result)).toEqual(["valid", "tier"]);
    expect(JSON.stringify(result)).not.toContain(cred.memberId);
    expect(JSON.stringify(result)).not.toContain(CUSTOMER);
  });

  it("rejects a credential with a tampered tier", async () => {
    const svc = serviceWith({ [CUSTOMER]: "bronze" });
    const cred = await svc.issueCredential(CUSTOMER);
    // Swap the tier segment to a higher tier but keep the original signature.
    const [version, memberId, , signature] = cred.qrPayload.split(".");
    const forged = `${version}.${memberId}.royal_vip.${signature}`;
    expect(await svc.verifyCredential(forged)).toEqual({ valid: false });
  });

  it("rejects a credential with a tampered signature", async () => {
    const svc = serviceWith({ [CUSTOMER]: "gold" });
    const cred = await svc.issueCredential(CUSTOMER);
    const [version, memberId, tier] = cred.qrPayload.split(".");
    const forged = `${version}.${memberId}.${tier}.not-a-valid-signature`;
    expect(await svc.verifyCredential(forged)).toEqual({ valid: false });
  });

  it("rejects malformed / empty / wrong-version payloads", async () => {
    const svc = serviceWith({ [CUSTOMER]: "gold" });
    for (const bad of ["", "garbage", "a.b.c", "a.b.c.d.e", "WRONG.m.gold.sig"]) {
      expect(await svc.verifyCredential(bad)).toEqual({ valid: false });
    }
  });

  it("does not verify a credential signed by a different key (Req 19.5)", async () => {
    const issuer = serviceWith({ [CUSTOMER]: "silver" }, KEY);
    const cred = await issuer.issueCredential(CUSTOMER);

    const attacker = serviceWith({ [CUSTOMER]: "silver" }, OTHER_KEY);
    expect(await attacker.verifyCredential(cred.qrPayload)).toEqual({ valid: false });
  });

  it("fails closed when the dedicated signing key is unconfigured (Req 19.5)", async () => {
    const svc = new DefaultMembershipCredentialService(
      undefined,
      new InMemoryMembershipTierSource({ [CUSTOMER]: "gold" }),
    );
    await expect(svc.verifyCredential("anything")).rejects.toBeInstanceOf(
      MembershipKeyUnavailableError,
    );
  });
});

describe("issue → verify round-trip (property)", () => {
  it("every issued credential verifies as valid with its issued tier, across all tiers/customers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.constantFrom(...TIERS),
        async (customerId, tier) => {
          const svc = new DefaultMembershipCredentialService(
            KEY,
            new InMemoryMembershipTierSource({ [customerId]: tier }),
          );
          const cred = await svc.issueCredential(customerId);
          const verified = await svc.verifyCredential(cred.qrPayload);
          expect(verified).toEqual({ valid: true, tier });
        },
      ),
    );
  });

  it("any single-character mutation of a valid QR payload fails verification", async () => {
    const svc = serviceWith({ [CUSTOMER]: "gold" });
    const cred = await svc.issueCredential(CUSTOMER);
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: cred.qrPayload.length - 1 }),
        async (idx) => {
          const original = cred.qrPayload[idx];
          // Flip the char to a deterministic different one.
          const replacement = original === "x" ? "y" : "x";
          const mutated =
            cred.qrPayload.slice(0, idx) + replacement + cred.qrPayload.slice(idx + 1);
          if (mutated === cred.qrPayload) {
            return; // no-op mutation, skip
          }
          const result = await svc.verifyCredential(mutated);
          expect(result.valid).toBe(false);
        },
      ),
    );
  });
});
