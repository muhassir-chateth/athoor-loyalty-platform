/**
 * Customer identity, address and consent READS (spec task 14.2/14.3/14.4,
 * design §13.1/§13.6, Req 5.1, 13.3, 13.5, 2.1, 2.2).
 *
 * ── READS ONLY, WHICH IS WHY IT IS A SEPARATE FILE FROM THE MUTATIONS ───────
 * `ownership.gate.test.ts` classifies documents by FILENAME. This file is NOT in
 * the mutation class, so every document here is validated by the unchanged
 * `assertScopedCustomerQuery` — it must traverse `customer(id: $customerGid)` as
 * its first field and may not contain the word `mutation`. Splitting reads from
 * writes across two files is what lets both keep the strictest guard that fits.
 *
 * ── NOTHING IS STORED LOCALLY ───────────────────────────────────────────────
 * Shopify owns identity, addresses and marketing consent (§13.1, Req 3.1). There
 * is no table, no cache and no migration behind any of this: every read goes to
 * Shopify at request time, so the portal cannot hold a stale second version of a
 * name, an address or a consent state. Consent especially — a local copy is the
 * one divergence that would be a compliance failure rather than a bug.
 *
 * SAFETY: no SQL, no DDL, no writes. Read-only Shopify traversals from the
 * verified customer node.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { ShopifyCustomerIdLookup } from "../../shopify/purchaseHistory.js";
import { runScopedCustomerQuery, type ScopedGraphqlTransport } from "./shopifyScope.js";
import { projectSavedAddress } from "./customerMutations.js";
import type {
  PortalIdentityResponse,
  PortalSavedAddress,
} from "../types.js";

/** What every read here needs. Structural, so a test injects a fake. */
export interface CustomerIdentityReadDeps {
  readonly transport: ScopedGraphqlTransport;
  readonly lookup: ShopifyCustomerIdLookup;
}

/**
 * N6 — the identity panel.
 *
 * `email` is READ but never written (§13.3): it is the login identifier, so
 * changing it changes who the customer is to Shopify. The response carries
 * `emailEditable: false` so the client renders the field read-only with a route to
 * Shopify's own experience, rather than discovering the limitation on submit.
 */
const IDENTITY_QUERY = `query portalCustomerIdentity($customerGid: ID!) {
  customer(id: $customerGid) {
    id
    firstName
    lastName
    email
    phone
  }
}`;

/**
 * N8 — the saved-address list, plus which one is default.
 *
 * `defaultAddress { id }` is selected alongside the list so `isDefault` is derived
 * from Shopify's own answer rather than tracked here. `first: 50` because Shopify
 * requires a page size on the connection and fifty saved addresses is far beyond
 * any real account; the portal does not paginate this list, and if an account ever
 * exceeded it the list would be truncated rather than wrong.
 */
const ADDRESSES_QUERY = `query portalCustomerAddresses($customerGid: ID!, $first: Int!) {
  customer(id: $customerGid) {
    id
    defaultAddress {
      id
    }
    addresses(first: $first) {
      id
      firstName
      lastName
      address1
      address2
      city
      provinceCode
      zip
      countryCodeV2
      phone
    }
  }
}`;

/** N9's read half — the consent state Shopify holds, and when it last changed. */
const CONSENT_QUERY = `query portalCustomerConsent($customerGid: ID!) {
  customer(id: $customerGid) {
    id
    emailMarketingConsent {
      marketingState
      consentUpdatedAt
    }
  }
}`;

/** How many saved addresses a single read returns. See {@link ADDRESSES_QUERY}. */
export const PORTAL_ADDRESS_PAGE_SIZE = 50 as const;

interface IdentityNode {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * Reads the caller's identity (N6).
 *
 * @throws {PortalResourceNotFoundError} the scope has no Shopify customer
 */
export async function readCustomerIdentity(
  deps: CustomerIdentityReadDeps,
  scope: CustomerScope,
): Promise<PortalIdentityResponse> {
  const node = await runScopedCustomerQuery<IdentityNode>(
    deps.transport,
    deps.lookup,
    scope,
    IDENTITY_QUERY,
  );
  return {
    firstName: node.firstName ?? null,
    lastName: node.lastName ?? null,
    email: node.email ?? null,
    phone: node.phone ?? null,
    // A LITERAL false, not a computed one. There is no configuration under which
    // this portal writes an email (§13.3, Req 5.8).
    emailEditable: false,
  };
}

interface AddressesNode {
  defaultAddress?: { id?: string | null } | null;
  addresses?: readonly {
    id?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    provinceCode?: string | null;
    zip?: string | null;
    countryCodeV2?: string | null;
    phone?: string | null;
  }[] | null;
}

/**
 * Reads the caller's saved addresses (N8).
 *
 * An address with no id is DROPPED rather than surfaced with an empty one: the id
 * is what every mutation route needs, so an entry the client could not edit or
 * delete is worse than an entry it never saw.
 */
export async function readCustomerAddresses(
  deps: CustomerIdentityReadDeps,
  scope: CustomerScope,
): Promise<readonly PortalSavedAddress[]> {
  const node = await runScopedCustomerQuery<AddressesNode>(
    deps.transport,
    deps.lookup,
    scope,
    ADDRESSES_QUERY,
    { first: PORTAL_ADDRESS_PAGE_SIZE },
  );
  const defaultId = node.defaultAddress?.id ?? null;
  return (node.addresses ?? [])
    .filter((address) => typeof address.id === "string" && address.id !== "")
    .map((address) => projectSavedAddress(address, defaultId));
}

interface ConsentNode {
  emailMarketingConsent?: {
    marketingState?: string | null;
    consentUpdatedAt?: string | null;
  } | null;
}

/** The consent state as Shopify holds it. */
export interface CustomerConsentState {
  readonly marketingState: string | null;
  readonly consentUpdatedAt: string | null;
}

/**
 * Reads the caller's marketing consent from Shopify (N9, Req 13.3).
 *
 * There is no local fallback and deliberately so. If Shopify cannot be reached the
 * read FAILS, because reporting a default consent state would be inventing a
 * compliance-relevant fact — and a customer shown "not subscribed" when Shopify
 * holds "subscribed" would reasonably believe they had already opted out.
 */
export async function readCustomerConsent(
  deps: CustomerIdentityReadDeps,
  scope: CustomerScope,
): Promise<CustomerConsentState> {
  const node = await runScopedCustomerQuery<ConsentNode>(
    deps.transport,
    deps.lookup,
    scope,
    CONSENT_QUERY,
  );
  return {
    marketingState: node.emailMarketingConsent?.marketingState ?? null,
    consentUpdatedAt: node.emailMarketingConsent?.consentUpdatedAt ?? null,
  };
}
