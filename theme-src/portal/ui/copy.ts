/**
 * `ui/copy.ts` — every customer-facing string (spec task 18.6, design §16.9,
 * §18.9).
 *
 * Requirements 9.2, 9.3, 9.4, 9.7, 9.8, 10.11, 10.14, 10.15, 16.9.
 *
 * ── WHY THE WORDING LIVES HERE AND NOT IN THE API ───────────────────────────
 * The API returns identifiers; this file turns them into sentences. Three things
 * follow, and all three are the point:
 *
 *   1. Requirement 21.7 and Property 10 hold BY CONSTRUCTION. There is no sentence
 *      in a `/v1` body to leak, because every sentence is here.
 *   2. Changing a word is a theme deploy, not a service deploy.
 *   3. A future mobile app ships its own map against the same identifiers and
 *      inherits none of this web wording.
 *
 * ── THE MAP IS CLOSED, AND THE FALLBACK IS THE FEATURE ──────────────────────
 * Every lookup goes through a table with a neutral fallback, and the INPUT IS
 * NEVER ECHOED. That is what makes Property 5 hold for values that do not exist
 * yet: a tenth `entry_type` added to the ledger next year renders as "An
 * adjustment to your account", not as `earn_something_new`.
 *
 * It is also what keeps operator free text out of the UI. `adjust` reasons are
 * written by staff for staff and may name a person, a ticket or a mistake
 * (§18.9). They map to the neutral wording UNCONDITIONALLY — stricter than
 * Requirement 9.8 demands, and the right default, because the alternative is a
 * rule that depends on operators remembering who will read what they type.
 *
 * ── NO MONEY AND NO POINT FIGURES ARE LITERALS HERE ─────────────────────────
 * Reward values are resolved from the reward catalogue the API returns; referral
 * point figures come from the response (`currentRewardPoints`, `creditedPoints`).
 * Requirement 10.15 forbids a referral reward figure being a literal here or
 * anywhere in the theme, because a figure baked into an asset is a figure that
 * disagrees with the ledger the day it changes.
 *
 * ── VOICE (Requirement 16.9) ────────────────────────────────────────────────
 * Plain, unhurried, first-person-plural. No exclamation marks, no apology
 * inflation, no jargon. None of `Loading...`, `Something went wrong`, `undefined`,
 * `null` or `NaN` appears anywhere below (Requirement 16.8) — asserted by test.
 *
 * SAFETY: pure data and pure functions. No DOM, no network, no storage.
 */

/** The neutral description every unmapped ledger entry falls back to (§18.9). */
const NEUTRAL_ACTIVITY = "An adjustment to your account";

/**
 * `reason` → description, for the rows §18.9's table identifies by reason.
 *
 * KEYED ON `reason`, NOT `entry_type`, because `entry_type` is not on the wire.
 * `GET /v1/history` returns `type` (`earned`/`spent`/`expired`) and the raw
 * `reason`; the nine-value `entry_type` stays server-side. Every row of §18.9's
 * table except `spend` and `migration` is uniquely identified by its reason, so
 * this is the same table expressed against the fields a client actually receives.
 */
const ACTIVITY_BY_REASON: Readonly<Record<string, string>> = {
  signup_bonus: "Welcome to My Athoor",
  paid_order: "Points from order {orderNumber}",
  first_purchase_bonus: "A gift for your first order",
  referral_signup_bonus: "A friend joined on your invitation",
  referral_first_purchase_bonus: "Your friend's first order",
  refund_clawback: "Adjusted after a refund",
  cancellation_clawback: "Adjusted after a cancelled order",
  point_lot_expired: "Points expired",
  redemption_failed_reversal: "Points returned — a reward could not be issued",
  migration: "Opening balance",
  opening_balance: "Opening balance",
};

/** §18.9 — referral stage wording, both stages plus the unmapped fallback. */
const REFERRAL_STAGES: Readonly<
  Record<
    string,
    { name: string; qualification: string; pending: string; awarded: string; none: string }
  >
> = {
  friend_signup: {
    name: "When your friend joins",
    qualification: "Your friend creates a My Athoor account with your code",
    pending: "Awaiting your friend",
    awarded: "Credited",
    none: "No invitations used yet",
  },
  friend_first_purchase: {
    name: "When your friend's first order is placed",
    qualification: "Your friend completes their first order",
    pending: "Awaiting their first order",
    awarded: "Credited",
    none: "No first orders yet",
  },
};

const REFERRAL_FALLBACK = {
  name: "A referral reward",
  qualification: "Conditions apply",
  state: "In progress",
} as const;

