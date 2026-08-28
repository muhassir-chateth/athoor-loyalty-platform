/**
 * `athoor-portal-settings.js` — the Settings section (tasks 26.1–26.3).
 *
 * Requirements 13.1–13.8, 16.3, 16.5, 23.3, 23.5, 23.8.
 *
 * ── ONE TOGGLE GROUP, NOT THREE ─────────────────────────────────────────────
 * Task 26.1 describes "communication, notification and privacy preferences as
 * toggles". Only communication exists on the wire: the preferences DTO carries four
 * booleans, `push_enabled` is a reserved column that is explicitly refused a wire
 * name until the app needs it, and privacy here is not a toggle at all — it is the
 * two actions, export and erasure request. Inventing a notification field would mean
 * inventing a name the design declines to specify, so this module renders what the
 * contract has.
 *
 * ── CONSENT IS SHOPIFY'S, AND IS KEPT SEPARATE FOR THAT REASON ──────────────
 * Marketing consent is written through N9 and never through the preferences block,
 * which rejects a `marketingConsent` key by name rather than stripping it. Two
 * records of when someone withdrew consent is a compliance problem, not a caching
 * convenience — so the date shown is the one Shopify returned, and this module keeps
 * no copy of it. `updatedAt` is the EMPTY STRING for a customer whose consent has
 * never been set, which is a different statement from "withdrawn" and gets its own
 * sentence.
 *
 * ── THE EXPORT IS FETCHED, NOT NAVIGATED ────────────────────────────────────
 * N14 sets `Content-Disposition: attachment`, so a plain link would download. It is
 * fetched through the transport anyway, because a navigation cannot read the `429`
 * body — and task 26.3 requires that limit to render as a designed wait state. The
 * cost is that the saved bytes are this asset's re-serialisation of the document
 * rather than the server's exact bytes; the content is the same object, and a
 * customer who cannot be told why nothing happened is worse.
 *
 * ── ERASURE RECORDS INTENT AND DELETES NOTHING ──────────────────────────────
 * N15 writes one row and returns a reference. Erasure spans nine tables, is
 * irreversible, and must be coordinated with Shopify's own erasure, so it is
 * operator-run. Every sentence here says a person will action it. A confirmation
 * implying the data had already gone would be false at the moment it was read
 * (Requirement 23.5), and a self-service button that deleted irreversibly on one
 * press would be the wrong design for a right this consequential.
 *
 * ── NO CREDENTIAL CONTROL ───────────────────────────────────────────────────
 * No password entry, change or reset, and no email input (Requirement 13.7). The
 * store uses Shopify's new customer accounts, which authenticate by emailed code.
 *
 * SAFETY: three reads and three scoped writes, all through the existing App Proxy
 * transport. No storage. `privacy/redaction.ts` is operator-only and is not
 * reachable from any route, let alone from here.
 */
import { registerSection } from "./registration.js";
import type { PortalConsentResponse, PortalErasureRequestResponse } from "../data/types.js";

/**
 * The four communication toggles, each with the purpose stated at the point of
 * collection (Requirement 23.8).
 */
const SETTINGS: readonly { key: string; label: string; purpose: string }[] = [
  {
    key: "productLaunches",
    label: "New fragrance launches",
    purpose: "So you hear about a new release before it sells through.",
  },
  {
    key: "restockAlerts",
    label: "Back-in-stock alerts",
    purpose: "So you know when something you wanted is available again.",
  },
  {
    key: "birthdayMessages",
    label: "Birthday note",
    purpose: "So we can send you a gift near your birthday. Uses the day and month only.",
  },
  {
    key: "referralUpdates",
    label: "Referral updates",
    purpose: "So you know when a friend uses your code and what you earned.",
  },
];

interface PreferencesBlock {
  readonly communication?: Record<string, boolean>;
}

interface AddressesBlock {
  readonly addresses?: readonly unknown[];
}

/** The export document. Untyped by design — nothing renders it. */
interface ExportDocument {
  readonly generatedAt?: string;
}

