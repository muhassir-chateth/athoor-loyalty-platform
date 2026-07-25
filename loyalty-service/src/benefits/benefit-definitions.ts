/**
 * Seed configuration for tier-gated VIP Benefit definitions (task 15.1).
 *
 * Requirement 18 models entitlements as *configuration-driven* Benefit
 * definitions — each pairing a Benefit `key` with a `minQualifyingTier` and a
 * free-form JSONB `config`. New Benefit types are therefore added purely by
 * configuration (a new row here + a matching seed INSERT), with **no schema
 * redesign** and no breaking `/v1` change (Req 18.1, 18.7).
 *
 * This module is the single, human-readable source of truth for the *initial*
 * catalogue of Benefit definitions. The accompanying migration
 * (`*_create-benefits-schema.ts`) seeds these exact rows into the `benefits`
 * table with an idempotent `INSERT ... ON CONFLICT (key) DO NOTHING`, so the
 * database and this module stay in lock-step (verified by
 * `src/migrations.benefits.test.ts`).
 *
 * Per A13 (and Requirement 18 criterion 4), the specific Royal_VIP
 * private-client perks — private consultations, early access to launches,
 * limited-edition releases, exclusive samples, dedicated personal service
 * (concierge), and invitation-only experiences — are **future roadmap**. They
 * are seeded here as first-class, configurable Benefits gated to `royal_vip`
 * but with `active = false`, so the framework is proven end-to-end while the
 * perks themselves remain switched off until the business is ready to deliver
 * them (a sensible default that requires only a config flip to enable).
 *
 * The Entitlement Resolver (task 15.2) is intentionally NOT implemented here.
 *
 * SAFETY: pure data + types. Importing this module touches no live system,
 * network, or database.
 */

/** The four VIP tiers, lowest → highest. Mirrors `customers.tier`. */
export type Tier = "bronze" | "silver" | "gold" | "royal_vip";

/**
 * A configuration-driven, tier-gated entitlement (Req 18.1). Shape mirrors the
 * `benefits` table columns so a definition maps 1:1 to a seeded row.
 */
export interface BenefitDefinition {
  /** Stable machine key, unique across benefits (e.g. `private_consultation`). */
  key: string;
  /** Human-readable name shown in account/portal data. */
  name: string;
  /** Minimum tier a customer must hold for this Benefit to be granted (Req 18.3). */
  minQualifyingTier: Tier;
  /** Perk-specific configuration for future Benefit types (JSONB). */
  config: Record<string, unknown>;
  /** Whether the Benefit is currently switched on. Future-roadmap perks ship `false`. */
  active: boolean;
}

/**
 * Initial Benefit catalogue seeded at migration time.
 *
 * All entries below are the Royal_VIP private-client perks enumerated in
 * Requirement 18 criterion 4 / A13. They are gated to `royal_vip` and seeded
 * `active: false` because they are future roadmap — the MVP scope is the
 * configurable framework itself, not the delivery of the perks.
 *
 * To add a NEW Benefit type later: append a definition here and a matching
 * `INSERT ... ON CONFLICT (key) DO NOTHING` in the benefits migration. No
 * schema change and no `/v1` breaking change are required (Req 18.1, 18.7).
 */
export const BENEFIT_SEED: readonly BenefitDefinition[] = [
  {
    key: "private_consultation",
    name: "Private Consultation Booking",
    minQualifyingTier: "royal_vip",
    config: { roadmap: true, category: "private_client", bookable: true },
    active: false,
  },
  {
    key: "early_access_launches",
    name: "Early Access to Launches",
    minQualifyingTier: "royal_vip",
    config: { roadmap: true, category: "private_client" },
    active: false,
  },
  {
    key: "limited_edition_access",
    name: "Limited-Edition Release Access",
    minQualifyingTier: "royal_vip",
    config: { roadmap: true, category: "private_client" },
    active: false,
  },
  {
    key: "exclusive_samples",
    name: "Exclusive Samples",
    minQualifyingTier: "royal_vip",
    config: { roadmap: true, category: "private_client" },
    active: false,
  },
  {
    key: "dedicated_service",
    name: "Dedicated Personal Customer Service",
    minQualifyingTier: "royal_vip",
    config: { roadmap: true, category: "private_client", concierge: true },
    active: false,
  },
  {
    key: "invitation_only_experiences",
    name: "Invitation-Only Experiences",
    minQualifyingTier: "royal_vip",
    config: { roadmap: true, category: "private_client" },
    active: false,
  },
] as const;
