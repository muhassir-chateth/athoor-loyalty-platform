/**
 * `athoor-portal-profile.js` — the Profile section bundle's entry point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASKS 25.2–25.4 OWN ITS BEHAVIOUR.
 * See `overview.ts` for why every section entry is a bare registration at this
 * stage. Identity and addresses are task 25.2, the Birthday panel is task 25.3
 * and form validation and error presentation are task 25.4.
 *
 * A GATE THIS SECTION SITS BEHIND. Every profile write depends on the Shopify
 * `write_customers` scope, whose grant is open question OQ-11 / decision D8 and
 * gates task 14 in full (tasks.md gate table). This entry point does not depend
 * on that outcome — registering a section is not a write — but the module task
 * 25.2 writes here does.
 */
import { registerSection } from "./registration.js";

registerSection("profile", () => {
  // Tasks 25.2–25.4.
});