/** §18.9 — fulfilment status. */
const FULFILMENT: Readonly<Record<string, string>> = {
  UNFULFILLED: "Preparing your order",
  PARTIALLY_FULFILLED: "Part of your order has been sent",
  FULFILLED: "Sent",
  IN_TRANSIT: "On its way",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
};

/** §18.9 — catalogue availability. `unpublished` shares the retired wording. */
const AVAILABILITY: Readonly<Record<string, string>> = {
  available: "Available",
  out_of_stock: "Out of stock",
  discontinued: "No longer available",
  unpublished: "No longer available",
};

/** §18.9 — redemption status. `failed` is present because N16 can return it. */
const REDEMPTION_STATUS: Readonly<Record<string, string>> = {
  pending_code: "Confirmed — your code is being issued",
  issued: "Ready to use",
  voided: "No longer valid",
  failed: "Not issued — your points have been returned",
};

/**
 * Marketing consent state (Requirement 13.3, task 26.1).
 *
 * Three keys, not two. `never_set` exists because N9 reports `updatedAt` as the
 * EMPTY STRING for a customer whose consent has never been set, and rendering
 * "withdrawn on " with nothing after it would state a date that does not exist.
 * `{date}` is resolved by the caller.
 */
const CONSENT: Readonly<Record<string, string>> = {
  subscribed: "You are subscribed. Last changed {date}",
  withdrawn: "You are not subscribed. Last changed {date}",
  never_set: "You have not set a preference yet",
};

/**
 * The privacy actions (Requirement 13.8, task 26.3).
 *
 * `erasure_recorded` is worded to state that a person will action it. A right this
 * consequential spans nine tables, is irreversible and must be coordinated with
 * Shopify's own erasure, so it is operator-run — and a sentence implying the data
 * has already gone would be false at the moment it was read.
 */
const PRIVACY: Readonly<Record<string, string>> = {
  export_ready: "Your data is downloading.",
  export_waiting: "Your last copy was just prepared. You can request another shortly.",
  erasure_recorded: "We have recorded your request. A member of our team will action it and contact you. Quote {reference} if you get in touch.",
  erasure_waiting: "You have already asked us to delete your data. We are working on it.",
};

/** §18.9 — birthday eligibility. `{date}` is resolved by the caller's argument. */
const BIRTHDAY: Readonly<Record<string, string>> = {
  not_set: "Not yet added",
  outside_window: "We'll be in touch nearer the day",
  eligible: "Your birthday gift is ready",
  already_granted_this_year: "Already enjoyed this year",
  change_locked: "You can change this from {date}",
};

/** §18.9 — where a preference came from. */
const PROVENANCE: Readonly<Record<string, string>> = {
  declared: "You told us",
  derived: "From your own activity",
};

/** §18.9 — inferred insights. `{family}` is resolved by the caller's argument. */
const INSIGHT: Readonly<Record<string, string>> = {
  family_concentration: "Your collection leans toward {family}",
};

/**
 * Error identifiers → customer-safe sentences.
 *
 * Covers the closed `PortalErrorCode` set, the identifiers the transport itself
 * originates when there was no answer, and the codes the wider service taxonomy
 * (design E.2) can produce on a portal route. The fallback is deliberately the
 * same neutral sentence rather than the identifier (E.1 rule 5).
 *
 * `identity_resolution_failed` and `app_proxy_signature_invalid` share wording on
 * purpose: to the customer both are "you are not signed in any more", and telling
 * them which one occurred would describe our auth internals to a stranger.
 */
