# Requirements Document

> **Status: PLANNING / REQUIREMENTS ONLY.** This document derives requirements from the approved `design.md`. **No live changes** will be made to the Shopify store, theme, customer metafields, discount codes, or any customer data until this spec is explicitly approved. Nothing here executes against the live store. All Shopify writes described below are *proposed* behavior of the future Loyalty Service, not actions taken now.

## Introduction

The Athoor Loyalty Platform is an API-first loyalty ecosystem for the Athoor London Shopify store (`myathoorlondon.myshopify.com`, Basic plan). It replaces today's non-transactional, metafield-based "rewards club" (where redemption is a `mailto:` link and points live in customer metafields) with a standalone loyalty microservice (Node.js + PostgreSQL) that is the single source of truth via an immutable transaction ledger.

The same versioned `/v1` API serves three consumers over time: the existing luxury LV-inspired web dashboard today (via Shopify App Proxy), a richer luxury customer portal, and a future native mobile app — all authenticating against Shopify's Customer Account API rather than any custom authentication. Shopify customer metafields are demoted to an optional display cache written asynchronously by the service, so the existing Liquid dashboard keeps rendering with zero visual regression.

Because the store is on the Basic plan (no Shopify Flow, no checkout customization), all automation lives in the external backend. The service consumes Shopify webhooks (`customers/create`, `orders/paid`, `refunds/create`, `orders/cancelled`) with HMAC verification and idempotency protection, and calls the Admin API outbound to mint unique, single-use, customer-bound discount codes on redemption.

These requirements cover seven domains: (1) the luxury customer portal, (2) the ledger-based loyalty platform, (3) VIP membership tiers, (4) future mobile-app API compatibility, (5) admin management tooling, (6) security, and (7) scalability and reliability — plus a data-safe migration for the existing 8 enrolled and 31 non-enrolled customers. Acceptance criteria are grounded in the 12 correctness properties already defined in `design.md`.

### Documented Assumptions (resolving design open questions)

These resolve the "Open Questions" section of `design.md` with sensible, documented defaults. Where a value is a business policy choice, it is captured as configurable.

- **A1 — Points expiry window:** Points expire **12 months** from their earning date (FIFO), unless a lot is explicitly non-expiring (e.g. migrated legacy balances).
- **A2 — Eligible total for earning:** `eligibleTotal` **excludes shipping and tax** and is computed on the **post-discount** order subtotal.
- **A3 — Non-enrolled customers:** The 31 non-enrolled customers are enrolled **lazily** — a `customers` row is created on their first qualifying event, not eagerly at migration.
- **A4 — Clawback and tier:** Clawback from a refund/cancellation **does not lower an already-earned tier by default** (configurable via an `allowTierDowngradeOnClawback` policy flag).
- **A5 — ESP (email provider):** The transactional email/ESP provider for pre-expiry notifications is **to be confirmed**; the design assumes a transactional email tier and treats the ESP as a pluggable dependency.
- **A6 — Hosting provider:** Hosting is **to be confirmed**; the design recommends Railway/Render for MVP. This does not affect functional requirements.
- **A7 — Negative balance policy:** Spendable balance is **never forced below zero** by default (configurable `allowNegative` policy flag, off by default).
- **A8 — Base currency:** The **Base_Currency is GBP**. All earning thresholds, tier thresholds, and reward costs are denominated in GBP today. Per-market currency conversion is a **future** extension (see Requirement 21) and does not exist at MVP.
- **A9 — Single market today:** The platform operates a **single Market/Region (United Kingdom)** at MVP. Multi-region/multi-market support is a **future** extension, structured as configuration so additional markets can be added without Ledger redesign.
- **A10 — Recently-viewed retention window:** Recently viewed products are retained for a rolling **90-day window** (configurable). Entries older than the window are excluded from the Fragrance_Profile.
- **A11 — Recommendation logic:** Suggested fragrances use **rules-based recommendations** at MVP (derived from purchase and view history). Richer or model-based recommendation logic is a **future** extension implemented behind a stable interface so the `/v1` response contract does not change.
- **A12 — Analytics computation cadence:** Admin analytics are computed from cached aggregates **refreshed on demand when stale** (freshness budget: 1 hour) rather than strictly real-time. Because analytics has a single consumer — an admin opening the view — the refresh is triggered by the read itself instead of a background schedule. All metrics remain **derivable on demand** from the Ledger and Shopify order data; each analytics response reports the timestamp at which its metrics were computed.
- **A13 — VIP private-client perks are future roadmap:** Royal_VIP private-client perks (private consultations, early access to launches, limited-edition releases, exclusive samples, dedicated personal service, invitation-only experiences) are **future** roadmap. The **MVP scope is the configurable, tier-gated entitlement/benefit framework only** (see Requirement 18).
- **A14 — Wishlist reconciliation:** The existing device-local `shopify-wishlist` `localStorage` entry is authoritative for anonymous browsing. On authentication it is **merged (union)** into the account-level wishlist owned by the Loyalty_Service, which is authoritative thereafter.
- **A15 — Best-effort scheduling with catch-up:** The platform targets **zero-cost hosting**, where the service sleeps when idle. Recurring work is therefore driven by **due work derived from a persisted last-run timestamp**, not by a cron window: a window that elapses while the service is asleep is **caught up on the next start** rather than skipped. Recurring jobs are consequently **at-least-once with catch-up semantics and no guaranteed execution time**, and every handler is idempotent so a late or repeated run is safe. This trades timing precision for cost; it does not weaken any ledger correctness property. Cold-start latency after an idle period is an accepted consequence of the same choice.

## Glossary