registerSection("settings", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const commsBlock = root.querySelector<HTMLElement>("[data-portal-comms]");
  const commsList = root.querySelector<HTMLElement>("[data-portal-comms-list]");
  const consentBlock = root.querySelector<HTMLElement>("[data-portal-consent]");
  const consentToggle = root.querySelector<HTMLInputElement>("[data-portal-consent-toggle]");
  const consentState = root.querySelector<HTMLElement>("[data-portal-consent-state]");
  const addressCount = root.querySelector<HTMLElement>("[data-portal-address-count]");
  const exportControl = root.querySelector<HTMLButtonElement>("[data-portal-export]");
  const exportResult = root.querySelector<HTMLElement>("[data-portal-export-result]");
  const erasureOpen = root.querySelector<HTMLButtonElement>("[data-portal-erasure-open]");
  const erasureSheet = root.querySelector<HTMLDialogElement>("[data-portal-erasure-sheet]");
  const erasureConfirm = root.querySelector<HTMLButtonElement>("[data-portal-erasure-confirm]");
  const erasureResult = root.querySelector<HTMLElement>("[data-portal-erasure-result]");

  const template = root.querySelector<HTMLTemplateElement>('[data-portal-row="setting"]');

  /** One in-flight operation per key, so a double press cannot race itself. */
  const inFlight = new Set<string>();

  /* ---------------------------------------------------------------------- *
   * Communication preferences (N12 read, N13 write).
   * ---------------------------------------------------------------------- */

  function paintPreferences(block: Record<string, boolean> | undefined): void {
    if (!commsList || !commsBlock || !template) return;
    if (!block) {
      // Reporting "not subscribed" for a customer who is subscribed would be
      // inventing a fact about their preferences.
      commsBlock.setAttribute("hidden", "hidden");
      return;
    }
    commsList.textContent = "";
    for (const setting of SETTINGS) {
      const fragment = template.content.cloneNode(true) as DocumentFragment;
      const toggle = fragment.querySelector<HTMLInputElement>("[data-portal-comms-toggle]");
      const label = fragment.querySelector<HTMLElement>("[data-slot='label']");
      const purpose = fragment.querySelector<HTMLElement>("[data-slot='purpose']");
      if (label) label.textContent = setting.label;
      if (purpose) {
        purpose.textContent = setting.purpose;
        // The purpose is read WITH the control, not after it, which is what makes it
        // stated at the point of collection rather than merely nearby.
        const id = `AthoorSettingPurpose-${setting.key}`;
        purpose.id = id;
        if (toggle) toggle.setAttribute("aria-describedby", id);
      }
      if (toggle) {
        toggle.dataset.key = setting.key;
        toggle.checked = block[setting.key] === true;
      }
      commsList.appendChild(fragment);
    }
    commsBlock.removeAttribute("hidden");
  }

  async function togglePreference(control: HTMLInputElement): Promise<void> {
    const key = control.dataset.key;
    if (!key || inFlight.has(`pref:${key}`)) return;
    inFlight.add(`pref:${key}`);
    const intended = control.checked;

    const result = await runtime.request<PreferencesBlock>({
      method: "PUT",
      path: "/profile/preferences",
      body: { communication: { [key]: intended } },
    });
    inFlight.delete(`pref:${key}`);

    if (!result.ok) {
      // Back to where the SERVER last confirmed it, rather than left showing a
      // preference that was never stored (Requirement 13.2).
      control.checked = !intended;
      announceFailure(result.error, "That change was not saved.");
      return;
    }
    // The response is a re-read, so this is the stored state and not the submission.
    paintPreferences(result.value.communication);
    runtime.cache.clear();
    runtime.announce.polite(root, "Saved.");
  }

  /* ---------------------------------------------------------------------- *
   * Marketing consent (N9).
   * ---------------------------------------------------------------------- */

  function paintConsent(value: PortalConsentResponse): void {
    if (!consentBlock) return;
    if (consentToggle) consentToggle.checked = value.emailMarketing === true;
    if (consentState) consentState.textContent = runtime.copy.consentState(value.emailMarketing, value.updatedAt);
    consentBlock.removeAttribute("hidden");
  }

  async function toggleConsent(control: HTMLInputElement): Promise<void> {
    if (inFlight.has("consent")) return;
    inFlight.add("consent");
    const intended = control.checked;
    control.disabled = true;

    const result = await runtime.request<PortalConsentResponse>({
      method: "PUT",
      path: "/profile/consent",
      body: { emailMarketing: intended },
    });
    inFlight.delete("consent");
    control.disabled = false;

    if (!result.ok) {
      control.checked = !intended;
      announceFailure(result.error, "Your marketing preference was not saved.");
      return;
    }
    // Requirement 13.4 — the WITHDRAWN state as Shopify reports it, with Shopify's
    // own timestamp. This module never writes a date of its own.
    paintConsent(result.value);
    runtime.announce.polite(
      root,
      result.value.emailMarketing ? "You are subscribed to marketing email." : "You are no longer subscribed to marketing email.",
    );
  }

  /* ---------------------------------------------------------------------- *
   * Export (N14) — task 26.3.
   * ---------------------------------------------------------------------- */

  /** The server's own filename shape, rebuilt because a fetch loses the header. */
  function exportFilename(generatedAt: string | undefined): string {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(generatedAt ?? "")?.[1] ?? "export";
    return `athoor-data-export-${day}.json`;
  }

  function saveDocument(document_: ExportDocument): boolean {
    // `URL.createObjectURL` is absent in some embedded webviews. A failure is
    // reported rather than silent: the customer pressed a control and is owed an
    // outcome either way.
    const url = window.URL ?? window.webkitURL;
    if (!url || typeof url.createObjectURL !== "function") return false;
    let href: string | null = null;
    try {
      const blob = new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" });
      href = url.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = exportFilename(document_.generatedAt);
      anchor.rel = "noopener";
      // Appended so the click is dispatched from a connected node, then removed.
      root.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return true;
    } catch {
      return false;
    } finally {
      if (href && typeof url.revokeObjectURL === "function") url.revokeObjectURL(href);
    }
  }

  function reportExport(message: string, assertively: boolean): void {
    if (exportResult) {
      exportResult.textContent = message;
      exportResult.removeAttribute("hidden");
    }
    if (assertively) runtime.announce.assertive(root, message);
    else runtime.announce.polite(root, message);
  }

  async function requestExport(): Promise<void> {
    if (inFlight.has("export") || !exportControl) return;
    inFlight.add("export");
    exportControl.disabled = true;
    // §18.8 — a disabled control states its reason.
    exportControl.setAttribute("aria-label", "Preparing your data…");

    const result = await runtime.request<ExportDocument>({
      method: "GET",
      path: "/profile/export",
    });

    inFlight.delete("export");
    exportControl.removeAttribute("aria-label");

    if (!result.ok) {
      if (result.error.code === "rate_limit_exceeded") {
        // A designed wait state, stated as a duration. Design E.2 forbids naming the
        // limit or any limiter internals, so neither the ceiling nor the window
        // appears — only how long is left, which is what the customer can act on.
        const wait = `${runtime.copy.privacyAction("export_waiting")} ${runtime.copy.waitFor(result.error.retryAfterSeconds)}`;
        reportExport(wait.trim(), false);
        reEnableAfter(exportControl, result.error.retryAfterSeconds);
        return;
      }
      exportControl.disabled = false;
      reportExport(runtime.copy.error(result.error.code), true);
      return;
    }

    exportControl.disabled = false;
    if (saveDocument(result.value)) {
      reportExport(runtime.copy.privacyAction("export_ready"), false);
      return;
    }
    reportExport("Your data could not be saved to this device. Please try another browser.", true);
  }

  /**
   * Re-enable a control when the server's window elapses.
   *
   * The transport deliberately does not retry a `429` — retrying deepens the limit —
   * so the control comes back on its own rather than inviting a press that would
   * fail. With no countdown from the server it is re-enabled immediately, because
   * leaving it dead forever would be worse than one rejected attempt.
   */
  function reEnableAfter(control: HTMLButtonElement, seconds?: number): void {
    if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) {
      control.disabled = false;
      return;
    }
    window.setTimeout(() => {
      control.disabled = false;
    }, seconds * 1000);
  }

  /* ---------------------------------------------------------------------- *
   * Erasure request (N15) — task 26.3.
   * ---------------------------------------------------------------------- */

  function reportErasure(message: string, assertively: boolean): void {
    if (erasureResult) {
      erasureResult.textContent = message;
      erasureResult.removeAttribute("hidden");
    }
    if (assertively) runtime.announce.assertive(root, message);
    else runtime.announce.polite(root, message);
  }

  async function requestErasure(): Promise<void> {
    if (inFlight.has("erasure") || !erasureConfirm) return;
    inFlight.add("erasure");
    erasureConfirm.disabled = true;
    erasureConfirm.setAttribute("aria-label", "Recording your request…");

    const result = await runtime.request<PortalErasureRequestResponse>({
      method: "POST",
      path: "/profile/erasure-request",
    });

    inFlight.delete("erasure");
    erasureConfirm.removeAttribute("aria-label");
    if (erasureSheet) runtime.sheet.close(erasureSheet);

    if (!result.ok) {
      erasureConfirm.disabled = false;
      if (result.error.code === "rate_limit_exceeded") {
        // Already asked. Not an error to apologise for — the request stands.
        reportErasure(runtime.copy.privacyAction("erasure_waiting"), false);
        if (erasureOpen) erasureOpen.disabled = true;
        return;
      }
      reportErasure(runtime.copy.error(result.error.code), true);
      return;
    }

    // Requirement 23.5 — the acknowledgement states that a PERSON will action it, and
    // never that anything has been deleted. The reference is a handle to quote and
    // carries no customer identifier.
    reportErasure(runtime.copy.privacyAction("erasure_recorded", result.value.reference), false);
    // The request is recorded; pressing again would only be refused.
    if (erasureOpen) {
      erasureOpen.disabled = true;
      erasureOpen.setAttribute("aria-label", "You have already requested deletion");
    }
  }

  /* ---------------------------------------------------------------------- *
   * Shared failure wording.
   * ---------------------------------------------------------------------- */

  function announceFailure(failure: PortalFailure, suffix: string): void {
    const wait =
      failure.code === "rate_limit_exceeded" ? ` ${runtime.copy.waitFor(failure.retryAfterSeconds)}` : "";
    runtime.announce.assertive(root, `${runtime.copy.error(failure.code)} ${suffix}${wait}`.trim());
  }

  /* ---------------------------------------------------------------------- *
   * Load.
   * ---------------------------------------------------------------------- */

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));

    const [preferences, consent, addresses] = await Promise.all([
      runtime.cache.read<PreferencesBlock>({ method: "GET", path: "/profile/preferences" }),
      runtime.cache.read<PortalConsentResponse>({ method: "GET", path: "/profile/consent" }),
      runtime.cache.read<AddressesBlock>({ method: "GET", path: "/profile/addresses" }),
    ]);

    // Preferences failing is fatal: without them there is no settings state to show,
    // and the privacy actions alone are not a Settings page.
    if (!preferences.ok) {
      runtime.states.degrade(root, preferences.error, () => void load());
      return;
    }
    paintPreferences(preferences.value.communication);

    // Consent degrades ALONE. Guessing it would be inventing a compliance-relevant
    // fact, so the block is hidden rather than defaulted.
    if (consent.ok) paintConsent(consent.value);
    else if (consentBlock) consentBlock.setAttribute("hidden", "hidden");

    if (addressCount) {
      if (addresses.ok) {
        const count = addresses.value.addresses?.length ?? 0;
        addressCount.textContent =
          count === 0
            ? "You have no saved addresses."
            : `${String(count)} saved ${count === 1 ? "address" : "addresses"}.`;
      } else {
        // The route to the editor still works, so the count is simply not stated.
        addressCount.textContent = "";
      }
    }

    runtime.states.set(root, "ready");
  }

  /* ---------------------------------------------------------------------- *
   * Wiring. Bound on this section's own root, never on `document` (§16.10).
   * ---------------------------------------------------------------------- */

  root.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.hasAttribute("data-portal-consent-toggle")) {
      void toggleConsent(target);
      return;
    }
    if (target.hasAttribute("data-portal-comms-toggle")) void togglePreference(target);
  });

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-portal-export]")) {
      void requestExport();
      return;
    }
    const open = target.closest<HTMLButtonElement>("[data-portal-erasure-open]");
    if (open && erasureSheet) {
      if (open.disabled) return;
      runtime.sheet.open(erasureSheet, open);
      return;
    }
    if (target.closest("[data-portal-erasure-confirm]")) void requestErasure();
  });

  void load();
});