const ERRORS: Readonly<Record<string, string>> = {
  // No answer at all.
  network_unavailable: "We could not reach your account just now.",
  request_timeout: "That took longer than expected.",
  // Authentication.
  app_proxy_signature_invalid: "Please sign in again to see your account.",
  identity_resolution_failed: "Please sign in again to see your account.",
  app_proxy_verification_unavailable: "Please sign in again to see your account.",
  app_proxy_request_expired: "Please sign in again to see your account.",
  // Validation.
  invalid_request: "Please check the details and try again.",
  invalid_idempotency_key: "Please try that again.",
  invalid_pagination: "That page is not available.",
  invalid_order_reference: "We could not find that order on your account.",
  // Not found.
  not_found: "That is not available on this account.",
  order_not_found: "We could not find that order on your account.",
  birthday_not_set: "Not yet added",
  address_not_found: "That address is not on your account.",
  unknown_referral_code: "That code was not recognised.",
  // Conflict.
  conflict: "That has already been done.",
  insufficient_points: "You do not have enough points for that reward yet.",
  self_referral_rejected: "A code cannot be used on the account that created it.",
  referral_already_claimed: "A code has already been applied to this account.",
  referral_not_eligible: "A code cannot be applied after your first order.",
  birthday_change_locked: "You can change this from {date}",
  wishlist_limit_reached: "Your wishlist is full.",
  // Permission.
  reward_channel_not_allowed: "That reward is available in the app.",
  entitlement_not_qualified: "That is available at a higher tier.",
  entitlement_channel_not_allowed: "That is available in the app.",
  // Wait.
  rate_limit_exceeded: "Please wait a moment before trying again.",
  // Upstream and server.
  upstream_unavailable: "That part of your account is not available just now.",
  lock_timeout: "We are still working on that — please try again shortly.",
  service_unavailable: "That is temporarily unavailable.",
  membership_service_unavailable: "Your membership card is not available just now.",
  internal_error: "We could not complete that just now.",
  section_render_failed: "This part of your account is not available just now.",
  invalid_device_registration: "We could not register this device.",
  invalid_device_token: "We could not update this device.",
  invalid_reward: "That reward is not available.",
  customer_not_found: "Please sign in again to see your account.",
  idempotency_scope_unavailable: "Please sign in again to see your account.",
};

const ERROR_FALLBACK = "We could not complete that just now.";

/** Field-level rejection codes → wording (design E.1 rule 4, §20.5). */
const FIELD_ERRORS: Readonly<Record<string, string>> = {
  required: "This is needed.",
  too_long: "This is too long.",
  too_short: "This is too short.",
  invalid: "Please check this.",
  invalid_format: "Please check the format.",
  invalid_postcode: "Please check the postcode.",
  invalid_country: "Please choose a country.",
  invalid_phone: "Please check the phone number.",
  invalid_email: "Please check the email address.",
  invalid_date: "Please check the date.",
  out_of_range: "Please choose a value in range.",
  // The birthday write's own two codes (`profile/birthday.ts`'s
  // `BirthdayFieldError`). Without them a rejected 31 February fell through to the
  // fallback, "Please check this." — safe, but it does not tell the customer that
  // the day does not exist in the month they chose, which is the one thing they
  // need to know to correct it.
  not_an_integer: "Please choose a day and a month.",
  invalid_day_for_month: "That day does not exist in that month.",
  not_allowed: "This cannot be changed here.",
  rejected: "Please check this.",
  unknown_key: "Please check the details and try again.",
};

const FIELD_ERROR_FALLBACK = "Please check this.";

/**
 * The eight designed states (§18.8).
 *
 * `loading` is "Preparing your account" and NOT `Loading...`, which Requirement
 * 16.8 forbids outright.
 */
const STATES: Readonly<Record<PortalSectionState, string>> = {
  loading: "Preparing your account",
  empty: "There is nothing here yet",
  ready: "",
  error: "We could not complete that just now.",
  disabled: "Not available just now",
  offline: "You appear to be offline. Nothing you have typed has been lost.",
  "session-expired": "Your session has ended. Please sign in again — nothing you have typed has been lost.",
  degraded: "This part of your account is not available just now. Nothing has changed on your account.",
};

/**
 * An OWN-property lookup that only ever yields a string.
 *
 * WHY EVERY TABLE ACCESS GOES THROUGH THIS. `TABLE[key]` walks the prototype
 * chain, so `TABLE["__proto__"]` returns `Object.prototype` and
 * `TABLE["toString"]` returns a function — both truthy, so a `?? fallback` never
 * fires and the value reaches the DOM as `undefined` or as the source of
 * `toString`. Requirement 16.8 forbids `undefined` in rendered output outright,
 * and Property 5 found this with a generated `__proto__` identifier rather than a
 * hand-written case.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `Object.hasOwn`, which is
 * ES2022 and outside the ES2019 lib floor §16.7 sets. The `typeof` check is the
 * second half: an own property could still be a non-string if a table were ever
 * built from untrusted data.
 */
function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  if (typeof key !== "string") return undefined;
  if (!Object.prototype.hasOwnProperty.call(table, key)) return undefined;
  const value = table[key];
  return typeof value === "string" ? value : undefined;
}

/** The same own-property discipline for the one table whose values are objects. */
function lookupStage(key: string): (typeof REFERRAL_STAGES)[string] | undefined {
  if (typeof key !== "string") return undefined;
  if (!Object.prototype.hasOwnProperty.call(REFERRAL_STAGES, key)) return undefined;
  const value = REFERRAL_STAGES[key];
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.name !== "string" || typeof value.qualification !== "string") return undefined;
  if (typeof value.pending !== "string" || typeof value.awarded !== "string") return undefined;
  return value;
}