- **Loyalty_Service**: The external Node.js + PostgreSQL microservice that owns all loyalty state and business rules. The authoritative system for all requirements below unless another system is named.
- **Ledger**: The append-only `ledger_entries` table. Every point movement is an immutable row; rows are never updated or deleted. Balance is a projection (sum) of the ledger.
- **Points**: The loyalty currency. Positive ledger entries are credits (earn); negative entries are debits (spend, clawback, expire).
- **Point_Lot**: A batch of points created by a single earning event, carrying an earning date and an expiry date, consumed FIFO on redemption. `remaining_points` is a decrement-only cache reconstructable from the ledger.
- **Balance**: `SUM(ledger_entries.points)` for a customer. The total point balance.
- **Spendable_Balance**: `SUM(point_lots.remaining_points)` for non-expired lots — the points currently available to redeem.
- **Tier**: A VIP membership level (Bronze, Silver, Gold, Royal_VIP) derived from lifetime spend, controlling the earning multiplier and perks.
- **Redemption**: A spend that converts points into a Shopify discount code (`100→£5`, `250→£15`, `500→£35`, `1000→£75`).
- **Clawback**: A negative ledger entry that reverses points previously earned on an order that was refunded or cancelled.
- **Expiry**: The FIFO process that debits points from lots whose expiry date has passed.
- **App_Proxy**: Shopify App Proxy (`/apps/loyalty/*`). Forwards signed storefront/web requests to the Loyalty_Service `/v1` API and injects `logged_in_customer_id`.
- **Customer_Account_API**: Shopify's Customer Account API, the shared identity/auth provider for web and mobile. The Loyalty_Service builds no custom authentication.
- **Admin_API**: Shopify's GraphQL Admin API, called outbound (queued) to mint discount codes and write the metafield cache.
- **Metafield_Cache**: Shopify customer metafields (`loyalty.points_balance`, `tier`, etc.), a best-effort display cache written by the service — never the source of truth.
- **Enrolled_Customer**: A customer who has opted into the loyalty program and has a `customers` row with a non-null `enrolled_at`. Today there are 8.
- **Non_Enrolled_Customer**: A customer who has not opted in. Today there are 31; they are enrolled lazily (see A3).
- **Webhook_Receiver**: The component that terminates inbound Shopify webhooks (HMAC verify, dedupe, persist, hand off).
- **Loyalty_Engine**: The component holding all business rules and the only writer to the ledger.
- **Admin_Gateway**: The only component that calls the Admin_API; runs from a queue with rate-limit backoff.
- **Scheduler**: The time-driven component running the daily expiry scan and pre-expiry notifications.
- **Admin_User**: An Athoor staff member using the admin tooling for manual adjustments, credits, fraud review, and reconciliation.
- **Customer_Portal**: The luxury customer-facing web experience defined in Requirement 8, served by the Loyalty_Service via App_Proxy and consuming the `/v1` API.
- **Private_Client**: A presentation posture for the Customer_Portal that frames the member relationship as a bespoke, editorial, boutique relationship with a luxury fragrance house, rather than a generic Shopify account page.
- **Fragrance_Profile**: A customer's personalised fragrance relationship data set — purchased fragrances, Favourites, Wishlist, recently viewed products, suggested fragrances, and the Fragrance_Journey_Timeline.
- **Fragrance_Journey_Timeline**: A chronological view of a customer's fragrance milestones (e.g., first purchase, favourites added, tier changes).
- **Favourite**: A fragrance a customer has explicitly marked as preferred; a customer preference owned by the Loyalty_Service (not the Metafield_Cache).
- **Wishlist**: A customer's saved list of desired fragrances; reconciled from the device-local `shopify-wishlist` entry into an account-level list on authentication (A14).
- **Benefit**: A configurable, tier-gated entitlement associated with a minimum qualifying Tier, addable by configuration without schema redesign.
- **Channel**: The origin of an interaction or reward (e.g., `web` or `app`), enabling channel-attributable rewards such as app-exclusive rewards.
- **Device_Token**: A push-notification registration token identifying a customer's device for a future mobile app.
- **Digital_Membership_Card**: A verifiable member credential/identifier (including QR-based identification) exposed by the Loyalty_Service for membership identification, without exposing other customers' data.
- **Admin_Analytics**: Aggregated loyalty-program performance metrics derived solely from the immutable Ledger and Shopify order data.
- **Base_Currency**: The reference currency (GBP, per A8) against which earning, tier thresholds, and reward costs are defined.
- **Market** (also **Region**): A geographic operating context that may carry its own currency, reward rule set, and language. A single Market operates at MVP (A9); additional markets are a future extension.

## Requirements

### Requirement 1: Ledger as Single Source of Truth

**User Story:** As the platform owner, I want every point movement recorded in an immutable ledger, so that balances are always auditable, correct, and reconstructable.

#### Acceptance Criteria

1. WHEN any point movement of type earn, spend, clawback, expiry, adjustment, or migration occurs, THE Loyalty_Service SHALL append exactly one new row to the Ledger recording the entry type, a signed integer point amount, a reason, the customer id, and a timestamp, and SHALL NOT update or delete any existing Ledger row.
2. THE Loyalty_Service SHALL compute a customer Balance as the sum of that customer's Ledger entries and SHALL NOT store Balance as an independently mutable value. *(Property 1)*
3. THE Loyalty_Service SHALL compute Spendable_Balance as the sum of `remaining_points` across that customer's non-expired Point_Lots. *(Property 2)*
3a. WHERE a Ledger entry increases a customer's Balance — an earning of any kind, a positive adjustment, a manual credit, a migration entry, or a compensating reversal — THE Loyalty_Service SHALL create a matching Point_Lot of the same point amount, so that Spendable_Balance never permanently understates the points a customer has been credited. *(Property 17)*
4. WHERE a Ledger entry represents an earn event, THE Loyalty_Service SHALL record a point amount strictly greater than zero.
5. WHERE a Ledger entry represents a spend, clawback, or expiry event, THE Loyalty_Service SHALL record a point amount strictly less than zero.
6. IF a request attempts to modify or delete any existing Ledger row, THEN THE Loyalty_Service SHALL reject the request, leave the Ledger unchanged, and return a response indicating that the Ledger is append-only.
7. WHEN a reconciliation run executes, THE Loyalty_Service SHALL recompute cached lifetime points, tier, and lot remainders solely from the Ledger and SHALL overwrite any cached value that differs from the recomputed value.
8. IF a Ledger append fails, THEN THE Loyalty_Service SHALL reject the originating operation, leave the Ledger unchanged, and return an error to the caller.

### Requirement 2: Earning Points

**User Story:** As a customer, I want to earn points for signing up, purchasing, and referring friends, so that I am rewarded for engaging with Athoor.

#### Acceptance Criteria

