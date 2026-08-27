/**
 * `athoor-portal-rewards.js` — the Rewards section bundle's entry point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASK 22.2 OWNS ITS BEHAVIOUR.
 * See `overview.ts` for why every section entry is a bare registration at this
 * stage. The reward list, the redemption flow and the balance-cache invalidation
 * that follows a successful redemption are tasks 22.2 and 22.3, over the
 * `/v1/balance` additions task 10.1 provides.
 */
import { registerSection } from "./registration.js";

registerSection("rewards", () => {
  // Task 22.2.
});