/** Replace `{token}` occurrences. Absent values leave the sentence intact-but-plain. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  let out = template;
  const names = Object.keys(values);
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (name === undefined) continue;
    const value = lookup(values, name);
    if (value === undefined) continue;
    // `split`/`join` rather than a regex: no escaping question, and the token
    // names here are fixed literals.
    out = out.split(`{${name}}`).join(value);
  }
  return out;
}

/**
 * Whether a reason names a redemption — the `spend` row of §18.9's table.
 *
 * Matched on the `reward_` prefix the catalogue uses. The id itself is NEVER
 * rendered (§1.5 records that production shows customers `reward_15` today, which
 * is the defect this replaces): the value is looked up, and an id the catalogue
 * does not know falls back to "a reward".
 */
function isRewardId(reason: string): boolean {
  return reason.indexOf("reward_") === 0;
}

/**
 * The description of one ledger entry (§18.9).
 *
 * The lookup order is: a reward id (the `spend` row) → the reason table → the
 * neutral fallback. The entry's `type` is not used as a key because the reason
 * already discriminates every mapped row; it would only matter for a future
 * `entry_type` whose reason is unmapped, and that case is the neutral fallback
 * either way.
 */
export function activityDescription(
  entry: PortalActivityEntry,
  rewardValues?: Readonly<Record<string, string>>,
): string {
  const reason = typeof entry.reason === "string" ? entry.reason : "";

  if (isRewardId(reason)) {
    const value = rewardValues ? rewardValues[reason] : undefined;
    return value === undefined ? "Redeemed — a reward" : `Redeemed — ${value} credit`;
  }

  // Case-insensitive so a `SIGNUP_BONUS` from a future writer still maps rather
  // than falling through to the neutral wording for a cosmetic difference.
  const mapped = lookup(ACTIVITY_BY_REASON, reason) ?? lookup(ACTIVITY_BY_REASON, reason.toLowerCase());
  if (mapped === undefined) return NEUTRAL_ACTIVITY;

  if (mapped.indexOf("{orderNumber}") >= 0) {
    const reference = entry.orderReference;
    // No order number to fill means the row is still a legitimate earn; it just
    // cannot name the order. Falling back to the neutral wording would lose real
    // information, so the sentence drops the clause instead.
    if (reference === null || reference === undefined) return "Points from your order";
    return fill(mapped, { orderNumber: String(reference) });
  }
  return mapped;
}

/**
 * The signed amount as the customer sees it.
 *
 * Uses U+2212 MINUS, not a hyphen, because the hyphen renders as a dash in the
 * theme's typeface and reads as punctuation rather than as a sign. A
 * non-finite input renders as `0` rather than `NaN`, which Requirement 16.8
 * forbids appearing in output at all.
 */
export function signedPoints(points: number): string {
  if (typeof points !== "number" || !isFinite(points)) return "0";
  const whole = Math.round(points);
  if (whole > 0) return `+${String(whole)}`;
  if (whole < 0) return `\u2212${String(Math.abs(whole))}`;
  return "0";
}

/** A referral stage's name, qualification and state wording (§18.9). */
export function referralStage(stage: PortalReferralStage): {
  name: string;
  qualification: string;
  state: string;
} {
  const key = typeof stage.key === "string" ? stage.key : "";
  const mapped = lookupStage(key);
  if (!mapped) {
    return {
      name: REFERRAL_FALLBACK.name,
      qualification: REFERRAL_FALLBACK.qualification,
      state: REFERRAL_FALLBACK.state,
    };
  }
  // The service derives THREE states, not two: `deriveStageState` returns `none`
  // when a stage has no awarded and no pending referrals. Folding `none` into the
  // unmapped fallback rendered "In progress" for a stage where nothing is in
  // progress — a statement about the customer's account that is not true. The
  // fallback stays for a genuinely unknown fourth state, which is what it is for.
  const state =
    stage.state === "awarded"
      ? mapped.awarded
      : stage.state === "pending"
        ? mapped.pending
        : stage.state === "none"
          ? mapped.none
          : REFERRAL_FALLBACK.state;
  return { name: mapped.name, qualification: mapped.qualification, state };
}

export function fulfilment(identifier: string): string {
  return lookup(FULFILMENT, identifier) ?? "We will confirm the next step by email";
}

export function availability(identifier: string): string {
  return lookup(AVAILABILITY, identifier) ?? "No longer available";
}

export function redemptionStatus(identifier: string): string {
  return lookup(REDEMPTION_STATUS, identifier) ?? "We will confirm this by email";
}

