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

  // Kick off reads independently: a failure of one never blocks the others, and
  // any failure just leaves that section's server-rendered values in place.
  loadBalance();
  loadHistory();
  loadReferral();
  initReferralClaim();
  markVisit();

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
