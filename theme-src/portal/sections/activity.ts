/**
 * `athoor-portal-activity.js` — the Rewards Activity section bundle's entry
 * point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASK 22.4 OWNS ITS BEHAVIOUR.
 * See `overview.ts` for why every section entry is a bare registration at this
 * stage. The entry list, its load-more control and the `entry_type` × `reason`
 * language mapping are task 22.4, over the copy map task 18.6 provides.
 *
 * Activity is a sub-view of Rewards with its own URL, and therefore its own page
 * and its own bundle — which is why it is a section here and not part of
 * `rewards.ts`.
 */
import { registerSection } from "./registration.js";

registerSection("activity", () => {
  // Task 22.4.
});
