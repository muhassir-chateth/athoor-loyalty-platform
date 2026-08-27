/**
 * `athoor-portal-order-detail.js` — the Order detail section bundle's entry
 * point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASK 20.3 OWNS ITS BEHAVIOUR.
 * See `overview.ts` for why every section entry is a bare registration at this
 * stage. The line items, fulfilments, addresses and Buy Again wiring are tasks
 * 20.3 and 20.4, over the N2/N3 contracts tasks 8.2 and 8.3 provide.
 *
 * NOTE ON THE FILE NAME. Design §16.2 names this module `orderDetail.ts`, and
 * the built asset is `athoor-portal-order-detail.js` — kebab-case, matching every
 * other file in `theme/assets/`. The build script performs that one
 * transformation and the smoke test asserts it, so the difference is deliberate
 * rather than a slip.
 */
import { registerSection } from "./registration.js";

registerSection("order-detail", () => {
  // Task 20.3.
});
