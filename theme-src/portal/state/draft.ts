/**
 * `state/draft.ts` — half-typed form input, in memory only (spec task 18.2,
 * design §16.3).
 *
 * Requirements 16.6, 16.7, 1.8.
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
 * Requirements 16.6 and 16.7 ask that unsent input is RETAINED when a section
 * goes offline or the session expires. That is a real obligation: a customer who
 * has typed an address and then hits an expired session must not lose it, because
 * losing it is how a customer stops trusting the account area.
 *
 * ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
 * It is not persistence. `localStorage` would survive a shared device, and
 * `sessionStorage` would survive a navigation — either puts customer-shaped data
 * (a name, an address, a birthday) into client storage, which Requirement 1.8 and
 * §5.1 rule out. So this module performs ZERO storage writes.
 *
 * The consequence is stated in §16.3 and accepted: a hard refresh loses a
 * half-typed form. That is precisely why the requirements speak of retaining input
 * across an offline or session-expired STATE — which happens without leaving the
 * page, and which this handles — rather than across a reload, which it does not.
 *
 * ── WHY VALUES ARE `string` ONLY ────────────────────────────────────────────
 * A draft is what is in the form controls, and a form control's value is a string.
 * Admitting arbitrary objects would invite a section to park a parsed DTO here and
 * turn a draft store into a second copy of server state — the "no second source of
 * truth" rule, broken from the client side.
 *
 * SAFETY: memory only, no storage, no network, no DOM.
 */

/** `scope` → field name → value. One entry per form, not per page. */
const drafts = new Map<string, Map<string, string>>();

/**
 * The fields held for one form, as a FRESH object.
 *
 * Fresh so a caller cannot mutate the store by holding its return value — the
 * difference between a store and a shared mutable bag.
 */
export function get(scope: string): Record<string, string> {
  const held = drafts.get(scope);
  const out: Record<string, string> = {};
  if (!held) return out;
  held.forEach((value, field) => {
    out[field] = value;
  });
  return out;
}

/**
 * Record one field's current value.
 *
 * An empty string is STORED rather than treated as a deletion: a customer who
 * clears a field has expressed something, and dropping the key would let a stale
 * earlier value be restored on top of a field they deliberately emptied.
 */
export function set(scope: string, field: string, value: string): void {
  let held = drafts.get(scope);
  if (!held) {
    held = new Map<string, string>();
    drafts.set(scope, held);
  }
  held.set(field, value);
}

/** Forget one form's input — after a successful submission, not before. */
export function clear(scope: string): void {
  drafts.delete(scope);
}

export function has(scope: string): boolean {
  const held = drafts.get(scope);
  return held !== undefined && held.size > 0;
}

/** Forget everything. For tests. */
export function clearAll(): void {
  drafts.clear();
}