1. WHEN a verified `customers/create` webhook is processed for a new Enrolled_Customer, THE Loyalty_Service SHALL create exactly one signup earning of exactly 50 points.
2. WHEN a verified `orders/paid` webhook is processed AND the order's `eligibleTotal` is greater than zero, THE Loyalty_Service SHALL create exactly one order earning of exactly `floor(eligibleTotal × tierMultiplier)` points, where `eligibleTotal` is the post-discount order amount in store currency excluding shipping and tax. *(Property 7, A2)*
3. IF a verified `orders/paid` webhook is processed AND the order's `eligibleTotal` is less than or equal to zero, THEN THE Loyalty_Service SHALL create no order earning and SHALL leave the customer's Balance unchanged.
4. WHERE the tier multiplier applies, THE Loyalty_Service SHALL use Bronze 1x, Silver 1.5x, Gold 2x, and Royal_VIP 3x based on the customer's tier at the time the order is processed, and SHALL default to Bronze 1x when the customer's tier is undefined or unrecognized.
5. WHEN a verified `orders/paid` webhook is processed AND no prior paid-order earning exists for the customer, THE Loyalty_Service SHALL create an additional first-purchase earning of exactly 100 points. *(Property 7)*
6. WHEN any earning that increases a customer's Balance is created — including a signup earning, an order earning, a first-purchase earning, and a referral earning — THE Loyalty_Service SHALL create a matching Point_Lot of the same point amount whose expiry timestamp is exactly 12 months after the earning timestamp, so that every earned point is spendable. *(A1, Property 17)*
7. IF a `customers/create` or `orders/paid` webhook fails HMAC verification, THEN THE Loyalty_Service SHALL reject the webhook, create no earning, and leave all balances unchanged.
8. IF a duplicate or replayed verified webhook is processed for an event that has already been earned, THEN THE Loyalty_Service SHALL create no additional earning and SHALL leave all balances unchanged.
9. WHEN a referred friend completes signup, THE Loyalty_Service SHALL create a referral earning of 150 points for the referrer and a matching Point_Lot expiring exactly 12 months after that earning. *(A1, Property 17)*
10. WHEN a referred friend completes their first paid purchase, THE Loyalty_Service SHALL create a referral earning of 250 points for the referrer and a matching Point_Lot expiring exactly 12 months after that earning. *(A1, Property 17)*
11. WHEN an earning event is processed, THE Loyalty_Service SHALL increase only the affected customer's Balance and SHALL NOT change any other customer's Balance.

### Requirement 3: Automated Redemption

**User Story:** As a customer, I want to redeem points for a discount code automatically, so that I no longer have to email the store to claim a reward.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL offer exactly four redeemable rewards mapping 100 points→£5, 250 points→£15, 500 points→£35, and 1000 points→£75, and SHALL NOT accept redemption for any reward tier outside this set.
2. WHEN a customer submits a redemption for a reward in the defined reward set, THE Loyalty_Service SHALL acquire an exclusive lock on the customer record within 5 seconds, verify Spendable_Balance is at least the reward cost in points, record exactly one negative spend Ledger entry equal to the reward cost, and consume Point_Lots in oldest-first (FIFO) order for exactly the reward cost. *(Property 4)*
3. IF Spendable_Balance is less than the reward cost, THEN THE Loyalty_Service SHALL roll back the transaction, make no Ledger change, retain the customer's existing point balance unchanged, and return an insufficient-points error to the caller.
4. WHEN a spend is recorded, THE Loyalty_Service SHALL ensure the resulting Spendable_Balance is greater than or equal to zero. *(Property 3, A7)*
5. WHEN a redemption is recorded, THE Loyalty_Service SHALL enqueue generation of exactly one unique, single-use, customer-bound Shopify discount code via the Admin_Gateway. *(Property 10)*
6. WHEN a discount code is generated, THE Loyalty_Service SHALL create the code with usage limit 1, applies-once-per-customer, and customer selection bound to the redeeming customer only. *(Property 10)*
7. IF two redemption requests share the same customer and idempotency key, THEN THE Loyalty_Service SHALL produce at most one spend and at most one discount code, and return the existing redemption on every repeat request. *(Property 5)*
8. WHEN a discount code has been issued for a redemption, THE Loyalty_Service SHALL make the code visible in the customer's account within 10 seconds of issuance.
9. IF the Admin_API fails on 3 consecutive attempts within 60 seconds after a spend was recorded, THEN THE Loyalty_Service SHALL mark the redemption failed, record a compensating Ledger adjustment that reverses the spend by the exact reward cost, and return a redemption-failed error to the caller.
10. IF a customer submits a redemption for a reward tier outside the defined reward set, THEN THE Loyalty_Service SHALL reject the request, make no Ledger change, and return an invalid-reward error to the caller.
11. IF the exclusive lock on the customer record cannot be acquired within 5 seconds, THEN THE Loyalty_Service SHALL abort the redemption, make no Ledger change, and return a lock-timeout error to the caller.

### Requirement 4: Refund and Cancellation Clawback

**User Story:** As the platform owner, I want points earned on refunded or cancelled orders to be reclaimed, so that customers cannot keep rewards for purchases they did not complete.

#### Acceptance Criteria

1. WHEN a signature-verified `refunds/create` webhook is processed, THE Loyalty_Service SHALL create a negative clawback Ledger entry whose magnitude equals the original earn rate applied to the refunded eligible amount, rounded to the nearest whole point with 0.5 rounding up.
2. WHEN a signature-verified `orders/cancelled` webhook is processed, THE Loyalty_Service SHALL create negative clawback Ledger entries reversing the points earned on that order.
3. THE Loyalty_Service SHALL ensure that, for any order, the cumulative absolute clawback is greater than or equal to zero and less than or equal to the total points earned on that order. *(Property 8)*
4. WHEN a full refund is processed for an order whose earnings were fully applied, THE Loyalty_Service SHALL claw back exactly the points that order earned so that the net order-attributable balance for that order equals zero. *(Property 8)*
5. WHEN a partial refund is processed, THE Loyalty_Service SHALL claw back points proportional to the refunded eligible amount, bounded so the cumulative absolute clawback for the order never exceeds the total points earned on that order. *(Property 8)*
6. WHERE the `allowNegative` policy is disabled, THE Loyalty_Service SHALL clamp the clawback so the resulting Spendable_Balance is greater than or equal to zero. *(A7)*
7. WHERE the `allowTierDowngradeOnClawback` policy is disabled, THE Loyalty_Service SHALL retain the customer's tier unchanged after a clawback. *(A4)*
8. IF a `refunds/create` or `orders/cancelled` webhook fails signature verification, THEN THE Loyalty_Service SHALL reject the webhook, create no clawback, and leave all balances and tiers unchanged.
9. IF a `refunds/create` or `orders/cancelled` webhook is a duplicate of an already-processed event identifier, THEN THE Loyalty_Service SHALL create no additional clawback and SHALL leave all balances unchanged.

### Requirement 5: FIFO Points Expiry and Notifications

**User Story:** As a customer, I want to know before my points expire, so that I have a chance to use them.

#### Acceptance Criteria

