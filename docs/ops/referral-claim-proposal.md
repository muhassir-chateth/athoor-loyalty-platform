# Referral claim surface — the missing half of the referral programme

Status: **proposal only. Nothing in this document is implemented.**
Raised by: task 34 (audit finding F3 follow-on).
Scope: `theme/` only. No service change is required — the endpoint already exists,
is wired, and is verified live.

## What is missing

A member can **share** a referral code but a friend has **no way to submit one**.

- `POST /v1/referral` exists, is registered on the signed App Proxy `/v1` scope,
  enforces idempotency, and awards the referrer +150 through the referral engine.
- `theme/` contains **no form, input, or JS call** that reaches it. Grep the theme
  for `POST` against `/v1/referral`: there are zero hits. `athoor-loyalty.js` now
  calls `GET /v1/referral` (task 34) to display the member's own code, and nothing
  else.
- Shopify's `customers/create` webhook payload carries no referral field, so the
  service cannot learn the attribution any other way.

## Why it matters

Referral attribution can never be initiated by a member. The consequences are
concrete, not theoretical:

- `referrals` rows can only appear from operator/backfill activity, so the +150
  signup reward (Req 2.9) effectively never fires from the storefront.
- The +250 first-purchase reward (Req 2.10) is downstream of a `referrals` row, so
  it cannot fire either.
- The dashboard advertises both rewards in "Ways to Earn"
  (`loyalty.earn.points_refer_signup`, `…refer_purchase`), so the storefront
  promises a programme a member cannot enter.

## Smallest implementation that closes it

One input, one button, one fetch. No new endpoint, no new service code, no new
security model.

### Markup — inside the existing `.referral-section` of `loyalty-dashboard.liquid`

Render it only for a member who has not already been referred, so an already
attributed member is not invited to fail:

```liquid
{%- comment -%} Only offer the claim to a member with no referrer yet. {%- endcomment -%}
<form class="referral-claim" data-loyalty="referral-claim" novalidate>
  <label for="referral-claim-input">{{ 'loyalty.referral.claim_label' | t }}</label>
  <input
    id="referral-claim-input"
    name="referralCode"
    type="text"
    inputmode="latin"
    autocomplete="off"
    maxlength="64"
    required
    data-loyalty="referral-claim-input"
    aria-describedby="referral-claim-status"
  >
  <button type="submit" data-loyalty="referral-claim-submit">
    {{ 'loyalty.referral.claim_submit' | t }}
  </button>
  <p id="referral-claim-status" data-loyalty="referral-claim-status" role="status" aria-live="polite"></p>
</form>
```

All five strings (`claim_label`, `claim_submit`, plus the messages below) go in the
locale files. No hardcoded English.

### JS — in `athoor-loyalty.js`, reusing the existing `postJson` helper

`postJson` already sets `Accept`, `credentials: 'same-origin'`, the
`AbortController` timeout, and — critically — a fresh **`Idempotency-Key`** header,
which the `/v1` scope **requires** on state-changing requests. It currently sends
no body, so the only change needed is an optional body argument:

```js
// postJson(url, body) — add: if (body) { opts.body = JSON.stringify(body);
//   opts.headers['Content-Type'] = 'application/json'; }
form.addEventListener('submit', function (e) {
  e.preventDefault();
  var code = input.value.trim();
  if (!code) return;
  submit.disabled = true;
  postJson(proxyBase + '/v1/referral', { referralCode: code })
    .then(function (data) { showClaimResult(data && data.status); })
    .catch(function (err) { showClaimError(err); })   // err carries the HTTP status
    .then(function () { submit.disabled = false; });
});
```

One key per submission, not per page load: a retried submission of the same code
must replay the stored response rather than double-award.

### States, mapped to the endpoint's REAL responses

| Response | Meaning for the member | Copy key |
| --- | --- | --- |
| `200 {"status":"rewarded"}` | Accepted. Their friend has been credited. | `claim_success` |
| `200 {"status":"already_rewarded"}` | Already applied — treat as success, not an error. | `claim_already` |
| `409 {"error":"self_referral_rejected"}` | Cannot use your own code. | `claim_self` |
| `404 {"error":"unknown_referral_code"}` | Code not recognised — check it and retry. | `claim_unknown` |
| `409 {"error":"referral_not_eligible"}` | Codes cannot be applied after a purchase. | `claim_ineligible` |
| `400 {"error":"invalid_request"}` | 1–64 characters required. | `claim_invalid` |
| timeout / network / anything else | Neutral "could not submit, try again". | `claim_failed` |

Note `postJson` currently rejects on any non-OK status without exposing the body,
so distinguishing 404 from 409 needs the rejection to carry the status (and ideally
the parsed `error`). That is a small change to the shared helper, not a new one.

Announce every result through the existing `role="status" aria-live="polite"`
element so it is heard, and keep the input's value on failure so a typo can be
corrected.

### What it does NOT need

- No new endpoint, no new route, no service deploy.
- No customer id, email, or token in the request — the App Proxy signature carries
  the identity, and the handler takes it from `logged_in_customer_id` only.
- No client-side validation of the code format beyond non-empty and ≤64 chars. The
  server owns eligibility, self-referral and unknown-code decisions; duplicating
  the rules in the theme is how they drift.
- No optimistic balance update. The claimant's own balance does not change — the
  **referrer** is credited — so there is nothing to update on the claimant's
  dashboard.
- No polling, no retry loop. One submission per press.
- No signup-page integration and no `?ref=` URL capture. Worth having later, but it
  needs storage across the account-creation redirect and is strictly bigger than
  the smallest fix.

## Verification note

Any implementation of the above is **not** verifiable in a browser today: the
staging storefront returns `302 → /password` and the staging Admin token lacks
`read_themes`, so no rendered page can be reached and no theme can be pushed. The
endpoint side, by contrast, is testable directly against the App Proxy with a
signed request.
