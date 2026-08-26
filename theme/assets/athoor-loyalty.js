/*
 * Athoor Loyalty Dashboard — progressive enhancement (spec task 6.7).
 *
 * Repoints the existing luxury dashboard's data source from customer metafields
 * to the Loyalty_Service /v1 API, reached via Shopify App Proxy at
 * /apps/loyalty/v1/*. Shopify signs the proxied request and injects the
 * logged-in customer identity server-side, so this client sends no credentials.
 *
 * DESIGN CONTRACT (Requirements 8.2, 8.4, 8.5; Migration M3 dashboard reads):
 *   - The section is fully rendered server-side from the Metafield_Cache before
 *     this script runs. That server render is the DEFAULT and the FALLBACK.
 *   - This script fetches /v1/balance, /v1/history and /v1/referral and writes the
 *     live values into the SAME markup (matched via data-loyalty-* hooks),
 *     reusing the existing CSS classes — so there is no visual regression
 *     (Req 8.2).
 *   - Every request has a hard timeout (default 3s). On timeout, network error,
 *     or a non-OK response, the fetch is abandoned and the already-rendered
 *     metafield values are kept untouched (Req 8.4).
 *   - It surfaces the live Spendable_Balance, available rewards (as enabled/
 *     disabled reward cards), any issued discount codes / redemption activity
 *     from history (Req 8.5), and the member's real referral code.
 *
 * It never mutates loyalty state: only GET requests are issued here. Redemption
 * remains the retained mailto: CTA until automated /v1/redeem code issuance is
 * cut over separately.
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-loyalty-dashboard]');
  if (!root || root.getAttribute('data-loyalty-customer') !== 'true') {
    return; // Not a logged-in dashboard render — nothing to enhance.
  }

  var config = readConfig(root);
  var proxyBase = normalizeBase(config.proxyBase || root.getAttribute('data-loyalty-proxy-base') || '/apps/loyalty');
  var timeoutMs = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 3000;
  var currency = config.currency || 'GBP';
  // Whether the server render had Metafield_Cache values to fall back on
  // (Req 8.6). When false and the API is also unavailable, we surface the
  // temporary-unavailable notice instead of leaving empty/placeholder data.
  var cacheAvailable = config.cacheAvailable === true;

  var money = buildMoneyFormatter(currency);

  // Localized copy (task 20.2, Req 21.5). All user-facing strings this script
  // writes into the DOM are sourced from the theme locale files, injected as a
  // JSON block (data-loyalty-strings) rendered via the Liquid `t` filter. Adding
  // a language is a translation-only change: no logic here changes. The English
  // defaults below are a safety net if the block is missing/malformed, so the
  // dashboard never regresses. JS-side placeholders use single braces.
  var STRINGS = readStrings(root);
  var DEFAULT_STRINGS = {
    tier_bronze: 'Bronze',
    tier_silver: 'Silver',
    tier_gold: 'Gold',
    tier_royal_vip: 'VIP Royal',
    member_badge: '{tier} Member',
    progress_next: '{tier} \u2014 {amount}',
    progress_aria: 'Progress to {tier} tier',
    progress_remaining: '{amount} more to reach {tier}',
    points_label: '{points} Points',
    entry_earned: 'Points earned',
    entry_spent: 'Points redeemed',
    entry_expired: 'Points expired',
    entry_default: 'Activity',
    // Referral claim (docs/ops/referral-claim-proposal.md). One key per REAL
    // response of POST /v1/referral, so the member is never shown a guess.
    claim_success: 'Referral code applied. Your friend has been credited.',
    claim_already: 'This referral code is already applied to your account.',
    claim_self: 'You cannot use your own referral code.',
    claim_unknown: 'That code was not recognised. Check it and try again.',
    claim_ineligible: 'A referral code cannot be applied after a purchase has been made.',
    claim_invalid: 'Enter a referral code of up to 64 characters.',
    claim_failed: 'We could not submit that just now. Please try again.'
  };

  var TIER_LABELS = {
    bronze: t('tier_bronze'),
    silver: t('tier_silver'),
    gold: t('tier_gold'),
    royal_vip: t('tier_royal_vip')
  };
  var TIER_CLASSES = { bronze: 'tier-bronze', silver: 'tier-silver', gold: 'tier-gold', royal_vip: 'tier-royal' };
  var TIER_BADGE_CLASSES = ['tier-bronze', 'tier-silver', 'tier-gold', 'tier-royal'];

  // ── Wishlist reconciliation state and constants ───────────────────────
  //
  // WHY THESE LIVE HERE AND NOT NEXT TO THE CODE THAT USES THEM. `var` is
  // hoisted, but its ASSIGNMENT only happens when execution reaches the
  // declaration. reconcileWishlistOnce() is called a few lines below, so
  // anything it reads during that call must already be assigned — a declaration
  // further down the file would be hoisted-but-undefined at call time. Every
  // declaration in this block is here for that one reason.

  /**
   * handle → in-flight or settled resolution promise. Coalesces duplicate
   * lookups for the same handle within a single page load, so the worker pool
   * below never issues two requests for one handle.
   *
   * @type {Object.<string, Promise<{outcome:'resolved',id:string}|{outcome:'missing'}|{outcome:'environmental'}>>}
   */
  var _handleCache = {};

  /** Longest handle we will accept; Shopify handles are far shorter. */
  var WISHLIST_HANDLE_MAX_LENGTH = 255;

  /**
   * MIRRORS `WISHLIST_RECONCILE_MAX_ITEMS` in
   * loyalty-service/src/profile/wishlistReconcileContract.ts — deliberately the
   * SAME IDENTIFIER on both sides of the boundary so `grep -r
   * WISHLIST_RECONCILE_MAX_ITEMS` finds the pair, and changing one without the
   * other is visible rather than silent.
   *
   * WHY THE CLIENT MUST ENFORCE THIS TOO. The server schema is
   * `.max(WISHLIST_RECONCILE_MAX_ITEMS)` on the whole array, and it rejects the
   * REQUEST, not the overflow: a member with 501 resolvable handles previously
   * had all 501 resolved, sent in one body, refused `400 invalid_request`, and
   * merged NOTHING — permanently, on every single load. Capping client-side
   * turns a total failure into an almost-complete merge.
   *
   * RESIDUAL, STATED HONESTLY: the slice is stable (first-occurrence order from
   * the normaliser), so a member above the cap merges the same first
   * WISHLIST_RECONCILE_MAX_ITEMS items every load and the tail beyond the cap
   * never merges. That is a bounded, documented shortfall of (n - cap) items
   * instead of losing all n. Rotating the window would merge the tail
   * eventually but makes each load's payload non-deterministic; that trade is
   * the owner's to make, not this fix's.
   */
  var WISHLIST_RECONCILE_MAX_ITEMS = 500;

  /**
   * How many `/products/{handle}.js` lookups may be in flight at once.
   *
   * Unbounded `Promise.all(handles.map(...))` opened one request PER HANDLE, so
   * a 40-item wishlist fired 40 simultaneous storefront requests while the
   * dashboard was still painting — each with its own 3s abort timer, all
   * competing with /v1/balance, /v1/history, /v1/referral, /v1/profile/visit and
   * the page's own images for the same connection budget. That is an LCP
   * problem, not an untidiness problem.
   *
   * 5 is chosen to sit just under the ~6-connections-per-host ceiling browsers
   * apply to HTTP/1.1, leaving one slot for the dashboard's own reads. On
   * HTTP/2, where there is no such ceiling, it still bounds how much bandwidth
   * reconciliation can take from the paint.
   */
  var WISHLIST_RESOLUTION_CONCURRENCY = 5;

  /**
   * The reconciliation diagnostic taxonomy. Stable identifiers only — see
   * reportWishlistDiag below for the privacy rules that govern their payloads.
   */
  var WISHLIST_DIAG = {
    LOCAL_MALFORMED: 'wishlist_local_malformed',
    LOCAL_TRUNCATED: 'wishlist_local_truncated',
    RESOLUTION_INCOMPLETE: 'wishlist_resolution_incomplete',
    RESOLUTION_FAILED: 'wishlist_resolution_failed',
    AUTH_FAILED: 'wishlist_auth_failed',
    VALIDATION_REJECTED: 'wishlist_validation_rejected',
    API_FAILED: 'wishlist_reconcile_api_failed',
    NETWORK_FAILED: 'wishlist_network_failed'
  };

  // Kick off reads independently: a failure of one never blocks the others, and
  // any failure just leaves that section's server-rendered values in place.
  loadBalance();
  loadHistory();
  loadReferral();
  initReferralClaim();
  markVisit();
  reconcileWishlistOnce(); // task 43 — translate device-local handles → IDs, then sync

  /* --------------------------------------------------------------------- */

  // ── Wishlist handle resolution + reconciliation (task 43) ──────────────
  //
  // The device-local `shopify-wishlist` localStorage entry stores product
  // HANDLES (e.g. "athoor-oud").  POST /v1/profile/wishlist/reconcile expects
  // numeric product ids (BIGINT column), so plain handles produce 400.
  //
  // Resolution is done client-side via GET /products/{handle}.js.  Observed
  // storefront responses (docs/ops/wishlist-handle-resolution-evidence.md):
  //
  //   resolved     — 200, text/javascript, JSON body with numeric `id`, no redirect
  //   missing      — 404, no redirect, empty body (archived/draft === nonexistent)
  //   environmental— redirected (password gate), HTML body, 5xx/429, timeout, etc.
  //
  // NEVER PRUNE localStorage.  Unresolved handles stay byte-identically in
  // storage and are simply excluded from the reconcile payload.  The cost is a
  // repeat lookup next session; the alternative is irreversible loss of member
  // data on ambiguous evidence (archived ≡ 404, not deletion).
  //
  // In-memory cache + in-flight coalescing prevent duplicate requests for the
  // same handle within a single page load.

  /**
   * Classifies a single handle fetch into one of three outcomes.
   * Uses `redirect: "follow"` so the password gate arrives as a 200 with
   * `response.redirected === true`.
   *
   * @param {string} handle
   * @returns {Promise<{outcome:'resolved',id:string}|{outcome:'missing'}|{outcome:'environmental'}>}
   */
  function resolveHandle(handle) {
    if (_handleCache[handle]) return _handleCache[handle];

    var p = _doResolveHandle(handle);
    _handleCache[handle] = p;
    return p;
  }

  function _doResolveHandle(handle) {
    if (typeof window.fetch !== 'function') {
      return Promise.resolve({ outcome: 'environmental' });
    }

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, timeoutMs)
      : null;

    var opts = {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: { Accept: 'application/javascript, application/json, */*' }
    };
    if (controller) opts.signal = controller.signal;

    // The abort timer is cleared ONLY once the outcome is fully settled, which
    // includes reading the body — see clearAfterSettled below. Clearing it as
    // soon as the response headers arrived (what this used to do) left a 200
    // whose body then stalled with no timeout at all, which is precisely the
    // case the timer exists for.
    function clearAfterSettled(outcome) {
      if (timer) clearTimeout(timer);
      return outcome;
    }

    return window.fetch('/products/' + encodeURIComponent(handle) + '.js', opts).then(
      function (res) {
        // Password gate: redirected to /password — environmental, not missing.
        if (res.redirected && /\/password(\?.*)?$/.test(res.url)) {
          return { outcome: 'environmental' };
        }

        // Any other redirect is also environmental (unexpected proxy, etc.).
        if (res.redirected) {
          return { outcome: 'environmental' };
        }

        // Genuine 404: no redirect, confirmed missing/archived/draft.
        if (res.status === 404) {
          return { outcome: 'missing' };
        }

        // Transient or server error: environmental, do not prune.
        if (res.status >= 400) {
          return { outcome: 'environmental' };
        }

        // 200: try to parse JSON and extract numeric `id`.
        var ct = res.headers && res.headers.get ? res.headers.get('content-type') : '';
        // text/javascript is the observed content-type for /products/{handle}.js
        if (ct && ct.indexOf('text/html') !== -1) {
          // Soft-404 or password page that didn't set redirected flag.
          return { outcome: 'environmental' };
        }

        return res.text().then(function (body) {
          if (!body || !body.trim()) {
            // Empty body on a 200 is unexpected — treat as environmental.
            return { outcome: 'environmental' };
          }
          try {
            var data = JSON.parse(body);
            // The ternary already collapses `undefined` to `null`, so `null` is
            // the single absent-value sentinel to test for below.
            var rawId = data && (data.id !== undefined ? data.id : null);
            // Must be a positive finite integer.
            if (rawId !== null) {
              var numId = Number(rawId);
              if (Number.isFinite(numId) && numId > 0 && Math.floor(numId) === numId) {
                return { outcome: 'resolved', id: String(numId) };
              }
            }
            // JSON body but no valid id — soft-404 or unexpected shape.
            return { outcome: 'environmental' };
          } catch (e) {
            return { outcome: 'environmental' };
          }
        }, function () {
          // Body read failed or was aborted mid-stream — environmental.
          return { outcome: 'environmental' };
        });
      },
      function () {
        // Timeout (AbortError), network failure — environmental.
        return { outcome: 'environmental' };
      }
    ).then(clearAfterSettled);
  }

  /**
   * Resolves `handles` through resolveHandle with at most `limit` requests in
   * flight, and returns the outcomes IN THE SAME ORDER as the input — a bounded
   * drop-in for the `Promise.all(handles.map(...))` this replaces.
   *
   * Two properties the callers and the committed suites depend on:
   *
   *   - ORDER OF RESULTS is input order, because each worker writes to
   *     `results[index]` rather than pushing as it finishes;
   *   - ORDER OF REQUESTS is also input order, because every worker draws from
   *     one shared ascending cursor, so handle N is always requested before
   *     handle N+1 regardless of which worker picks it up.
   *
   * Coalescing is untouched: workers call resolveHandle, so a repeated handle
   * still hits `_handleCache` instead of the network. resolveHandle never
   * rejects, but a rejection is absorbed as `environmental` anyway so one bad
   * lookup can never fail the whole batch (the old `Promise.all` would have).
   *
   * @param {string[]} handles
   * @param {number} limit Maximum concurrent lookups.
   * @returns {Promise<Array<{outcome:string,id?:string}>>}
   */
  function resolveHandlesPooled(handles, limit) {
    var results = new Array(handles.length);
    var cursor = 0;
    var workers = Math.min(limit, handles.length);
    if (workers <= 0) return Promise.resolve(results);

    function pump() {
      if (cursor >= handles.length) return null; // Queue drained.
      var index = cursor++; // Claim this slot before yielding.
      return resolveHandle(handles[index]).then(
        function (outcome) {
          results[index] = outcome;
          return pump();
        },
        function () {
          results[index] = { outcome: 'environmental' };
          return pump();
        }
      );
    }

    var running = [];
    for (var i = 0; i < workers; i++) running.push(pump());
    return Promise.all(running).then(function () { return results; });
  }

  // ── Device-local wishlist storage format (defect W1) ───────────────────
  //
  // W1 was that this function called JSON.parse on `shopify-wishlist`. EVERY
  // production writer stores a COMMA-DELIMITED string of handles:
  //   assets/dt_wishlist.js `setWishlist`      → array.join(',')
  //   templates/page.wishlist.liquid           → same
  //   snippets/athoor-wishlist-drawer.liquid   → same
  // so JSON.parse threw on the very first real value, the catch returned, and
  // the reconcile request was NEVER ISSUED. `customer_wishlist` therefore
  // received nothing in production, while Req 7.1 makes it the single source of
  // truth.
  //
  // The fix is not "swap JSON.parse for split(',')" — a single hard-coded
  // format is what created the defect. This normaliser accepts every value the
  // key can legitimately hold and canonicalises it, and it NEVER throws.

  /**
   * Canonicalises the raw `shopify-wishlist` value into an array of handles.
   *
   * Accepts, in order of precedence:
   *   - a JSON array of strings — retained for BACKWARD COMPATIBILITY only (see
   *     the note below on whether we genuinely need it);
   *   - a comma-delimited string of handles — what all three production writers
   *     actually store;
   *   - `null` / `undefined` / `''` / whitespace-only → `[]`;
   *   - anything else, including malformed JSON-like input such as `'[oops'`,
   *     a JSON object, or a JSON array of non-strings → best-effort, never a throw.
   *
   * Guarantees: trimmed entries, no empty entries, DEDUPLICATED, and a stable
   * deterministic order (first occurrence wins). Order matters because the
   * reconcile payload and the resolution requests are asserted in tests.
   *
   * DO WE GENUINELY NEED THE JSON BRANCH? Not for any writer that exists today —
   * all three write CSV, so on the current codebase the JSON branch is dead for
   * production values. It is kept for two concrete reasons rather than caution:
   * (1) the previous version of THIS function wrote nothing but read JSON, so a
   * developer or QA session that hand-seeded a JSON array while debugging can
   * still have left one in a real browser's localStorage; (2) reconciliation is
   * add-only and one-shot per load, so accepting both costs one `charAt` test
   * and cannot corrupt anything, whereas rejecting a JSON array would silently
   * discard a member's saved items — the exact failure mode W1 already caused
   * once. It is cheap insurance against an unrecoverable loss, not speculation
   * about a future writer.
   *
   * @param {*} raw
   * @returns {string[]}
   */
  function normaliseDeviceWishlist(raw) {
    if (typeof raw !== 'string') return [];

    var trimmed = raw.trim();
    if (!trimmed) return [];

    /** @type {string[]} */
    var candidates = null;

    // Only attempt JSON when the value actually looks like a JSON array. A CSV
    // handle list never starts with '[', so this cannot misroute real data, and
    // a malformed '[oops' falls through to the CSV branch instead of throwing.
    if (trimmed.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) candidates = parsed;
      } catch (e) {
        candidates = null; // Malformed JSON — fall through, never throw.
      }
    }

    // The production format, and the fallback for anything unparseable.
    if (candidates === null) candidates = trimmed.split(',');

    var seen = {};
    var handles = [];
    for (var i = 0; i < candidates.length; i++) {
      var entry = candidates[i];
      // A JSON array may legitimately contain non-strings; skip them rather than
      // coercing `null` into the string "null" and requesting /products/null.js.
      if (typeof entry !== 'string' && typeof entry !== 'number') continue;
      var handle = String(entry).trim();
      if (!handle) continue; // Empty segment from ",,a" or a trailing comma.
      if (handle.length > WISHLIST_HANDLE_MAX_LENGTH) continue;
      if (Object.prototype.hasOwnProperty.call(seen, handle)) continue; // Deduplicate.
      seen[handle] = true;
      handles.push(handle);
    }
    return handles;
  }

  // ── Reconciliation diagnostics (privacy-safe) ──────────────────────────
  //
  // W2's second half was `.catch(noop)`: the 400 the server returned was
  // swallowed, so a permanently broken merge looked identical to a working one.
  // Failures are still SILENT FOR THE CUSTOMER — the dashboard degrades
  // gracefully and shows nothing about wishlist syncing — but they are no longer
  // invisible to us.
  //
  // Console only, no beacon (design §24.5). Stable identifiers and COUNTS only:
  // never a handle, a title, a product id, a code, a token, a signature, a query
  // string or a payload (design §24.3 never-log list). A handle is a customer's
  // saved-product signal and is treated as customer data.

  /**
   * Emits one diagnostic line. `counts` may carry only non-identifying integers.
   *
   * SEVERITY IS PART OF THE SIGNAL. `warn` is reserved for outcomes that are
   * genuinely abnormal or inconclusive and may need someone to look. Routine,
   * expected outcomes go to `debug`, which browsers hide behind the Verbose
   * level. Reporting an ordinary discontinued product at `warn` on every
   * customer page load is how the lines that DO matter get ignored.
   *
   * The privacy filter is applied identically at every level: stable machine
   * identifiers and finite numbers only — never a handle, title, product id or
   * raw storage value (design §24.3).
   *
   * @param {string} code One of WISHLIST_DIAG.
   * @param {Object.<string, number>} [counts]
   * @param {'warn'|'debug'} [level] Defaults to 'warn'.
   */
  function reportWishlistDiag(code, counts, level) {
    try {
      var line = { code: code, section: 'wishlist_reconcile' };
      if (counts) {
        for (var key in counts) {
          if (!Object.prototype.hasOwnProperty.call(counts, key)) continue;
          // Integers only — a stray string here is how PII leaks into logs.
          if (typeof counts[key] === 'number' && isFinite(counts[key])) {
            line[key] = counts[key];
          }
        }
      }
      if (!window.console) return;
      // Fall back to warn only if the requested level is genuinely unavailable,
      // so a diagnostic is never lost — just occasionally louder than intended.
      var method = level === 'debug' && typeof window.console.debug === 'function'
        ? 'debug'
        : 'warn';
      if (typeof window.console[method] === 'function') {
        window.console[method]('[athoor-loyalty]', line);
      }
    } catch (e) {
      // Diagnostics must never break the dashboard.
    }
  }

  /**
   * Classifies a rejected reconcile POST into the diagnostic taxonomy.
   * `postJson` attaches `status` on a non-OK response, and rejects with a bare
   * Error (no `status`) for a timeout / network failure.
   *
   * @param {*} err
   * @returns {string}
   */
  function classifyReconcileFailure(err) {
    var status = err && typeof err.status === 'number' ? err.status : 0;
    if (!status) return WISHLIST_DIAG.NETWORK_FAILED; // AbortError, TypeError, fetch unavailable.
    if (status === 400 || status === 422) return WISHLIST_DIAG.VALIDATION_REJECTED;
    if (status === 401 || status === 403) return WISHLIST_DIAG.AUTH_FAILED;
    return WISHLIST_DIAG.API_FAILED;
  }

  /**
   * Called once per authenticated dashboard load.
   *
   * 1. Reads `shopify-wishlist` from localStorage and normalises it (W1 fix).
   * 2. Resolves each handle via /products/{handle}.js, at most
   *    WISHLIST_RESOLUTION_CONCURRENCY requests in flight, so reconciliation
   *    cannot saturate the connection budget during dashboard paint.
   * 3. Sends the resolved numeric IDs as `{ deviceLocal }` — the contract the
   *    server actually accepts (W2 fix) — capped at
   *    WISHLIST_RECONCILE_MAX_ITEMS so the request cannot exceed the server's
   *    own array bound and be refused wholesale; see
   *    loyalty-service/src/profile/wishlistReconcileContract.ts.
   * 4. localStorage is NEVER mutated — byte-identical before and after.
   *
   * THIS IS design §8.4 RULE 3, NOT A DEVIATION FROM IT. Rule 3 specifies that
   * `localStorage['shopify-wishlist']` is never cleared — not on a partial merge,
   * and not on a fully-resolved `200`. Reconciliation is READ-ONLY with respect
   * to device storage: it does not clear, migrate, rewrite or normalise-in-place.
   * Nothing here is pending or deferred; preservation is the specified behaviour.
   *
   * WHY. The merge is add-only — a union that never deletes server-side — so
   * keeping the local list costs only a repeated handle lookup. Clearing it is
   * irreversible on that device and would cost the customer their saved items
   * outright. Preserving customer state is safer than destructive convergence.
   *
   * THE ACCEPTED COST, so it is not lost. An uncleared local list re-merges
   * removed items. A product the customer removes through
   * `PUT /v1/profile/wishlist/:productId {on:false}` is RE-ADDED on the next
   * reconcile, because the device-local list still names it. This function runs
   * once per PAGE LOAD, not once per session, so that resurrection recurs on
   * every dashboard load for as long as the handle remains in localStorage. It
   * is an accepted trade-off, not a solved problem. The real fix is an
   * explicit-removal tombstone — schema in task 6, the write path in task 9.1 —
   * and it is deliberately OUT OF SCOPE here. Do not "fix" this by clearing.
   *
   * §8.4 rule 4 ("never prune on ambiguity") is honoured in full, and under rule
   * 3 it now holds universally rather than conditionally: `missing` and
   * `environmental` handles are excluded from the payload and left in storage,
   * and there is no fully-resolved case to except.
   */
  function reconcileWishlistOnce() {
    var raw;
    try {
      raw = localStorage.getItem('shopify-wishlist');
    } catch (e) {
      return; // localStorage unavailable — nothing to do.
    }
    if (raw === null || raw === undefined) return; // Key absent — nothing to reconcile.

    /** @type {string[]} */
    var handles = normaliseDeviceWishlist(raw);

    if (!handles.length) {
      // Distinguish "empty list" (normal) from "there was something there and we
      // could not make sense of any of it" (a real signal that a writer changed
      // format). Counts only — never the value itself.
      // `raw` is necessarily a string here: localStorage.getItem returns
      // `string | null` and the null case already returned above.
      if (raw.trim()) {
        reportWishlistDiag(WISHLIST_DIAG.LOCAL_MALFORMED, { rawLength: raw.length });
      }
      return;
    }

    // Resolve through a bounded pool — NOT one request per handle — then fire a
    // single reconcile request.
    resolveHandlesPooled(handles, WISHLIST_RESOLUTION_CONCURRENCY)
      .then(function (results) {
        var resolvedIds = [];
        var missingCount = 0;
        var environmentalCount = 0;
        for (var i = 0; i < results.length; i++) {
          if (results[i].outcome === 'resolved') {
            resolvedIds.push(results[i].id);
          } else if (results[i].outcome === 'missing') {
            missingCount++;
          } else {
            environmentalCount++;
          }
        }

        // Any handle we could not translate is reported by COUNT — but the two
        // reasons are NOT equally interesting, and conflating them was actively
        // harmful.
        //
        //   environmental — the evidence was INCONCLUSIVE (password gate, 5xx,
        //     429, timeout, unreadable body). Something may be wrong with the
        //     storefront or the network, and the handles are excluded from the
        //     merge but kept in localStorage (§8.4 rule 4). Worth a `warn`.
        //
        //   missing — a confirmed 404. A discontinued, archived or draft product
        //     in a wishlist is the ORDINARY STEADY STATE of a long-lived list,
        //     not a fault. Warning about it on every customer page load buried
        //     the environmental signal in noise, which is the opposite of what
        //     the taxonomy is for. It is recorded, at `debug`.
        //
        // Both are still reported, with the same count fields, so nothing became
        // invisible — only quieter.
        if (environmentalCount) {
          reportWishlistDiag(WISHLIST_DIAG.RESOLUTION_FAILED, {
            requested: results.length,
            resolved: resolvedIds.length,
            missing: missingCount,
            environmental: environmentalCount
          });
        } else if (missingCount) {
          reportWishlistDiag(WISHLIST_DIAG.RESOLUTION_INCOMPLETE, {
            requested: results.length,
            resolved: resolvedIds.length,
            missing: missingCount,
            environmental: 0
          }, 'debug');
        }

        if (!resolvedIds.length) return; // Nothing resolved — skip the POST entirely.

        // Enforce the server's array bound CLIENT-SIDE. Over the cap the schema
        // refuses the whole request, so without this a member above the cap
        // merged nothing at all, on every load, forever. See
        // WISHLIST_RECONCILE_MAX_ITEMS for the residual tail behaviour.
        if (resolvedIds.length > WISHLIST_RECONCILE_MAX_ITEMS) {
          reportWishlistDiag(WISHLIST_DIAG.LOCAL_TRUNCATED, {
            resolved: resolvedIds.length,
            cap: WISHLIST_RECONCILE_MAX_ITEMS,
            dropped: resolvedIds.length - WISHLIST_RECONCILE_MAX_ITEMS
          });
          resolvedIds = resolvedIds.slice(0, WISHLIST_RECONCILE_MAX_ITEMS);
        }

        // EXACTLY ONE POST per authenticated page load, carrying the canonical
        // `deviceLocal` field. Duplicate handles were already collapsed by the
        // normaliser, and the service dedupes again on its side, so a retry is
        // idempotent and cannot create duplicate rows.
        return postJson(
          proxyBase + '/v1/profile/wishlist/reconcile',
          { deviceLocal: resolvedIds },
          'wl-reconcile'
        ).then(function () {
          // Success, and localStorage is STILL left exactly as it was. This is
          // the fully-resolved `200` that §8.4 rule 3 names explicitly — the one
          // path where clearing would look justified. It is not. See the rule 3
          // note on this function, including the re-merge cost it accepts.
          return undefined;
        }, function (err) {
          // Non-fatal for the customer, but no longer silent for us.
          reportWishlistDiag(classifyReconcileFailure(err), { sent: resolvedIds.length });
        });
      })
      .catch(function () {
        // Defensive: the resolution phase itself failed as a whole.
        reportWishlistDiag(WISHLIST_DIAG.NETWORK_FAILED);
      });
  }

  // Test-only surface. Does nothing unless a harness has already installed the
  // hook object on `window` BEFORE this script runs, so in production this is a
  // single property read with no observable effect. It exists so the wishlist
  // normaliser can be unit-tested directly against the SHIPPED implementation
  // rather than against a second copy that could drift from it — a second copy
  // of a parser is how W1 stayed invisible.
  if (window.__athoorLoyaltyTestHooks) {
    window.__athoorLoyaltyTestHooks.normaliseDeviceWishlist = normaliseDeviceWishlist;
    window.__athoorLoyaltyTestHooks.classifyReconcileFailure = classifyReconcileFailure;
    window.__athoorLoyaltyTestHooks.WISHLIST_DIAG = WISHLIST_DIAG;
  }

  /* --------------------------------------------------------------------- */

  function loadBalance() {
    fetchJson(proxyBase + '/v1/balance')
      .then(function (data) {
        if (data && typeof data === 'object') {
          applyBalance(data);
          hideErrorState(); // Live data arrived — ensure any notice is cleared.
        } else {
          handleBalanceUnavailable();
        }
      })
      .catch(handleBalanceUnavailable); // Timeout / network / non-OK response.
  }

  // Req 8.4: on a slow/errored API we keep the server-rendered Metafield_Cache
  // values already on screen. Req 8.6: only when there is ALSO no cache to fall
  // back on do we reveal the temporary-unavailable notice — and even then we
  // retain every already-rendered section without clearing it.
  function handleBalanceUnavailable() {
    if (!cacheAvailable) {
      showErrorState();
    }
  }

  function showErrorState() {
    var el = root.querySelector('[data-loyalty="error-state"]');
    if (el) el.hidden = false;
  }

  function hideErrorState() {
    var el = root.querySelector('[data-loyalty="error-state"]');
    if (el) el.hidden = true;
  }

  function loadHistory() {
    fetchJson(proxyBase + '/v1/history?pageSize=20')
      .then(function (data) {
        if (data && Array.isArray(data.entries)) {
          applyHistory(data.entries);
        }
      })
      .catch(noop); // Fallback: activity/codes stay hidden (no regression).
  }

  // Referral code (task 34, audit finding F3). /v1/referral is the SINGLE SOURCE
  // OF TRUTH for a member's code: the section previously rendered a metafield
  // that existed on no customer and, failing that, FABRICATED a code — so
  // members shared codes the service does not recognise. This fetch replaces the
  // server-rendered value (a real cached code, or a neutral placeholder) with the
  // live one, using the same AbortController timeout and the same silent-fallback
  // philosophy as the other reads: on timeout/error the server-rendered state is
  // left exactly as it is, and no invented value is ever written.
  //
  // The response also carries `referredSignups` / `referredFirstPurchases`. They
  // are deliberately NOT rendered: the referral section has no element for them,
  // and inventing UI here is out of scope (see docs/ops/referral-claim-proposal.md).
  function loadReferral() {
    fetchJson(proxyBase + '/v1/referral')
      .then(function (data) {
        if (!data || typeof data !== 'object') return;
        if (typeof data.referralCode === 'string') {
          var code = data.referralCode.trim();
          if (code) applyReferralCode(code);
        }
        // The claim form is the ONLY place `wasReferred` is used. Liquid cannot
        // know it (it is not in the Metafield_Cache), so the form is rendered
        // hidden and revealed here — and ONLY on an explicit `false`. Anything
        // else (true, missing, non-boolean, error, timeout) leaves it hidden,
        // so a member who already has a referrer is never invited to fail and
        // no referred-state is ever guessed.
        if (data.wasReferred === false) revealClaimForm();
      })
      .catch(noop); // Fallback: the server-rendered code/placeholder stays put.
  }

  // Writes a REAL code into the referral element and unlocks the copy control.
  // Only ever called with a non-empty code from the API, so the copy button can
  // never be enabled over a placeholder.
  function applyReferralCode(code) {
    var el = root.querySelector('[data-loyalty="referral-code"]');
    if (el) {
      el.textContent = code;
      el.removeAttribute('data-loyalty-code-pending');
    }
    var btn = root.querySelector('[data-loyalty="referral-copy"]');
    if (btn) {
      btn.removeAttribute('disabled');
      btn.removeAttribute('aria-disabled');
    }
  }

  /* -------------------------- referral claim --------------------------- */
  /*
   * The missing half of the referral programme (docs/ops/referral-claim-
   * proposal.md): a friend submits the code they were given, and
   * POST /v1/referral credits the REFERRER +150 through the existing engine.
   *
   * WHY THE FORM IS REVEALED BY JS AND NOT RENDERED VISIBLE BY LIQUID: the
   * offer only makes sense for a member who has no referrer yet, and Liquid
   * cannot know that — `wasReferred` lives only behind GET /v1/referral. So the
   * form is rendered HIDDEN server-side and revealed only on a confirmed
   * `wasReferred === false`.
   *
   * CONSEQUENCE, stated plainly: with JS unavailable the form stays hidden and
   * no claim is possible. That is the correct outcome rather than a regression —
   * the /v1 scope REQUIRES an `Idempotency-Key` header on this POST, which a
   * plain HTML form post cannot send, so a visible no-JS form could only ever
   * produce a rejected request.
   *
   * The SERVER owns every eligibility decision (self-referral, unknown code,
   * post-purchase ineligibility). Nothing here duplicates those rules; the only
   * client-side checks are "non-empty" and "≤64 chars", which mirror the
   * endpoint's own body schema.
   */

  // True while a submission is in flight, so a double-press cannot produce two
  // requests with two different Idempotency-Keys. The button is disabled too,
  // but a `submit` event can still be dispatched at a disabled button, so the
  // flag — not the disabled attribute — is what guarantees one request.
  var claimPending = false;
  // True once the claim can never succeed again (rewarded / already rewarded /
  // ineligible), so the form is closed permanently.
  var claimClosed = false;

  function initReferralClaim() {
    var form = root.querySelector('[data-loyalty="referral-claim"]');
    if (!form) return; // Older render without the claim markup — nothing to do.
    form.addEventListener('submit', onClaimSubmit);
  }

  function revealClaimForm() {
    var form = root.querySelector('[data-loyalty="referral-claim"]');
    if (form) form.hidden = false;
  }

  function onClaimSubmit(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (claimPending || claimClosed) return;

    var input = root.querySelector('[data-loyalty="referral-claim-input"]');
    if (!input) return;
    var code = String(input.value == null ? '' : input.value).trim();
    // Empty / whitespace-only: submit nothing at all. No request, no message —
    // there is no failure to report yet.
    if (!code) return;
    // The endpoint's own limit (1–64 chars). Reported locally instead of
    // spending a request we know the server will reject.
    if (code.length > 64) {
      announceClaim(t('claim_invalid'));
      return;
    }

    claimPending = true;
    setClaimSubmitDisabled(true);

    // A FRESH key per submission attempt: a retry after a genuine failure is a
    // new operation and must not replay the failed one. Two presses of the SAME
    // submission are prevented by claimPending above, so they can never send
    // two differently-keyed requests.
    postJson(proxyBase + '/v1/referral', { referralCode: code }, 'claim').then(
      function (data) {
        claimPending = false;
        handleClaimResult(data);
      },
      function (err) {
        claimPending = false;
        handleClaimError(err);
      }
    );
  }

  // 200 responses. `already_rewarded` is a SUCCESS, not an error: the claim is
  // applied, there is simply nothing further to do.
  function handleClaimResult(data) {
    var status = data && typeof data.status === 'string' ? data.status : '';
    if (status === 'rewarded') {
      announceClaim(t('claim_success'));
      closeClaim();
      return;
    }
    if (status === 'already_rewarded') {
      announceClaim(t('claim_already'));
      closeClaim();
      return;
    }
    // A 200 whose status we do not recognise: report neutrally and leave the
    // form usable. We never echo an unknown status back to the member.
    announceClaim(t('claim_failed'));
    setClaimSubmitDisabled(false);
  }

  // Non-OK responses, timeouts and network errors. `err.errorCode` is the
  // endpoint's own `error` field, attached by postJson.
  function handleClaimError(err) {
    var errorCode = err && typeof err.errorCode === 'string' ? err.errorCode : '';

    if (errorCode === 'referral_not_eligible') {
      // A paid purchase already exists on this account, so no code can ever be
      // applied. Closing the form is honest; leaving it usable is not.
      announceClaim(t('claim_ineligible'));
      closeClaim();
      return;
    }

    if (errorCode === 'referral_already_claimed') {
      // A code from a different member is already applied, and a customer gets
      // exactly one. No retry can succeed, so the form closes for the same
      // reason as the ineligible case. Distinct copy: this member DID use a
      // code, just not this one.
      announceClaim(t('claim_already_claimed'));
      closeClaim();
      return;
    }

    if (errorCode === 'self_referral_rejected') {
      announceClaim(t('claim_self'));
    } else if (errorCode === 'unknown_referral_code') {
      // The input value is deliberately left intact so a typo can be corrected.
      announceClaim(t('claim_unknown'));
    } else if (errorCode === 'invalid_request') {
      announceClaim(t('claim_invalid'));
    } else {
      // Timeout, network failure, or any status/body we cannot interpret.
      announceClaim(t('claim_failed'));
    }
    setClaimSubmitDisabled(false); // Recoverable — let them try again.
  }

  // Announced through the same role="status" aria-live="polite" pattern the
  // dashboard already uses, so the result is heard and not only seen.
  function announceClaim(message) {
    var el = root.querySelector('[data-loyalty="referral-claim-status"]');
    if (el) el.textContent = message;
  }

  function setClaimSubmitDisabled(disabled) {
    if (claimClosed) return; // A closed form stays closed.
    var btn = root.querySelector('[data-loyalty="referral-claim-submit"]');
    if (!btn) return;
    btn.disabled = !!disabled;
    if (disabled) {
      btn.setAttribute('aria-disabled', 'true');
    } else {
      btn.removeAttribute('aria-disabled');
    }
  }

  // Permanently done: nothing further can change the outcome.
  function closeClaim() {
    claimClosed = true;
    var input = root.querySelector('[data-loyalty="referral-claim-input"]');
    var btn = root.querySelector('[data-loyalty="referral-claim-submit"]');
    if (input) {
      input.disabled = true;
      input.setAttribute('aria-disabled', 'true');
    }
    if (btn) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
  }

  // First-visit vs returning-member (Req 16.1/16.2). POST /v1/profile/visit
  // records the visit and reports { firstVisit }. The welcome is hidden by
  // default (returning-member is the no-JS default that omits it), so we only
  // ever REVEAL it — and only on a confirmed first visit. On any error/timeout
  // the welcome simply stays hidden, so a slow API never regresses the view.
  function markVisit() {
    postJson(proxyBase + '/v1/profile/visit')
      .then(function (data) {
        if (data && data.firstVisit === true) {
          revealWelcome();
        }
      })
      .catch(noop);
  }

  function revealWelcome() {
    var welcome = root.querySelector('[data-loyalty="welcome"]');
    if (welcome) welcome.hidden = false;
  }

  /* ------------------------------ balance ------------------------------ */

  function applyBalance(b) {
    // Spendable balance (Req 8.5).
    if (isFiniteNumber(b.spendableBalance)) {
      setText('[data-loyalty="spendable-balance"]', String(Math.round(b.spendableBalance)));
      cacheBanner({ points: Math.round(b.spendableBalance), tier: b.tier });
      updateRewardCards(b.spendableBalance);
    }

    // Tier name + badge (Req 8.2 — reuse existing badge classes/labels).
    if (b.tier && TIER_LABELS[b.tier]) {
      var label = TIER_LABELS[b.tier];
      setText('[data-loyalty="tier-name"]', label);
      var badge = root.querySelector('[data-loyalty="tier-badge"]');
      if (badge) {
        badge.textContent = t('member_badge', { tier: label });
        setTierBadgeClass(badge, TIER_CLASSES[b.tier]);
      }
      // Keep the personalised greeting's Tier word in step with the live Tier
      // (Req 16.3/16.4). Works for both the name greeting and the name-less
      // fallback, since both wrap the Tier in data-loyalty="greeting-tier-word".
      setAllText('[data-loyalty="greeting-tier-word"]', label);
    }

    // Lifetime spend (Total Spent stat).
    if (isFiniteNumber(b.lifetimeSpendGBP)) {
      setText('[data-loyalty="lifetime-spend"]', money(b.lifetimeSpendGBP));
    }

    updateProgress(b);
  }

  function updateProgress(b) {
    var progress = root.querySelector('[data-loyalty="progress"]');
    var top = root.querySelector('[data-loyalty="progress-top"]');

    if (b.isTopTier || !b.nextTier) {
      // Highest tier — show the top-tier message, hide the progress bar.
      if (progress) progress.style.display = 'none';
      if (top) top.style.display = '';
      return;
    }

    if (progress) progress.style.display = '';
    if (top) top.style.display = 'none';

    var nextLabel = TIER_LABELS[b.nextTier] || b.nextTier;
    if (isFiniteNumber(b.nextTierThresholdGBP)) {
      setText('[data-loyalty="progress-next"]', t('progress_next', { tier: nextLabel, amount: money(b.nextTierThresholdGBP) }));
    }

    if (isFiniteNumber(b.progressToNextTierGBP)) {
      var remaining = Math.max(0, b.progressToNextTierGBP);
      setText('[data-loyalty="progress-remaining"]', t('progress_remaining', { amount: money(remaining), tier: nextLabel }));

      var fill = root.querySelector('[data-loyalty="progress-fill"]');
      if (fill && isFiniteNumber(b.nextTierThresholdGBP) && b.nextTierThresholdGBP > 0) {
        var achieved = b.nextTierThresholdGBP - remaining;
        var pct = clamp((achieved / b.nextTierThresholdGBP) * 100, 0, 100);
        fill.style.width = pct + '%';

        // Keep the progressbar's accessible value in step with the live fill
        // (Req 8.7 — screen readers announce the correct progress).
        var bar = root.querySelector('[data-loyalty="progress-bar"]');
        if (bar) {
          bar.setAttribute('aria-valuenow', String(Math.round(pct)));
          bar.setAttribute('aria-label', t('progress_aria', { tier: nextLabel }));
        }
      }
    }
  }

  function updateRewardCards(spendable) {
    var cards = root.querySelectorAll('[data-loyalty-reward]');
    for (var i = 0; i < cards.length; i++) {
      var cost = parseInt(cards[i].getAttribute('data-loyalty-cost'), 10);
      var btn = cards[i].querySelector('[data-loyalty="reward-btn"]');
      if (!btn || !isFiniteNumber(cost)) continue;
      if (spendable < cost) {
        btn.classList.add('disabled');
        // Keep the accessible/keyboard state in step with the visual state
        // (Req 8.7): a disabled reward is announced as disabled and removed
        // from the tab order.
        btn.setAttribute('aria-disabled', 'true');
        btn.setAttribute('tabindex', '-1');
      } else {
        btn.classList.remove('disabled');
        btn.removeAttribute('aria-disabled');
        btn.removeAttribute('tabindex');
      }
    }
  }

  /* ------------------------------ history ------------------------------ */

  function applyHistory(entries) {
    renderActivity(entries);
    renderCodes(entries);
  }

  function renderActivity(entries) {
    var section = root.querySelector('[data-loyalty="activity-section"]');
    var list = root.querySelector('[data-loyalty="activity-list"]');
    if (!section || !list) return;
    if (!entries.length) return; // Nothing to show — keep hidden (no regression).

    var frag = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var row = document.createElement('div');
      row.className = 'earn-item';

      var action = document.createElement('span');
      action.className = 'earn-action';
      action.textContent = describeEntry(e);

      var pts = document.createElement('span');
      pts.className = 'earn-points';
      pts.textContent = formatPoints(e.points);

      row.appendChild(action);
      row.appendChild(pts);
      frag.appendChild(row);
    }
    list.textContent = '';
    list.appendChild(frag);
    section.hidden = false;
  }

  function renderCodes(entries) {
    var section = root.querySelector('[data-loyalty="codes-section"]');
    var list = root.querySelector('[data-loyalty="codes-list"]');
    if (!section || !list) return;

    // Issued discount codes surface as `spent` redemption entries in history
    // (Req 8.5). Extract any code-like token from the reason string.
    var codes = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.type !== 'spent') continue;
      var code = extractCode(e.reason);
      if (code) {
        codes.push({ code: code, reason: e.reason, date: e.date });
      }
    }
    if (!codes.length) return; // Keep hidden when there are no codes.

    var frag = document.createDocumentFragment();
    for (var j = 0; j < codes.length; j++) {
      var chip = document.createElement('div');
      chip.className = 'loyalty-code';
      var codeEl = document.createElement('span');
      codeEl.className = 'loyalty-code-value';
      codeEl.textContent = codes[j].code;
      chip.appendChild(codeEl);
      frag.appendChild(chip);
    }
    list.textContent = '';
    list.appendChild(frag);
    section.hidden = false;
  }

  function describeEntry(e) {
    if (e.reason) return e.reason;
    if (e.type === 'earned') return t('entry_earned');
    if (e.type === 'spent') return t('entry_spent');
    if (e.type === 'expired') return t('entry_expired');
    return t('entry_default');
  }

  function formatPoints(points) {
    if (!isFiniteNumber(points)) return '';
    var n = Math.round(points);
    // The +/- sign is a numeric indicator; the "{points} Points" wording is
    // localized via t('points_label'). For negative n the sign is already part
    // of the number, so the output matches the previous behaviour exactly.
    return (n > 0 ? '+' : '') + t('points_label', { points: n });
  }

  // A discount code token: uppercase letters/digits/dashes, at least 4 chars.
  function extractCode(reason) {
    if (!reason || typeof reason !== 'string') return null;
    var m = reason.match(/\b[A-Z0-9][A-Z0-9-]{3,}\b/);
    return m ? m[0] : null;
  }

  /* ------------------------------ helpers ------------------------------ */

  function fetchJson(url) {
    // Guard against environments without fetch/AbortController — fall back.
    if (typeof window.fetch !== 'function') {
      return Promise.reject(new Error('fetch unavailable'));
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, timeoutMs)
      : null;

    var opts = {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (controller) opts.signal = controller.signal;

    return window.fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  // POST helper for the state-changing /v1 calls. Mirrors fetchJson's hard
  // timeout and silent-fallback behaviour. Sends a fresh Idempotency-Key
  // (required by the /v1 state-changing gate) with a caller-supplied prefix.
  //
  // `body` is OPTIONAL. Omitted (the /v1/profile/visit call) the request is
  // byte-for-byte what it always was: no body and no Content-Type. Supplied, it
  // is JSON-encoded and Content-Type: application/json is set.
  //
  // On a non-OK response the rejection carries `status` and, when the body is
  // readable JSON with an `error` field, `errorCode` — without them a caller
  // cannot tell 404 unknown_referral_code from 409 self_referral_rejected. The
  // message stays 'HTTP <status>' so existing callers see no change.
  function postJson(url, body, keyPrefix) {
    if (typeof window.fetch !== 'function') {
      return Promise.reject(new Error('fetch unavailable'));
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, timeoutMs)
      : null;

    var opts = {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Idempotency-Key': idempotencyKey(keyPrefix)
      }
    };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (controller) opts.signal = controller.signal;

    return window.fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) return rejectWithHttpError(res);
      return res.json();
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  // Builds the rejection for a non-OK response, attaching the HTTP status and
  // the endpoint's `error` code when they can be read. Defensive throughout: an
  // empty, non-JSON or unreadable error body still rejects — with the status
  // only — so a caller never hangs and never sees a resolved promise.
  function rejectWithHttpError(res) {
    var err = new Error('HTTP ' + res.status);
    err.status = res.status;

    var parsed;
    try {
      parsed = typeof res.json === 'function' ? res.json() : null;
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed.then !== 'function') {
      return Promise.reject(err);
    }
    return parsed.then(function (data) {
      if (data && typeof data.error === 'string') err.errorCode = data.error;
      throw err;
    }, function () {
      throw err; // Body was not JSON — the status alone is what we know.
    });
  }

  // A 1–128 char idempotency key, prefixed by the operation so keys from
  // different operations can never collide. Prefers crypto.randomUUID, with a
  // safe timestamp+random fallback for older browsers.
  function idempotencyKey(prefix) {
    var p = prefix || 'visit';
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return p + '-' + window.crypto.randomUUID();
      }
    } catch (e) { /* fall through */ }
    return p + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function readConfig(el) {
    var node = el.querySelector('[data-loyalty-config]');
    if (!node) return {};
    try {
      return JSON.parse(node.textContent) || {};
    } catch (e) {
      return {};
    }
  }

  // Localized copy (task 20.2, Req 21.5). Reads the JSON block the section
  // renders via the Liquid `t` filter (data-loyalty-strings). Mirrors readConfig:
  // returns {} when the block is missing or malformed, so the DEFAULT_STRINGS
  // safety net takes over and the dashboard never regresses.
  function readStrings(el) {
    var node = el.querySelector('[data-loyalty-strings]');
    if (!node) return {};
    try {
      return JSON.parse(node.textContent) || {};
    } catch (e) {
      return {};
    }
  }

  // Resolve a user-facing string by key, preferring the localized value from the
  // strings block, then the English default, then the raw key as a last resort.
  // Interpolates single-brace tokens ({tier}, {amount}, {points}) from params so
  // adding a language is a translation-only change with no logic change here.
  function t(key, params) {
    var template = (STRINGS && STRINGS[key]) || DEFAULT_STRINGS[key] || key;
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  function normalizeBase(base) {
    return String(base).replace(/\/+$/, ''); // strip trailing slash(es)
  }

  function buildMoneyFormatter(cur) {
    try {
      var fmt = new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: cur,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return function (v) { return fmt.format(Number(v) || 0); };
    } catch (e) {
      // Fallback formatter if Intl/currency is unsupported.
      return function (v) { return '\u00A3' + (Number(v) || 0).toFixed(2); };
    }
  }

  function setText(selector, value) {
    var el = root.querySelector(selector);
    if (el) el.textContent = value;
  }

  function setAllText(selector, value) {
    var els = root.querySelectorAll(selector);
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = value;
    }
  }

  function setTierBadgeClass(badge, cls) {
    for (var i = 0; i < TIER_BADGE_CLASSES.length; i++) {
      badge.classList.remove(TIER_BADGE_CLASSES[i]);
    }
    if (cls) badge.classList.add(cls);
  }

  function cacheBanner(data) {
    // Share the live balance with the site-wide rewards banner without a second
    // network call. The banner reads this cache; it never fetches on its own.
    try {
      sessionStorage.setItem('athoorLoyalty', JSON.stringify(data));
    } catch (e) { /* storage unavailable — banner keeps its static text */ }
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function isFiniteNumber(n) { return typeof n === 'number' && isFinite(n); }
  function noop() {}
})();