export function birthdayEligibility(identifier: string, allowedFrom?: string | null): string {
  const mapped = lookup(BIRTHDAY, identifier);
  if (mapped === undefined) return "Not yet added";
  if (mapped.indexOf("{date}") < 0) return mapped;
  // No date to name means the lock is real but its end is unknown to this
  // response; say so plainly rather than printing an empty gap.
  if (!allowedFrom) return "You can change this once a year";
  return fill(mapped, { date: formatDate(allowedFrom) });
}

export function provenance(identifier: string): string {
  return lookup(PROVENANCE, identifier) ?? "From your account";
}

export function insight(identifier: string, family?: string | null): string {
  const mapped = lookup(INSIGHT, identifier);
  if (mapped === undefined) return "";
  if (!family) return "";
  return fill(mapped, { family });
}

/**
 * The sentence for an error identifier.
 *
 * An unknown identifier gets the neutral sentence, never the identifier itself —
 * design E.1 rule 5, and the reason this function takes `string` rather than the
 * closed union: it must behave correctly for a code added to the service after
 * this asset shipped.
 */
export function error(code: string): string {
  return lookup(ERRORS, code) ?? ERROR_FALLBACK;
}

export function fieldError(code: string): string {
  return lookup(FIELD_ERRORS, code) ?? FIELD_ERROR_FALLBACK;
}

export function state(name: PortalSectionState): string {
  return lookup(STATES, name) ?? "";
}

/**
 * An ISO date as `12 June 2026`.
 *
 * Hand-formatted rather than via `toLocaleDateString` because the latter's output
 * depends on the browser's locale, and a UK store showing `6/12/2026` to a US
 * visitor states a different date. An unparseable input returns the input's date
 * part unchanged, which is still a date and never `Invalid Date`.
 */
const MONTHS: readonly string[] = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const year = match[1] ?? "";
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const month = MONTHS[monthIndex];
  if (month === undefined || !isFinite(day)) return iso;
  return `${String(day)} ${month} ${year}`;
}

/**
 * Marketing consent, with its date resolved (Requirement 13.3).
 *
 * `updatedAt` is an ISO instant from Shopify, or the empty string when consent has
 * never been set — which is a different statement from "withdrawn" and gets its own
 * sentence rather than a subscribed/withdrawn line with an empty date.
 */
export function consentState(subscribed: boolean, updatedAt?: string | null): string {
  if (!updatedAt) {
    return lookup(CONSENT, "never_set") ?? "You have not set a preference yet";
  }
  const mapped = lookup(CONSENT, subscribed ? "subscribed" : "withdrawn");
  if (mapped === undefined) return "";
  return fill(mapped, { date: formatDate(updatedAt) });
}

/** Wording for a privacy action, `{reference}` resolved where the table uses it. */
export function privacyAction(identifier: string, reference?: string | null): string {
  const mapped = lookup(PRIVACY, identifier);
  if (mapped === undefined) return "";
  if (mapped.indexOf("{reference}") < 0) return mapped;
  // No reference to quote means the sentence must not invite the customer to quote
  // one. The acknowledgement still stands on its own.
  if (!reference) return "We have recorded your request. A member of our team will action it and contact you.";
  return fill(mapped, { reference });
}

/**
 * A wait after a `429`, stated as a duration and never as a limit.
 *
 * Design E.2 forbids the phrase "rate limit" and any limiter internals in rendered
 * output, so this names neither the ceiling nor the window — only how long is left,
 * which is the one thing the customer can act on. `retryAfterSeconds` absent means
 * the server sent no countdown, so the sentence stays honest about that too.
 */
export function waitFor(seconds?: number | null): string {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) {
    return "Please try that again shortly.";
  }
  if (seconds < 60) return `Please try again in ${String(Math.ceil(seconds))} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return `Please try again in ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** The vocabularies, exposed so the totality test can enumerate them. */
export const COPY_TABLES = {
  consent: CONSENT,
  privacy: PRIVACY,
  activityByReason: ACTIVITY_BY_REASON,
  referralStages: REFERRAL_STAGES,
  fulfilment: FULFILMENT,
  availability: AVAILABILITY,
  redemptionStatus: REDEMPTION_STATUS,
  birthday: BIRTHDAY,
  provenance: PROVENANCE,
  insight: INSIGHT,
  errors: ERRORS,
  fieldErrors: FIELD_ERRORS,
  states: STATES,
  neutralActivity: NEUTRAL_ACTIVITY,
  referralFallback: REFERRAL_FALLBACK,
} as const;