1. WHEN any Balance-increasing earning creates a Point_Lot — signup, order, first-purchase, or referral — THE Loyalty_Service SHALL record the earning date and set the expiry date to exactly 12 calendar months after the earning date. *(A1)*
2. WHEN the expiry scan runs, THE Loyalty_Service SHALL, for every Point_Lot whose expiry date is on or before the scan date and whose remaining_points is strictly greater than zero, create exactly one negative expiry Ledger entry whose magnitude equals that lot's remaining_points and set that lot's remaining_points to zero. *(Property 9)*
2a. THE Loyalty_Service SHALL run the expiry scan at least once per day WHILE the service is running, and WHERE one or more daily windows elapsed while the service was not running, THE Loyalty_Service SHALL run the scan once on its next start so the missed windows are caught up rather than skipped. *(A15)*
2b. WHERE the expiry scan has not yet run for a matured Point_Lot, THE Loyalty_Service SHALL nevertheless exclude that lot from Spendable_Balance, so an expired point can never be redeemed regardless of scan timing. *(Property 2)*
3. WHEN the expiry scan runs more than once for the same scan date, THE Loyalty_Service SHALL treat every run after the first as a no-op for that date and SHALL NOT create more than one expiry Ledger entry for any single Point_Lot. *(Property 9)*
4. WHEN the pre-expiry notification sweep runs, THE Loyalty_Service SHALL, for each customer holding one or more Point_Lots whose remaining_points is strictly greater than zero and whose expiry date falls within the configured pre-expiry window (a whole number of days from 1 to 90 inclusive, default 30) measured forward from the sweep date, enqueue exactly one notification per qualifying Point_Lot that has not already been notified within that lot's pre-expiry window, each notification including the lot's expiring amount and expiry date.
5. WHILE a lot has already been notified within its pre-expiry window, THE Loyalty_Service SHALL NOT enqueue a duplicate pre-expiry notification for that lot.
6. WHEN points are consumed on redemption, THE Loyalty_Service SHALL consume only Point_Lots whose remaining_points is strictly greater than zero, in ascending earning-date (FIFO) order, breaking ties between lots with identical earning dates by ascending lot creation order.
7. IF a redemption requests more points than the sum of remaining_points across the customer's non-expired Point_Lots, THEN THE Loyalty_Service SHALL reject the redemption, return an error response indicating insufficient points, and leave every Point_Lot's remaining_points unchanged.

### Requirement 6: Transaction History

**User Story:** As a customer, I want to see a history of my points activity, so that I understand how my balance changed.

#### Acceptance Criteria

1. WHEN a customer requests their history, THE Loyalty_Service SHALL return Ledger entries where each entry includes a transaction type of exactly one of earned, spent, or expired, a reason description, a date as an ISO 8601 timestamp, and an order reference for entries associated with an order.
2. WHEN a customer requests their history, THE Loyalty_Service SHALL return Ledger entries ordered by date from most recent to oldest.
3. WHEN a customer requests their history without specifying a page size, THE Loyalty_Service SHALL return the first page containing a maximum of 20 Ledger entries along with the total entry count and an indicator of whether additional pages exist.
4. WHERE a customer specifies a page size, THE Loyalty_Service SHALL return a page containing no more than the requested number of Ledger entries, limited to a maximum of 100 entries per page.
5. IF a customer requests their history with a page size less than 1 or greater than 100, or a page number less than 1, THEN THE Loyalty_Service SHALL reject the request and return an error response indicating the invalid pagination parameter, without returning any Ledger entries.
6. IF a customer has no Ledger entries, THEN THE Loyalty_Service SHALL return an empty history with a total entry count of 0.
7. WHEN a customer requests their history, THE Loyalty_Service SHALL return an identical set of Ledger entries in identical order regardless of whether the request arrives via App_Proxy or Customer_Account_API identity.

### Requirement 7: VIP Membership Tiers

**User Story:** As a customer, I want my spending to unlock higher membership tiers with better rewards, so that loyalty feels premium and progressive.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL define four membership tiers based on cumulative lifetime spend, measured in GBP as the sum of the paid totals of a customer's paid orders (excluding refunded, cancelled, and unpaid amounts), with inclusive lower thresholds: Bronze (lifetime spend from £0.00 to £299.99), Silver (from £300.00 to £749.99), Gold (from £750.00 to £1,499.99), and Royal_VIP (from £1,500.00 and above).
2. WHEN a paid order increases a customer's lifetime spend so that it reaches or exceeds one or more higher tier thresholds, THE Loyalty_Service SHALL, upon completion of processing that order, advance the customer to the highest tier whose lower threshold is met by the updated lifetime spend.
3. WHEN a paid order is processed, THE Loyalty_Service SHALL NOT lower the customer's tier as a result of processing that order, retaining at least the tier held immediately before processing. *(Property 11)*
4. WHILE a customer holds a tier, THE Loyalty_Service SHALL apply that tier's earning multiplier to order earnings, where the multipliers are Bronze = 1.0x, Silver = 1.5x, Gold = 2.0x, and Royal_VIP = 3.0x, and the multiplier value is non-decreasing from Bronze through Royal_VIP.
5. WHEN a customer requests their account data, THE Loyalty_Service SHALL return the current tier name, the current lifetime spend in GBP to two decimal places, and the progress toward the next tier expressed as the remaining GBP amount required to reach the next higher tier's lower threshold.
6. WHILE a customer holds the Royal_VIP tier, THE Loyalty_Service SHALL return the progress-to-next-tier value as an indication that the highest tier has been reached and that no higher tier exists.
7. THE Loyalty_Service SHALL retain a customer's highest achieved tier for the lifetime of the account and SHALL NOT downgrade a customer to a lower tier, because lifetime spend is cumulative and non-decreasing.
8. WHERE a customer holds the Royal_VIP tier, THE Loyalty_Service SHALL grant the Royal_VIP-exclusive benefits configured for that tier in addition to the Royal_VIP earning multiplier defined in criterion 4.

### Requirement 8: Luxury Customer Portal

**User Story:** As a customer, I want a premium account experience, so that managing my profile and rewards feels consistent with the Athoor brand.

#### Acceptance Criteria

1. WHEN an authenticated customer opens the portal, THE Loyalty_Service SHALL provide, within 3 seconds under normal network conditions, the customer's profile, order history, saved addresses, points balance, current tier and tier progress, available rewards, and activity/transaction history. *(Measured while the service is running; a first request after the host has idled additionally incurs host spin-up, per A15.)*
2. THE Customer_Portal SHALL preserve the existing LV-inspired premium branding of the current dashboard, matching its typography scale, color palette, spacing, and layout components with no visual regressions from the current design.
3. THE Customer_Portal SHALL render without horizontal scrolling, content overflow, or overlapping elements across viewport widths from 320px to 1920px, covering both mobile (320px–767px) and desktop (≥1024px) breakpoints.
4. WHERE the Loyalty_Service API does not respond within 3 seconds or returns an error, THE Customer_Portal SHALL fall back to the Metafield_Cache values so the dashboard continues to render all sections.
5. WHEN the portal displays the rewards dashboard, THE Loyalty_Service SHALL show the current Spendable_Balance, the available rewards, and any issued discount codes.
6. IF both the Loyalty_Service API and the Metafield_Cache are unavailable, THEN THE Customer_Portal SHALL display an error message indicating that account data is temporarily unavailable and SHALL retain any already-rendered content without data loss.
7. THE Customer_Portal SHALL conform to WCAG 2.1 Level AA, including keyboard navigation for all interactive elements, ARIA labels on interactive controls, and a minimum text contrast ratio of 4.5:1.
8. WHEN the portal loads, THE Customer_Portal SHALL meet Core Web Vitals thresholds of Largest Contentful Paint under 2.5 seconds, Cumulative Layout Shift under 0.1, and First Input Delay under 100 milliseconds.

