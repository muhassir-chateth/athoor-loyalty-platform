/**
 * `athoor-portal-orders.js` — the Orders section bundle's entry point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASK 20.2 OWNS ITS BEHAVIOUR.
 * See `overview.ts` for why every section entry is a bare registration at this
 * stage. Orders' one request on boot, its cursor paging, its `502` degraded state
 * and its copy mapping are task 20.2, over the N1 contract task 8.1 provides.
 */
import { registerSection } from "./registration.js";

registerSection("orders", () => {
  // Task 20.2.
});
