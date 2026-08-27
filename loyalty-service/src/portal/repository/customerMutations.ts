/**
 * The customer-mutation allowlist client (spec task 14.1, design §13.2/§13.4,
 * Req 2.7, 5.2, 5.4, 20.7, 20.8).
 *
 * ── THIS FILE HOLDS EVERY PORTAL WRITE TO SHOPIFY, AND NOTHING ELSE ─────────
 * `ownership.gate.test.ts` assigns each document in this directory to a security
 * class BY FILENAME. This file is declared as the customer-mutation class, so every
 * GraphQL literal here is validated by {@link assertCustomerMutationDocument} and
 * every literal elsewhere in the directory is still validated by the unchanged read
 * guards. Keeping all six mutations in one file is what makes that classification
 * a statement about a file rather than a per-document judgement — the same reason
 * task 8.4 put the catalogue query in a file of its own.
 *
 * ── OWNERSHIP IS NEVER COMPARED, ONLY DERIVED ───────────────────────────────
 * No function here reads a customer id from anywhere. `runCustomerMutation` binds
 * `$customerGid` from the sanctioned lookup, so a foreign `addressId` is submitted
 * against OUR customer and Shopify rejects it — §13.5's "there is no ownership
 * comparison in our handler to forget". `ownership.gate.test.ts` also asserts this
 * file contains no `scope.customerId` unwrap at all.
 *
 * ── EACH ADDRESS IS ITS OWN MUTATION (task 14.3) ────────────────────────────
 * No batching. A failure then names the address that failed, which a customer can
 * act on; a batched write would report "one of your addresses was rejected".
 *
 * ── `setAsDefault` IS DELIBERATELY UNUSED ───────────────────────────────────
 * The live schema offers it on create and update, but setting a default is its own
 * route (N8). Using it as a side effect of a save would mean a failure to set the
 * default reads as a failure to save the address.
 *
 * SAFETY: no SQL, no DDL. Every write goes through the allowlist gate, which is
 * asserted over this file's documents by the ownership gate.
 */
import type { CustomerScope } from "../../auth/customerScope.js";
import type { ShopifyCustomerIdLookup } from "../../shopify/purchaseHistory.js";
import {
  runCustomerMutation,
  type ScopedGraphqlTransport,
} from "./shopifyScope.js";
import {
  assertNoPortalWriteErrors,
  type ShopifyUserErrorLike,
} from "../userErrorCodes.js";
import type { PortalAddress, PortalSavedAddress } from "../types.js";

/** What every mutation here needs. Structural, so a test injects a fake. */
export interface CustomerMutationDeps {
  readonly transport: ScopedGraphqlTransport;
  readonly lookup: ShopifyCustomerIdLookup;
}

/** The identity fields `customerUpdate` may change (N7). `email` is absent (Req 5.8). */
export interface IdentityPatch {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string | null;
}

/** The Shopify `MailingAddress` node shape these documents select. */
interface MailingAddressNode {
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
}

/**
 * Projects a Shopify address node onto the wire shape.
 *
 * EVERY FIELD IS NULLABLE, matching `PortalAddress`. That is a recorded divergence
 * from a flat reading of §6.3 and it is the honest one: Shopify's `MailingAddress`
 * makes all of these optional, and a non-null wire type would force this function
 * to invent an empty string for an absent value — which the client could not tell
 * from a value the customer actually left blank.
 */
function projectAddress(node: MailingAddressNode): PortalAddress {
  return {
    firstName: node.firstName ?? null,
    lastName: node.lastName ?? null,
    address1: node.address1 ?? null,
    address2: node.address2 ?? null,
    city: node.city ?? null,
    province: node.provinceCode ?? null,
    zip: node.zip ?? null,
    // `countryCodeV2` is the enum; the wire field is named `countryCode`.
    countryCode: node.countryCodeV2 ?? null,
    phone: node.phone ?? null,
  };
}