### Requirement 9: Versioned API and Mobile Compatibility

**User Story:** As a platform architect, I want one stable versioned API for web and a future mobile app, so that a released mobile app never breaks and no backend logic is duplicated.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL expose every loyalty operation under a URL path prefixed with `/v1` and SHALL NOT expose any loyalty operation outside the `/v1` path prefix.
2. WHEN a request arrives via App_Proxy or via Customer_Account_API identity, THE Loyalty_Service SHALL resolve it to a customer identity before executing any handler.
3. IF a request's customer identity cannot be resolved, THEN THE Loyalty_Service SHALL reject the request, perform no state change, and return a response indicating identity-resolution failure.
4. THE Loyalty_Service SHALL permit only additive changes to the `/v1` API (new endpoints, new optional fields) and SHALL NOT remove or rename any existing `/v1` endpoint or field.
5. WHERE a change to the API is breaking, THE Loyalty_Service SHALL introduce it under a new version path (`/v2`) while leaving `/v1` unchanged.
6. WHERE an endpoint accepts a state-changing request, THE Loyalty_Service SHALL accept an idempotency key of 1 to 128 characters and, within a 24-hour deduplication window, SHALL return the stored result for a repeated key without performing any additional state change.
7. IF a state-changing request supplies a missing or invalid idempotency key, THEN THE Loyalty_Service SHALL reject the request and return a response indicating the invalid idempotency key.
8. THE Loyalty_Service SHALL include a version identifier in every JSON response and SHALL NOT retain session state between requests.

### Requirement 10: Admin Management Tooling

**User Story:** As an Athoor staff member, I want tools to manage points, credits, and fraud, so that I can handle cases the automated system cannot.

#### Acceptance Criteria

1. IF a user attempts to access any admin management tool without an authenticated Admin_User session holding an admin authorization role, THEN THE Loyalty_Service SHALL deny the action, perform no data change, and return a response indicating that authorization is required.
2. WHEN an Admin_User submits a manual point adjustment specifying a signed integer point amount and a non-empty reason of 1 to 500 characters, THE Loyalty_Service SHALL create one adjustment Ledger entry recording the point delta, the reason, the acting Admin_User identifier, and the adjustment timestamp.
2a. WHERE a manual point adjustment carries a positive point delta, THE Loyalty_Service SHALL create a matching Point_Lot of the same amount expiring exactly 12 months after the adjustment timestamp, so the credited points are spendable. *(A1, Property 17)*
3. IF an Admin_User submits a manual point adjustment with a missing or empty reason, or a reason exceeding 500 characters, THEN THE Loyalty_Service SHALL reject the adjustment, create no Ledger entry, and return a response indicating the reason is invalid.
4. WHEN an Admin_User grants manual credit for a non-automatable action specifying a non-empty reason of 1 to 500 characters that identifies the action, THE Loyalty_Service SHALL create one adjustment earning Ledger entry recording the credited point amount, the identified action, the acting Admin_User identifier, and the timestamp, together with a matching Point_Lot of the same amount expiring exactly 12 months after that timestamp. *(A1, Property 17)*
5. WHEN an Admin_User selects a customer, THE Loyalty_Service SHALL display that customer's complete Ledger and transaction history ordered from most recent to oldest, where each entry shows its type, point amount, reason, acting party, and timestamp.
6. WHEN an Admin_User opens the fraud-review view, THE Loyalty_Service SHALL display the list of referrals and redemptions with, for each item, its status, the associated customer identifier, the point or credit amount, and the timestamp.
7. WHEN an Admin_User initiates a reconciliation operation, THE Loyalty_Service SHALL execute the operation and return a completion result reporting the count of records processed and the count of records that failed.
7a. IF an Admin_User initiates a data migration (the M0–M2 cutover) through the admin API, THEN THE Loyalty_Service SHALL refuse the request, perform no migration and no data change, and return a response indicating that migration is not enabled via the API and must be run as an operator script. The cutover depends on the M0 export as its rollback anchor and is therefore executed deliberately by an operator, never triggered by an HTTP call.
8. WHERE an action cannot be verified through any Shopify or partner API, THE Loyalty_Service SHALL grant points for that action only through a manual Admin_User credit and SHALL reject any automated grant attempt for that action.
9. WHEN the Loyalty_Service records any manual adjustment, manual credit, migration, or reconciliation operation, THE Loyalty_Service SHALL create an immutable audit-trail record capturing the acting Admin_User identifier, the operation type, the affected customer identifier where applicable, and the timestamp.

### Requirement 11: Security and Identity

**User Story:** As the platform owner, I want the system secured against tampering, fraud, and data leakage, so that customer trust and program integrity are protected.

#### Acceptance Criteria

1. WHEN an inbound webhook is received, THE Webhook_Receiver SHALL verify the HMAC-SHA256 signature computed over the raw request body using a constant-time comparison.
2. IF the HMAC verification fails, THEN THE Webhook_Receiver SHALL reject the request with HTTP 401, persist nothing, and perform no state change.
3. WHEN a web request arrives via App_Proxy, THE Loyalty_Service SHALL verify Shopify's App_Proxy signature and, only after successful verification, SHALL trust the injected `logged_in_customer_id`.
4. IF App_Proxy signature verification fails, THEN THE Loyalty_Service SHALL ignore the injected `logged_in_customer_id`, perform no state change, and reject the request.
5. THE Loyalty_Service SHALL delegate identity and authentication to the Customer_Account_API and SHALL NOT store customer passwords or build custom authentication.
6. THE Loyalty_Service SHALL store the Admin_API token, webhook secret, App_Proxy shared secret, and database credentials in a secrets manager or environment variables, and SHALL NOT commit them to the repository or theme.
7. THE Loyalty_Service SHALL NOT reuse the local MCP `shpat_` token from `.kiro/settings/mcp.json` for the production service.
8. IF a referral is submitted where the referrer and the referred customer are the same, THEN THE Loyalty_Service SHALL reject the referral, create no earning, and leave all balances unchanged. *(Property 12)*
9. WHEN a referred friend makes their first paid purchase, THE Loyalty_Service SHALL award the referral first-purchase reward exactly once, and SHALL NOT award it if the referred friend has any prior paid purchase.
10. THE Loyalty_Service SHALL store as customer data only the Shopify customer id, email, and the behavioural preference data defined in Requirement 17 (Favourites, Wishlist, and recently viewed products), SHALL treat email and behavioural preference data as sensitive, SHALL prune recently viewed products to the retention window defined in A10, and SHALL retain any log containing PII-bearing payloads or tokens for at most 24 hours.
11. THE Loyalty_Service SHALL serve all traffic over HTTPS and SHALL request only least-privilege Admin_API scopes (`read_customers`, `read_orders`, `read_products`, `write_discounts`, `write_price_rules`, and required webhook scopes).
12. WHILE a customer has issued more than 10 requests to `/v1/redeem` within a 60-second window, THE Loyalty_Service SHALL reject further redemption requests from that customer until the window elapses.

