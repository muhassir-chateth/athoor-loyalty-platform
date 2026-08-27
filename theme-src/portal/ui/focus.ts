/**
 * `ui/focus.ts` — explicit, minimal focus movement (spec task 18.4, design §20.2).
 *
 * Requirements 17.5, 17.7.
 *
 * ── FOUR MOVEMENTS, AND NO OTHERS ───────────────────────────────────────────
 * §20.2 names exactly four: to a sheet's heading on open, back to the invoking
 * control on close, to the first invalid field on a rejected submission, and to the
 * section heading when a section's content is replaced wholesale. This module
 * offers those four and nothing else, because "focus is never moved on a background
 * event" is only enforceable if there is no general-purpose `moveFocusTo`.
 *
 * ── APPENDED ROWS NEVER STEAL FOCUS ─────────────────────────────────────────
 * There is deliberately no function for "focus the new rows". §20.2 requires that
 * "load more" leaves focus on the control and announces the count instead — a
 * customer who presses a button expects to stay where they pressed it. The
 * announcement is `announce.polite`'s job.
 *
 * ── WHY HEADINGS GET `tabindex="-1"` AND NOT `tabindex="0"` ──────────────────
 * A heading is not interactive, so making it tab-reachable would add a stop to
 * every keyboard user's journey through the page for no action. `-1` makes it
 * programmatically focusable only, which is exactly what a focus TARGET needs. The
 * attribute is added at the moment of use and left in place: removing it after
 * focus lands causes some browsers to drop focus to `<body>`.
 *
 * SAFETY: DOM only. No network, no storage.
 */

/** Inputs that can hold an invalid state and receive focus. */
const FIELD_SELECTOR = "input, select, textarea";

/** Make a non-interactive element a programmatic focus target, then focus it. */
function focusElement(element: HTMLElement): void {
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
  }
  element.focus();
}

/**
 * Focus a sheet's heading on open.
 *
 * The heading rather than the dialog itself: focusing the dialog announces the
 * whole contents in some screen readers, and focusing the first control skips the
 * title, so the customer hears an input with no idea what it belongs to.
 */
export function toSheetHeading(dialog: HTMLElement): void {
  const heading = dialog.querySelector<HTMLElement>("h1, h2, h3, [data-portal-sheet-heading]");
  if (heading) {
    focusElement(heading);
    return;
  }
  focusElement(dialog);
}

/**
 * Return focus to the control that opened a sheet.
 *
 * Guarded on the element still being in the document: a sheet whose invoking
 * control was inside content that has since been replaced would otherwise focus a
 * detached node, which silently drops focus to `<body>` and loses the customer's
 * place entirely.
 */
export function restore(control: Element | null): void {
  if (!control) return;
  if (!(control instanceof HTMLElement)) return;
  if (!control.isConnected) return;
  control.focus();
}

/**
 * Focus the first invalid field on a rejected submission (Requirement 17.7).
 *
 * Keyed on `aria-invalid="true"` rather than on the browser's `:invalid`
 * pseudo-class, because the portal's validation is server-side: a field the server
 * rejected is perfectly valid to the browser. Returns whether anything was found,
 * so a caller can fall back to the error summary when the rejection names no field.
 */
export function toFirstInvalid(form: HTMLElement): boolean {
  const fields = form.querySelectorAll<HTMLElement>(FIELD_SELECTOR);
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    if (field.getAttribute("aria-invalid") === "true") {
      field.focus();
      return true;
    }
  }
  return false;
}

/**
 * Focus a section's heading when its content has been replaced wholesale.
 *
 * The case this exists for is a retry that succeeds: the customer pressed a button
 * that has now been removed from the DOM along with the error state, so focus would
 * otherwise fall to `<body>` and the next Tab would start from the top of the page.
 */
export function toSectionHeading(root: HTMLElement): void {
  const heading = root.querySelector<HTMLElement>("h1, h2, h3, [data-portal-heading]");
  if (heading) focusElement(heading);
}