/** Projects a saved address, which additionally carries its id and default flag. */
export function projectSavedAddress(
  node: MailingAddressNode,
  defaultAddressId: string | null,
): PortalSavedAddress {
  const id = node.id ?? "";
  return {
    ...projectAddress(node),
    id,
    // Compared against the customer's own `defaultAddress.id`, so "is default" is
    // read from Shopify rather than tracked here — no second copy of the fact.
    isDefault: id !== "" && id === defaultAddressId,
  };
}

/** Builds a `MailingAddressInput` from the wire input, omitting absent keys. */
function buildAddressInput(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Only the keys the live `2024-10` `MailingAddressInput` accepts, verified by
  // introspection. `province` maps to `provinceCode` and `countryCode` stays as-is;
  // sending an unknown key would make Shopify reject the whole mutation.
  const out: Record<string, unknown> = {};
  const copy = (from: string, to: string = from): void => {
    if (Object.prototype.hasOwnProperty.call(input, from)) out[to] = input[from];
  };
  copy("firstName");
  copy("lastName");
  copy("address1");
  copy("address2");
  copy("city");
  copy("province", "provinceCode");
  copy("zip");
  copy("countryCode");
  copy("phone");
  return out;
}

/* ========================================================================== *
 * The six documents
 * ========================================================================== */

/**
 * N7 — first name, last name, phone.
 *
 * `id: $customerGid` inside `CustomerInput` is what binds the write to our
 * customer. There is no `email` field in this document and no way to add one
 * through the route's schema, which is how Req 5.8 is enforced by the contract
 * rather than by a check.
 */
const CUSTOMER_UPDATE = `mutation portalCustomerUpdate($customerGid: ID!, $firstName: String, $lastName: String, $phone: String) {
  customerUpdate(input: { id: $customerGid, firstName: $firstName, lastName: $lastName, phone: $phone }) {
    customer {
      id
      firstName
      lastName
      email
      phone
    }
    userErrors {
      field
      message
    }
  }
}`;

const CUSTOMER_ADDRESS_CREATE = `mutation portalCustomerAddressCreate($customerGid: ID!, $address: MailingAddressInput!) {
  customerAddressCreate(customerId: $customerGid, address: $address) {
    address {
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
    userErrors {
      field
      message
    }
  }
}`;

/** `addressId`, NOT `id` — confirmed against the live `2024-10` schema (OQ-8). */
const CUSTOMER_ADDRESS_UPDATE = `mutation portalCustomerAddressUpdate($customerGid: ID!, $addressId: ID!, $address: MailingAddressInput!) {
  customerAddressUpdate(customerId: $customerGid, addressId: $addressId, address: $address) {
    address {
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
    userErrors {
      field
      message
    }
  }
}`;

const CUSTOMER_ADDRESS_DELETE = `mutation portalCustomerAddressDelete($customerGid: ID!, $addressId: ID!) {
  customerAddressDelete(customerId: $customerGid, addressId: $addressId) {
    deletedAddressId
    userErrors {
      field
      message
    }
  }
}`;

const CUSTOMER_DEFAULT_ADDRESS = `mutation portalCustomerDefaultAddress($customerGid: ID!, $addressId: ID!) {
  customerUpdateDefaultAddress(customerId: $customerGid, addressId: $addressId) {
    customer {
      id
      defaultAddress {
        id
      }
    }
    userErrors {
      field
      message
    }
  }
}`;

/**
 * N9 — marketing consent.
 *
 * `consentUpdatedAt` is deliberately NOT sent. Shopify stamps it, and the response
 * reads it back, so there is exactly one clock and exactly one copy of when consent
 * changed (§13.1, Req 3.2). Sending our own would create a second version of a fact
 * Shopify owns — the one field where a disagreement is a compliance failure rather
 * than a bug.
 *
 * `marketingOptInLevel: SINGLE_OPT_IN` accompanies a subscribe because Shopify
 * requires a level with `SUBSCRIBED`; an unsubscribe sends only the state.
 */
const CUSTOMER_CONSENT_UPDATE = `mutation portalCustomerConsent($customerGid: ID!, $consent: CustomerEmailMarketingConsentInput!) {
  customerEmailMarketingConsentUpdate(input: { customerId: $customerGid, emailMarketingConsent: $consent }) {
    customer {
      id
      emailMarketingConsent {
        marketingState
        marketingOptInLevel
        consentUpdatedAt
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}`;