### Requirement 12: Idempotent Webhook Processing

**User Story:** As the platform owner, I want duplicate Shopify events to have no effect, so that retries and replays never corrupt balances.

#### Acceptance Criteria

1. WHEN a webhook passes HMAC verification, THE Webhook_Receiver SHALL persist its X-Shopify-Webhook-Id to durable storage before handing the webhook off to the Loyalty_Engine, and SHALL retain each recorded identifier for at least 30 days.
2. IF a webhook is received whose X-Shopify-Webhook-Id is already recorded in durable storage, THEN THE Webhook_Receiver SHALL respond with HTTP 200 as a no-op and SHALL make zero changes to any balance. *(Property 6)*
3. WHEN a webhook is accepted, THE Webhook_Receiver SHALL respond with HTTP 200 within 5 seconds and SHALL defer all Admin_API and email work to the job queue.
4. IF two or more webhooks bearing the same X-Shopify-Webhook-Id are received concurrently, THEN THE Webhook_Receiver SHALL record the identifier and hand off to the Loyalty_Engine for exactly one of them, and SHALL treat the remaining webhooks as no-ops that change no balances. *(Property 6)*
5. IF a webhook that passed HMAC verification contains no X-Shopify-Webhook-Id or an empty X-Shopify-Webhook-Id value, THEN THE Webhook_Receiver SHALL reject the webhook without changing any balances and SHALL return a response indicating the missing identifier.

### Requirement 13: Scalability and Reliability

**User Story:** As the platform owner, I want the system to stay correct and available as it grows, so that it scales from tens of customers today to thousands without redesign.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL treat the Ledger as the source of truth and the Metafield_Cache as a non-authoritative cache only.
2. WHEN the Admin_Gateway calls the Admin_API, THE Loyalty_Service SHALL route the call through a job queue using exponential backoff (initial retry delay of 1 second, doubling on each subsequent attempt, capped at a maximum delay of 60 seconds, up to a maximum of 10 attempts) on throttling responses and SHALL NOT call the Admin_API synchronously inside a webhook handler.
3. IF the Admin_API returns a throttling response during code generation, THEN THE Loyalty_Service SHALL retry the job with exponential backoff (up to a maximum of 10 attempts) and keep the redemption in a pending state until the code is issued.
4. IF the maximum of 10 retry attempts is exhausted during code generation without the code being issued, THEN THE Loyalty_Service SHALL retain the redemption record without deducting or duplicating points and SHALL surface an error indication that the code could not be issued.
5. IF the Metafield_Cache write fails, THEN THE Loyalty_Service SHALL treat the failure as non-fatal, retry the write up to a maximum of 5 attempts using exponential backoff (initial delay of 1 second, capped at 60 seconds), and continue to serve authoritative data from the Ledger during and after the failure.
5a. WHEN any committed operation changes a customer's Balance — an earning, a clawback, a redemption spend, a compensating reversal, a manual adjustment, or a manual credit — THE Loyalty_Service SHALL enqueue a Metafield_Cache refresh for that customer after the change commits, and SHALL treat the enqueue as best-effort so a queue failure never fails the originating operation.
6. THE Loyalty_Service SHALL enable point-in-time recovery and automated backups on the PostgreSQL database with write-ahead-log retention of at least 7 days.
7. WHILE a reconciliation process runs — at least once per day while the service is running, caught up on the next start after any missed window, and on admin demand — IF cached balances or tiers in the Metafield_Cache differ from the values computed from the Ledger, THEN THE Loyalty_Service SHALL recompute the affected balances and tiers from the Ledger and overwrite the diverging cached values so that the Metafield_Cache matches the Ledger. *(A15; the per-change refresh of criterion 5a corrects drift at source, so this sweep is the backstop)*
8. WHEN a webhook handler executes, THE Loyalty_Service SHALL complete verification, deduplication, ledger write, and enqueue within 50 milliseconds at the 95th percentile and within 100 milliseconds at the 99th percentile, measured at a sustained load of up to 100 concurrent webhook requests.

### Requirement 14: Data-Safe Migration

**User Story:** As the platform owner, I want existing loyalty data migrated without loss or risk, so that current members' balances are preserved and any step can be undone.

#### Acceptance Criteria

1. BEFORE any migration change, THE Loyalty_Service SHALL export all 39 customers' `loyalty.*` metafields to a versioned backup file and SHALL confirm that a complete exported record exists for every one of the 39 customers before proceeding.
2. IF the export does not produce a complete record for all 39 customers, THEN THE Loyalty_Service SHALL abort before making any change, retain the original metafields unchanged, and return an error indication.
3. WHEN validating the export, THE Loyalty_Service SHALL verify that each of the 8 Enrolled_Customer balances exactly equals the integer value of `50 + spend×1`, and IF any balance does not match, THEN THE Loyalty_Service SHALL halt the migration and record the mismatching customer for review.
4. WHEN backfilling the Ledger, THE Loyalty_Service SHALL create for each of the 8 Enrolled_Customers exactly one `migration` Ledger entry equal to their current points balance and exactly one matching non-expiring Point_Lot of the same value, and SHALL recompute tier from lifetime spend.
5. WHERE a customer is a Non_Enrolled_Customer, THE Loyalty_Service SHALL enroll them lazily by creating their `customers` row on their first qualifying event rather than eagerly at migration. *(A3)*
6. WHEN backfill completes, THE Loyalty_Service SHALL assert that the sum of each Enrolled_Customer's Ledger exactly equals their exported balance, and IF any sum does not match, THEN THE Loyalty_Service SHALL abort the migration and retain no partial Ledger state, treating the backup file as authoritative for restore.
7. IF the backfill fails midway, THEN THE Loyalty_Service SHALL abort, retain no partial `migration` Ledger entry or Point_Lot, and preserve the backup file for restore.
8. THE Loyalty_Service SHALL NOT delete any Shopify metafield during migration.
9. WHERE a migration phase must be undone, THE Loyalty_Service SHALL support rollback by stopping the service and restoring metafields from the export so that every customer's metafields exactly equal their exported values, and for the cutover phase by re-pointing the theme's redemption call-to-action back to the prior `mailto:` snippet retained in version control.

