/**
 * `athoor-portal-referrals.js` — the Referrals section bundle's entry point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASK 23.2 OWNS ITS BEHAVIOUR.
 * See `overview.ts` for why every section entry is a bare registration at this
 * stage. The stage model, the share and copy controls and the referral-code
 * capture are task 23.2.
 *
 * A STANDING CONSTRAINT THAT ARRIVES WITH THAT TASK, NOT THIS ONE. Task 29.5's
 * referral literal gate forbids any numeric reward literal and the identifiers
 * `earn_referral`, `REFERRAL_SIGNUP_POINTS`, `REFERRAL_PURCHASE_POINTS`,
 * `signup_rewarded` and `purchase_rewarded` anywhere in this module's Liquid, CSS
 * or TypeScript, so that referral economics change without a theme change
 * (Property 11). Recorded here because this file is where that gate will first
 * have something to inspect.
 */
import { registerSection } from "./registration.js";

registerSection("referrals", () => {
  // Task 23.2.
});
