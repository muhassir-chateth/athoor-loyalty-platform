# 30.2 — driving the journey with Chrome: what worked, and the one thing that stops it

Kiro drove real Chrome over CDP against the owner's own Shopify session, on the owner's explicit
instruction. This records what was proven rather than assumed, because the conclusion is a stop.

## The harness works

Chrome over CDP with Node's built-in `WebSocket`, nothing added to `package.json`. Already used
successfully for the Meta-pixel runtime diagnosis and the 30.3 width pass (80 measurements).

Chrome was already running WITHOUT `--remote-debugging-port`, so it could not be attached to. To
avoid disrupting the owner's browser, `Profile 1` was copied to a mode-700 scratch directory and a
second headless instance was launched against the copy. **The copy was shredded immediately
afterwards.** No cookie value was ever read, printed or logged — only domains and cookie NAMES,
to establish which sessions existed.

## What the profile actually contains

| Session | Present? | Evidence |
|---|---|---|
| Shopify **admin** | yes, cookies carried | `admin.shopify.com` and `accounts.shopify.com -> _identity_session` cookies exist in Profile 1 |
| Storefront **customer** | **NO** | no `secure_customer_sig` cookie on `myathoorlondon.co.uk` in ANY of the ten profiles |

## What happened when driven

**Admin** — navigating to `admin.shopify.com/store/myathoorlondon` landed on the right URL with
**no login form**, so the session cookie is valid. But the title was `Just a moment...`: a
Cloudflare bot interstitial served to headless Chrome. Admin is reachable but challenged in
headless mode.

**Storefront** — `/account` redirected to
`https://shopify.com/authentication/95446139219/login`, title `Sign in - myathoorlondon`, with:

- `signedInCustomer: false`
- an **email field present**
- page text: *"Sign in or create an account — Continue with Google or Email"*

There is **no password field**. This is the Shopify-hosted passwordless flow: it takes an email
address and sends a one-time code to that mailbox.

## The single blocker, stated precisely

**A storefront customer session for customer `9395357876563`.**

It cannot be obtained programmatically:

- the login is passwordless — the credential is a **one-time code emailed to that customer's
  address**, and Kiro has no access to that mailbox
- **no Admin API scope grants customer sign-in.** Admin scopes govern the Admin API, a different
  axis entirely
- **Multipass** would mint a storefront session, but requires Shopify **Plus**; this store is
  **Basic**
- Requirement **26.10** forbids creating a production customer to work around it

## Why this blocks every remaining browser item, not just 30.2

All of them need the portal to actually RENDER, and `portal-chrome.liquid` renders it only when
`customer` is truthy:

| Task | Needs |
|---|---|
| 30.2 full journey | a signed-in customer |
| 30.3 remaining live-render clauses | a rendered portal |
| 30.5 Lighthouse per section | an authenticated render |
| 31.5 browser checks | the journey |

So they funnel into one credential, not four separate blockers.

## The minimal thing that unblocks all of it

The owner signs in **once** as customer `9395357876563` in Chrome — entering the emailed code —
and leaves that session in place. The cookie then exists in the profile, and Kiro can drive the
entire 13-step journey, capture network requests, console errors and `x-request-id` values, and
run Lighthouse per section, without further intervention.

One login. Not thirteen steps.