### Requirement 15: Basic-Plan Constraint Compliance

**User Story:** As the platform owner, I want the platform to work within Shopify Basic plan limits, so that no unavailable Shopify feature is assumed.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL implement all points-earning, points-redemption, and notification automation within the external backend, and SHALL NOT invoke, depend on, or require Shopify Flow.
2. WHERE points are earned on an order, WHEN the order reaches a paid/fulfilled state, THE Loyalty_Service SHALL make the earned points balance visible through at least one post-purchase channel (customer dashboard, order-status page, or email) within 60 seconds of the state change, and SHALL NOT require any checkout-page customization.
3. WHERE review points are supported, THE Loyalty_Service SHALL accept review-points input only through an inbound event endpoint fed by webhooks emitted by a reviews app, and SHALL NOT accept review-points input from any other source.
4. IF an inbound review event is malformed, unauthenticated, or references a customer or order that does not exist, THEN THE Loyalty_Service SHALL reject the event without awarding points, and SHALL return an error response indicating the reason for rejection while leaving the existing points balance unchanged.
5. WHEN the Loyalty_Service persists loyalty data to Shopify metafields, THE Loyalty_Service SHALL perform the write exclusively from the backend via the Admin_API, and SHALL NOT rely on storefront Liquid for any metafield write.
6. IF an Admin_API metafield write fails, THEN THE Loyalty_Service SHALL retry the write up to 3 times, and IF all retries fail, THEN THE Loyalty_Service SHALL preserve the last known-good metafield value and record the failure for reconciliation.

### Requirement 16: Athoor Private Client Experience

> **MVP.** This requirement refines the existing Customer_Portal (Requirement 8) and does not contradict its WCAG 2.1 AA (8.7) or Core Web Vitals (8.8) criteria.

**User Story:** As a customer, I want the portal to feel like a private client relationship with a luxury fragrance house, so that managing my rewards feels bespoke rather than like a standard Shopify account page.

#### Acceptance Criteria

1. WHEN an authenticated customer opens the Customer_Portal and no prior portal visit is recorded for that customer, THE Customer_Portal SHALL present a first-visit luxury welcome experience.
2. WHEN an authenticated customer with a recorded prior portal visit opens the Customer_Portal, THE Customer_Portal SHALL present a returning-member experience that omits the first-visit welcome experience.
3. WHEN the Customer_Portal renders for an authenticated customer whose name is available, THE Customer_Portal SHALL display a personalised greeting that incorporates the customer's name and current Tier.
4. IF the customer's name is unavailable, THEN THE Customer_Portal SHALL display a Tier-aware greeting using a safe fallback that omits the name, and SHALL NOT display an empty value or a placeholder token in place of the name.
5. THE Customer_Portal SHALL present all portal sections in the Private_Client presentation — bespoke, editorial, boutique tone — and SHALL NOT present the default generic Shopify account UI.
6. WHERE the requesting device does not set `prefers-reduced-motion: reduce`, THE Customer_Portal SHALL apply premium transitions and animations that each complete within 300 milliseconds.
7. WHERE the requesting device sets `prefers-reduced-motion: reduce`, THE Customer_Portal SHALL disable non-essential animations and transitions.
8. THE Customer_Portal SHALL restrict animated transitions to compositor-friendly properties (transform and opacity) so that transitions introduce no layout shift.
9. THE Customer_Portal SHALL apply the existing LV-inspired luxury typography scale, colour palette, and generous spacing across all portal sections, with no visual regression from the current dashboard, consistent with Requirement 8 criterion 2.
10. THE Customer_Portal SHALL present the high-end fragrance-house aesthetic consistently across all portal sections at viewport widths from 320px to 1920px, covering mobile (320px–767px) and desktop (≥1024px), consistent with Requirement 8 criterion 3.
11. THE Customer_Portal SHALL conform to the WCAG 2.1 Level AA and Core Web Vitals thresholds defined in Requirement 8 criteria 7 and 8, and SHALL NOT introduce any regression against them.

### Requirement 17: Fragrance Relationship Profile

> **MVP** for purchased fragrances, favourites, wishlist, recently viewed, rules-based suggestions, and the journey timeline. **Future** for richer recommendation logic (criterion 7).

**User Story:** As a customer, I want a personalised fragrance profile, so that the portal reflects my relationship with Athoor's scents.

#### Acceptance Criteria

1. WHEN a customer opens their Fragrance_Profile, THE Loyalty_Service SHALL return the customer's purchased fragrances derived solely from that customer's paid Shopify orders.
2. WHEN a customer marks or unmarks a fragrance as a Favourite, THE Loyalty_Service SHALL persist the updated Favourite state for that customer and SHALL reflect the updated state on the next Fragrance_Profile read.
3. THE Loyalty_Service SHALL store Favourites, Wishlist, and recently viewed products as customer preferences owned by the Loyalty_Service, and SHALL NOT treat the Metafield_Cache as the source of truth for these preferences.
4. WHERE a customer has a device-local Wishlist stored under the existing `shopify-wishlist` `localStorage` key, WHEN that customer authenticates, THE Customer_Portal SHALL reconcile the device-local Wishlist with the account-level Wishlist by merging entries as a union, and SHALL retain the merged set as the account-level Wishlist (A14).
5. WHEN a customer views a product, THE Loyalty_Service SHALL record that product in the customer's recently viewed products, and SHALL exclude from the Fragrance_Profile any recently viewed entry older than the recently-viewed retention window defined in A10.
6. WHEN a customer opens their Fragrance_Profile, THE Loyalty_Service SHALL return suggested fragrances computed from that customer's purchase and view history using rules-based recommendations (A11), and SHALL exclude from the suggestions any fragrance the customer has already purchased.
7. THE Loyalty_Service SHALL implement the suggestion logic behind a stable interface so that richer recommendation logic can replace the rules-based logic without changing the `/v1` Fragrance_Profile response contract (A11).
8. WHEN a customer opens their Fragrance_Journey_Timeline, THE Loyalty_Service SHALL return the customer's fragrance milestones — including first purchase, Favourites added, and Tier changes — ordered chronologically.
9. IF the customer has no purchased fragrances, Favourites, Wishlist entries, recently viewed products, or milestones, THEN THE Loyalty_Service SHALL return an empty result for each affected Fragrance_Profile category without returning an error.
10. WHEN the Fragrance_Profile is returned, THE Loyalty_Service SHALL source product and order data from Shopify and preference data (Favourites, Wishlist, recently viewed) from the Loyalty_Service, and SHALL return only the requesting customer's data.

### Requirement 18: VIP / Private Client Expansion (Royal VIP)