/* ========================================================================== *
 * The six operations
 * ========================================================================== */

interface UserErrorEnvelope {
  userErrors?: readonly ShopifyUserErrorLike[] | null;
}

interface CustomerUpdateData {
  customerUpdate:
    | (UserErrorEnvelope & {
        customer: {
          firstName?: string | null;
          lastName?: string | null;
          email?: string | null;
          phone?: string | null;
        } | null;
      })
    | null;
}

/** The identity the write actually stored, read back from the mutation's node. */
export interface StoredIdentity {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * N7 — writes identity and returns what Shopify STORED, not what was submitted.
 *
 * Reading the mutation's own `customer` node is the point (task 14.5): Shopify
 * normalises a phone number, so echoing the request would show the customer a
 * value that differs from what is now on their account.
 */
export async function updateCustomerIdentity(
  deps: CustomerMutationDeps,
  scope: CustomerScope,
  patch: IdentityPatch,
): Promise<StoredIdentity> {
  const data = await runCustomerMutation<CustomerUpdateData>(
    deps.transport,
    deps.lookup,
    scope,
    CUSTOMER_UPDATE,
    {
      // `null` for an absent key, because the document declares all three
      // variables. Shopify treats an explicit null as "clear", which is why the
      // route only ever passes keys the customer actually submitted — see its
      // `buildIdentityVariables`.
      firstName: patch.firstName ?? null,
      lastName: patch.lastName ?? null,
      phone: patch.phone ?? null,
    },
  );
  const payload = data?.customerUpdate ?? null;
  assertNoPortalWriteErrors(payload?.userErrors);
  const node = payload?.customer ?? null;
  return {
    firstName: node?.firstName ?? null,
    lastName: node?.lastName ?? null,
    email: node?.email ?? null,
    phone: node?.phone ?? null,
  };
}

interface AddressMutationData {
  customerAddressCreate?: (UserErrorEnvelope & { address: MailingAddressNode | null }) | null;
  customerAddressUpdate?: (UserErrorEnvelope & { address: MailingAddressNode | null }) | null;
}

/** N8 — creates an address and returns it as Shopify stored it. */
export async function createCustomerAddress(
  deps: CustomerMutationDeps,
  scope: CustomerScope,
  input: Readonly<Record<string, unknown>>,
): Promise<PortalSavedAddress | null> {
  const data = await runCustomerMutation<AddressMutationData>(
    deps.transport,
    deps.lookup,
    scope,
    CUSTOMER_ADDRESS_CREATE,
    { address: buildAddressInput(input) },
  );
  const payload = data?.customerAddressCreate ?? null;
  assertNoPortalWriteErrors(payload?.userErrors);
  const node = payload?.address ?? null;
  // A new address is never the default unless the customer says so (N8's own
  // route), so `isDefault` is false rather than read from a node we did not query.
  return node === null ? null : projectSavedAddress(node, null);
}

/**
 * N8 — updates an address.
 *
 * A FOREIGN `addressId` cannot succeed: `customerId` is our GID, so Shopify is
 * asked to change an address of OUR customer, and one belonging to somebody else
 * simply is not there. The refusal arrives as a `userError`, which the route maps
 * to `404` with no address attribute in the body (Req 2.2, 2.3).
 */
export async function updateCustomerAddress(
  deps: CustomerMutationDeps,
  scope: CustomerScope,
  addressId: string,
  input: Readonly<Record<string, unknown>>,
): Promise<PortalSavedAddress | null> {
  const data = await runCustomerMutation<AddressMutationData>(
    deps.transport,
    deps.lookup,
    scope,
    CUSTOMER_ADDRESS_UPDATE,
    { addressId, address: buildAddressInput(input) },
  );
  const payload = data?.customerAddressUpdate ?? null;
  assertNoPortalWriteErrors(payload?.userErrors);
  const node = payload?.address ?? null;
  return node === null ? null : projectSavedAddress(node, null);
}

interface AddressDeleteData {
  customerAddressDelete: (UserErrorEnvelope & { deletedAddressId?: string | null }) | null;
}

/** N8 — deletes an address. Returns the id Shopify reports it removed. */
export async function deleteCustomerAddress(
  deps: CustomerMutationDeps,
  scope: CustomerScope,
  addressId: string,
): Promise<string | null> {
  const data = await runCustomerMutation<AddressDeleteData>(
    deps.transport,
    deps.lookup,
    scope,
    CUSTOMER_ADDRESS_DELETE,
    { addressId },
  );
  const payload = data?.customerAddressDelete ?? null;
  assertNoPortalWriteErrors(payload?.userErrors);
  return payload?.deletedAddressId ?? null;
}

interface DefaultAddressData {
  customerUpdateDefaultAddress:
    | (UserErrorEnvelope & { customer: { defaultAddress?: { id?: string | null } | null } | null })
    | null;
}

/** N8 — sets the default address. Returns the id Shopify now reports as default. */
export async function setDefaultCustomerAddress(
  deps: CustomerMutationDeps,
  scope: CustomerScope,
  addressId: string,
): Promise<string | null> {
  const data = await runCustomerMutation<DefaultAddressData>(
    deps.transport,
    deps.lookup,
    scope,
    CUSTOMER_DEFAULT_ADDRESS,
    { addressId },
  );
  const payload = data?.customerUpdateDefaultAddress ?? null;
  assertNoPortalWriteErrors(payload?.userErrors);
  return payload?.customer?.defaultAddress?.id ?? null;
}

interface ConsentData {
  customerEmailMarketingConsentUpdate:
    | (UserErrorEnvelope & {
        customer: {
          emailMarketingConsent?: {
            marketingState?: string | null;
            consentUpdatedAt?: string | null;
          } | null;
        } | null;
      })
    | null;
}

/** The consent state Shopify holds, read back from the mutation (§13.1). */
export interface StoredConsent {
  readonly marketingState: string | null;
  readonly consentUpdatedAt: string | null;
}

/**
 * The two `CustomerEmailMarketingState` values this portal writes.
 *
 * The live enum also has `NOT_SUBSCRIBED`, `PENDING`, `REDACTED` and `INVALID`.
 * None is ours to set: `PENDING` belongs to a double-opt-in flow we do not run,
 * `REDACTED` to erasure, and `INVALID`/`NOT_SUBSCRIBED` describe states Shopify
 * derives. Writing only these two keeps the portal's authority narrow.
 */
export const CONSENT_STATE_SUBSCRIBED = "SUBSCRIBED" as const;
export const CONSENT_STATE_UNSUBSCRIBED = "UNSUBSCRIBED" as const;

/**
 * N9 — writes marketing consent to Shopify and reads the result back.
 *
 * `consentUpdatedAt` comes from Shopify's response, never from our clock, so no
 * second copy of when consent changed exists anywhere (Req 3.2, 13.4).
 */
export async function updateCustomerConsent(
  deps: CustomerMutationDeps,
  scope: CustomerScope,
  emailMarketing: boolean,
): Promise<StoredConsent> {
  const consent = emailMarketing
    ? // Shopify requires an opt-in level alongside SUBSCRIBED.
      { marketingState: CONSENT_STATE_SUBSCRIBED, marketingOptInLevel: "SINGLE_OPT_IN" }
    : { marketingState: CONSENT_STATE_UNSUBSCRIBED };

  const data = await runCustomerMutation<ConsentData>(
    deps.transport,
    deps.lookup,
    scope,
    CUSTOMER_CONSENT_UPDATE,
    { consent },
  );
  const payload = data?.customerEmailMarketingConsentUpdate ?? null;
  assertNoPortalWriteErrors(payload?.userErrors);
  const node = payload?.customer?.emailMarketingConsent ?? null;
  return {
    marketingState: node?.marketingState ?? null,
    consentUpdatedAt: node?.consentUpdatedAt ?? null,
  };
}
