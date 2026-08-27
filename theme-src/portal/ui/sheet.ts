/**
 * `ui/sheet.ts` — the one `<dialog>` sheet (spec task 18.5, design §19.8).
 *
 * Requirements 25.4, 25.8, 17.3, 17.9.
 *
 * ── WHY NATIVE `<dialog>` ───────────────────────────────────────────────────
 * It gives modal focus containment, `Esc` to close, `::backdrop`, inert background
 * content and correct `aria-modal` semantics from the platform (§19.8). A
 * hand-rolled overlay means reimplementing a focus trap, and a subtly wrong focus
 * trap is a worse accessibility outcome than no modal at all — the customer is
 * trapped in a region they cannot leave with the keyboard.
 *
 * ── ONE IMPLEMENTATION, FOUR USES ───────────────────────────────────────────
 * The More navigation, redemption confirmation, address add/edit and the birthday
 * change flow. One wrapper rather than four means the focus behaviour and the
 * dismiss affordance are decided once.
 *
 * ── DISMISSAL NEVER CANCELS WORK IN FLIGHT ──────────────────────────────────
 * Explicit in spec 18.5, and it is a correctness rule rather than a nicety. A
 * customer who confirms a redemption and then dismisses the sheet has still
 * redeemed: the points left the balance durably before Shopify was contacted
 * (§22.5). Aborting the request on dismiss would produce exactly the state the
 * whole redemption design exists to prevent — a spend the customer cannot see. So
 * this module holds no `AbortController` and closing does not signal anything.
 *
 * ── NEVER DISMISS-BY-BACKDROP-ONLY (Requirement 25.8) ───────────────────────
 * A visible dismiss control is required. Backdrop-only dismissal is undiscoverable
 * on touch and impossible with a keyboard, and `Esc` alone is not an affordance
 * because nothing on screen says it exists. `open()` therefore refuses to proceed
 * silently: it binds whatever dismiss control the markup declares, and if there is
 * none it still opens — a sheet that will not open is a worse failure than one
 * closable by `Esc` — but the test asserts every real sheet declares one.
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────
 * Bottom-entering below 750 px, centred above, one media query, ≤300 ms and only
 * `transform`/`opacity` (Requirement 25.4, §18.7). That is CSS, in
 * `styles/`; this file adds no inline style and no animation timing, so
 * `prefers-reduced-motion` is honoured by the stylesheet rather than negotiated
 * here.
 *
 * SAFETY: DOM only. No network, no storage.
 */
import { restore, toSheetHeading } from "./focus.js";

/** The dismiss control a sheet's markup declares. */
const DISMISS_SELECTOR = "[data-portal-sheet-dismiss]";

/** Bookkeeping per open sheet, so `close` can return focus and unbind. */
interface OpenSheet {
  readonly invoker: Element | null;
  readonly onClose: () => void;
  readonly onCancel: (event: Event) => void;
  readonly dismiss: HTMLElement | null;
}

const open$ = new WeakMap<HTMLDialogElement, OpenSheet>();

export function isOpen(dialog: HTMLDialogElement): boolean {
  return open$.has(dialog) || dialog.hasAttribute("open");
}

/**
 * Open a sheet.
 *
 * Returns a `close()` that is safe to call repeatedly, so a caller can hand it to
 * both a confirm handler and a cancel handler without tracking which ran.
 */
export function open(dialog: HTMLDialogElement, invoker: Element | null = null): () => void {
  if (isOpen(dialog)) return () => close(dialog);

  const dismiss = dialog.querySelector<HTMLElement>(DISMISS_SELECTOR);

  // `close` fires for `Esc`, for `dialog.close()` and for a `<form method="dialog">`
  // submit, so focus restoration is bound once here rather than at each call site.
  const onClose = (): void => {
    finish(dialog);
  };
  // `cancel` is `Esc`. Left to proceed — `Esc` is a platform expectation — but
  // handled explicitly so it cannot be confused with a dismiss control's click.
  const onCancel = (): void => {
    // No `preventDefault`: cancelling `Esc` would trap the customer.
  };

  const record: OpenSheet = { invoker, onClose, onCancel, dismiss };
  open$.set(dialog, record);

  dialog.addEventListener("close", onClose);
  dialog.addEventListener("cancel", onCancel);
  if (dismiss) {
    dismiss.onclick = () => close(dialog);
  }

  // `showModal` is what makes the background inert and traps focus. `show()` would
  // open a non-modal dialog with none of that, and jsdom implements neither
  // fully — hence the guard, which keeps the module testable without pretending a
  // non-modal sheet is equivalent.
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "open");
  }

  toSheetHeading(dialog);
  return () => close(dialog);
}

/** Close a sheet. Idempotent. */
export function close(dialog: HTMLDialogElement): void {
  if (!isOpen(dialog)) return;
  if (typeof dialog.close === "function" && dialog.hasAttribute("open")) {
    // Triggers `close`, which runs `finish`.
    dialog.close();
    return;
  }
  finish(dialog);
}

/** Unbind, drop the record, and return focus to the invoking control. */
function finish(dialog: HTMLDialogElement): void {
  const record = open$.get(dialog);
  if (!record) return;
  open$.delete(dialog);
  dialog.removeEventListener("close", record.onClose);
  dialog.removeEventListener("cancel", record.onCancel);
  if (record.dismiss) record.dismiss.onclick = null;
  dialog.removeAttribute("open");
  restore(record.invoker);
}