> **MVP** for the configurable, tier-gated entitlement/benefit framework (criteria 1, 2, 3, 7). **Future** roadmap for the specific Royal_VIP private-client perks (criteria 4, 5, 6), per A13. Expands the Royal_VIP perks referenced in Requirement 7 criterion 8.

**User Story:** As a Royal VIP member, I want exclusive private-client benefits, so that reaching the top tier feels genuinely exclusive.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL model tier-gated entitlements as configuration-driven Benefit definitions, each associating a Benefit with a minimum qualifying Tier, so that new Benefits can be added by configuration without database schema redesign.
2. WHEN a customer's account data is returned, THE Loyalty_Service SHALL include the set of Benefits for which the customer's current Tier qualifies.
3. WHERE a Benefit is configured with a minimum qualifying Tier, IF a customer's Tier is below that minimum, THEN THE Loyalty_Service SHALL NOT grant that Benefit to the customer.
4. THE Loyalty_Service SHALL support, as future roadmap Benefit types gated to the Royal_VIP Tier, private consultation booking, early access to launches, limited-edition release access, exclusive samples, dedicated personal customer service, and invitation-only experiences, and SHALL represent each as a configurable Benefit that can be added without schema redesign (A13).
5. WHERE the private consultation booking Benefit is enabled, WHEN a qualifying Royal_VIP member requests a consultation booking, THE Loyalty_Service SHALL record the booking request attributed to that member.
6. IF a customer whose Tier does not qualify attempts to use a Royal_VIP-gated Benefit, THEN THE Loyalty_Service SHALL deny the action, perform no state change, and return a response indicating the required Tier.
7. THE Loyalty_Service SHALL introduce new Benefit types additively under the `/v1` API consistent with Requirement 9 criterion 4, and SHALL NOT require a breaking `/v1` change to add a new Benefit type.

### Requirement 19: Future Mobile App Preparation

> **Future** for the delivered app features (push notifications, app-exclusive rewards, digital membership card/QR, wallet passes). **MVP** requirement is that the `/v1` API and ledger/entitlement model do **not preclude** them and remain additive-only, per Requirement 9 criterion 4.

**User Story:** As the platform owner, I want the backend ready for a future native app, so that launching an app requires no breaking change to the loyalty service.

#### Acceptance Criteria

1. THE Loyalty_Service `/v1` API and data model SHALL support registering and de-registering Device_Tokens for push notifications as additive changes, without altering any existing web request or response contract.
2. THE Loyalty_Service SHALL model notification events so that they can be issued to registered Device_Tokens, without requiring a web client to consume them.
3. THE Loyalty_Service SHALL attribute rewards and entitlements to an originating Channel, so that a reward can be defined as app-exclusive and granted only for the `app` Channel.
4. WHERE a reward is configured as app-exclusive, IF the originating Channel is not `app`, THEN THE Loyalty_Service SHALL NOT grant that reward.
5. THE Loyalty_Service SHALL expose a verifiable member identifier suitable for a Digital_Membership_Card and QR-based membership identification, such that a presented identifier can be verified as belonging to a member without exposing any other customer's data.
6. THE Loyalty_Service SHALL make the member identifier and Tier data required for a mobile wallet pass retrievable via the `/v1` API, and SHALL NOT preclude issuing a mobile wallet pass.
7. THE Loyalty_Service SHALL introduce all mobile-supporting capabilities as additive `/v1` changes consistent with Requirement 9 criterion 4, and SHALL NOT remove or rename any existing `/v1` endpoint or field to add them.

### Requirement 20: Admin Analytics

> **MVP.** Admin-authenticated analytics derived from the immutable Ledger and Shopify order data. Computation cadence per A12.

**User Story:** As an Athoor staff member, I want loyalty analytics, so that I can understand and improve program performance.

#### Acceptance Criteria

1. IF a user requests Admin_Analytics without an authenticated Admin_User session holding an admin authorization role, THEN THE Loyalty_Service SHALL deny the request, return no analytics data, and return a response indicating that authorization is required, consistent with Requirement 10 criterion 1.
2. WHEN an Admin_User requests Admin_Analytics for a selectable date range, THE Loyalty_Service SHALL compute and return customer lifetime value, repeat purchase rate, loyalty engagement (the percentage of customers enrolled and the percentage active within the range), the most-rewarded customers, redemption behaviour (redemption rate and reward-tier popularity), and Royal_VIP customer growth over the range.
3. THE Loyalty_Service SHALL derive all Admin_Analytics metrics solely from the immutable Ledger and Shopify order data, and SHALL NOT maintain a separate mutable source of truth for analytics.
4. IF the requested date range is invalid because its end date precedes its start date, THEN THE Loyalty_Service SHALL reject the request and return a response indicating the invalid date range, without returning analytics data.
5. WHEN an Admin_User requests Admin_Analytics without specifying a date range, THE Loyalty_Service SHALL apply a default date range and indicate the applied range in the response.
6. WHEN Admin_Analytics are returned, THE Loyalty_Service SHALL compute metrics from cached aggregates per A12, refreshing them first WHERE they are older than the freshness budget, and SHALL include, in the response, the timestamp at which the returned metrics were computed.
6a. IF refreshing the cached aggregates fails, THEN THE Loyalty_Service SHALL still return analytics computed from the existing aggregates together with their true computation timestamp, rather than failing the request.

### Requirement 21: International Expansion

> **MVP** is a single-market, GBP, config-ready posture (criteria 1, 3 single-market portion, 6). **Future** is multi-currency, multi-market rule sets, and additional languages (criteria 2, 4, 5, 7), per A8 and A9.

**User Story:** As the platform owner operating internationally, I want the platform to support multiple markets in future, so that international expansion requires no Ledger redesign.

#### Acceptance Criteria

1. THE Loyalty_Service SHALL define all earning thresholds, Tier thresholds, and reward costs against the Base_Currency (GBP, per A8), and SHALL denominate today's thresholds and rewards in GBP.
2. THE Loyalty_Service SHALL structure earning and reward configuration so that per-Market currency conversion can be added as a future extension without redesigning the Ledger.
3. THE Loyalty_Service SHALL operate a single Market at MVP (per A9) and SHALL represent Market as configuration so that additional Markets can be added without Ledger redesign.
4. THE Loyalty_Service SHALL structure reward and earning rule sets so that Market-specific rule sets can be added per Market without altering the Ledger schema.
5. THE Customer_Portal SHALL structure all user-facing copy for localization so that additional languages can be added without changes to portal logic.
6. WHERE only the Base_Currency Market is configured, THE Loyalty_Service SHALL apply the GBP rule set to all customers.
7. THE Loyalty_Service SHALL introduce multi-currency support, additional Markets, Market-specific rule sets, and additional languages as additive changes consistent with Requirement 9, and SHALL NOT require a breaking `/v1` change or a Ledger redesign to add them.
