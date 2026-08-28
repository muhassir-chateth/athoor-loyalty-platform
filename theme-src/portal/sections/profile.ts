/**
 * `athoor-portal-profile.js` — the Profile section (tasks 25.1–25.4).
 *
 * Requirements 5.1–5.8, 11.1, 11.2, 11.3, 11.9, 11.10, 13.5, 13.7, 16.4, 16.7,
 * 17.4, 17.6, 17.7, 17.8, 23.8, 25.7.
 *
 * ── FOUR READS, BECAUSE THERE IS NO COMBINED ONE ────────────────────────────
 * Identity (N6), addresses (N8), birthday (N10) and the communication block (N12)
 * are four endpoints. They are read in parallel and rendered into ONE view
 * (Requirement 5.6), and each failure is contained: a birthday outage must not cost
 * the customer the ability to correct their delivery phone number.
 *
 * ── DISPLAY WHAT SHOPIFY STORED, NOT WHAT WAS SUBMITTED ─────────────────────
 * N7 returns a read-back rather than an echo, because Shopify normalises a phone
 * number. Repainting from the response is the difference between the form agreeing
 * with the account and the form telling a comfortable lie (Requirement 5.3).
 *
 * On failure the previously stored value goes back on screen, the module says the
 * change was not saved, and it offers a retry — while the customer's typing stays in
 * the task-18 draft store so a retry does not mean retyping (Requirement 5.5, 16.7).
 * The draft is in memory only; nothing here writes storage of any kind.
 *
 * ── NO PASSWORD CONTROL, AND NO EMAIL EDIT ──────────────────────────────────
 * Requirement 5.7 excludes password entry, change and reset outright, and there is
 * nothing to exclude a control for: the store uses Shopify's new customer accounts,
 * which authenticate by emailed code. `emailEditable` is typed as the literal
 * `false`, so the email is read-only unconditionally and changing it routes to
 * Shopify's own account experience (Requirement 5.8).
 *
 * ── THE BIRTHDAY IS A DAY AND A MONTH, AND NEVER A YEAR ─────────────────────
 * Two `<select>` elements. Requirement 11.2 excludes a birth year, and a date input
 * would demand one. The client validates the day/month combination before spending a
 * request — 29 February is a real birthday and is accepted; 31 February is not —
 * and the server validates again, independently, three layers deep.
 *
 * Every state word comes from `ui/copy.ts`: the eligibility state, the change lock
 * and every field rejection. The service sends identifiers and dates, never
 * sentences, so the client is the only place customer-facing wording exists.
 *
 * SAFETY: four reads and four scoped writes, all through the existing App Proxy
 * transport. No storage. Every value written with `textContent` or `.value`.
 */
import { registerSection } from "./registration.js";
import type {
  PortalBirthdayResponse,
  PortalFieldError,
  PortalIdentityResponse,
  PortalSavedAddress,
} from "../data/types.js";

/** Draft scopes, one per form (task 18's store is keyed per form, not per page). */
const IDENTITY_DRAFT = "profile:identity";
const ADDRESS_DRAFT = "profile:address";

/** Month names for the birthday select. Locale-independent by construction. */
const MONTHS: readonly string[] = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Days per month in a LEAP year, so 29 February is selectable. */
const DAYS_IN_MONTH: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The countries the store ships to, as ISO-3166-1 alpha-2 with their names.
 *
 * A select rather than free text, because `countryCode` is validated as exactly two
 * characters server-side and a typed country name would be rejected every time. The
 * names are rendered client-side from the code, which is the same rule the rest of
 * the portal follows: the service sends an identifier, the client owns the wording.
 */
const COUNTRIES: readonly { code: string; name: string }[] = [
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany" },
  { code: "IT", name: "Italy" },
  { code: "ES", name: "Spain" },
  { code: "NL", name: "Netherlands" },
  { code: "BE", name: "Belgium" },
  { code: "SE", name: "Sweden" },
  { code: "DK", name: "Denmark" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "QA", name: "Qatar" },
  { code: "KW", name: "Kuwait" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
];

/** The four communication toggles N12 carries, with their wording. */
const COMMS: readonly { key: string; label: string }[] = [
  { key: "productLaunches", label: "New fragrance launches" },
  { key: "restockAlerts", label: "When a fragrance is back in stock" },
  { key: "birthdayMessages", label: "A note near your birthday" },
  { key: "referralUpdates", label: "When a friend uses your code" },
];

interface CommunicationBlock {
  readonly communication?: Record<string, boolean>;
}

interface AddressesResponse {
  readonly addresses?: readonly PortalSavedAddress[];
}

registerSection("profile", (root) => {
  const maybeRuntime = window.AthoorPortal;
  if (!maybeRuntime) return;
  const runtime: AthoorPortalRuntime = maybeRuntime;

  const identityForm = root.querySelector<HTMLFormElement>("[data-portal-identity-form]");
  const identityResult = root.querySelector<HTMLElement>("[data-portal-identity-result]");
  const identitySubmit = root.querySelector<HTMLButtonElement>("[data-portal-identity-submit]");
  const summary = root.querySelector<HTMLElement>("[data-portal-error-summary]");
  const summaryList = root.querySelector<HTMLElement>("[data-portal-error-summary-list]");

  const birthdaySheet = root.querySelector<HTMLDialogElement>("[data-portal-birthday-sheet]");
  const birthdayForm = root.querySelector<HTMLFormElement>("[data-portal-birthday-form]");
  const birthdayOpen = root.querySelector<HTMLButtonElement>("[data-portal-birthday-open]");
  const daySelect = root.querySelector<HTMLSelectElement>("[data-portal-birthday-day]");
  const monthSelect = root.querySelector<HTMLSelectElement>("[data-portal-birthday-month]");

  const addressSheet = root.querySelector<HTMLDialogElement>("[data-portal-address-sheet]");
  const addressForm = root.querySelector<HTMLFormElement>("[data-portal-address-form]");
  const addressList = root.querySelector<HTMLElement>("[data-portal-address-list]");
  const addressEmpty = root.querySelector<HTMLElement>("[data-portal-address-empty]");
  const addressFormError = root.querySelector<HTMLElement>("[data-portal-address-form-error]");
  const countrySelect = root.querySelector<HTMLSelectElement>("[data-portal-address-country]");

  const commsBlock = root.querySelector<HTMLElement>("[data-portal-communication]");
  const commsList = root.querySelector<HTMLElement>("[data-portal-comms-list]");

  const template = (name: string): HTMLTemplateElement | null =>
    root.querySelector<HTMLTemplateElement>(`[data-portal-row="${name}"]`);

  /** The last state the SERVER confirmed. Never a local guess. */
  let identity: PortalIdentityResponse | null = null;
  let addresses: readonly PortalSavedAddress[] = [];
  let birthday: PortalBirthdayResponse | null = null;

  /**
   * Whether a submit has already been rejected.
   *
   * §17.7 / task 25.4: validation runs on submit, and on blur ONLY after a first
   * failed submit. Validating on blur before that punishes a customer for moving
   * through a form they have not finished.
   */
  let identitySubmitted = false;
  let addressSubmitted = false;

  /** One in-flight write per form, so a double submit cannot race itself. */
  const inFlight = new Set<string>();

  /** The address being edited, or `null` when the sheet is adding a new one. */
  let editingAddressId: string | null = null;

  /* ---------------------------------------------------------------------- *
   * Validation and error presentation (task 25.4).
   * ---------------------------------------------------------------------- */

  function fieldControl(form: HTMLElement, name: string): HTMLElement | null {
    return form.querySelector<HTMLElement>(`[name="${name}"]`);
  }

  function clearFieldErrors(form: HTMLElement): void {
    for (const node of form.querySelectorAll<HTMLElement>("[data-portal-field-error]")) {
      node.textContent = "";
      node.setAttribute("hidden", "hidden");
    }
    for (const control of form.querySelectorAll<HTMLElement>("input, select, textarea")) {
      control.removeAttribute("aria-invalid");
    }
    if (summary && form === identityForm) {
      summary.setAttribute("hidden", "hidden");
      if (summaryList) summaryList.textContent = "";
    }
  }

  /**
   * Render one field rejection.
   *
   * The wording comes from `copy.fieldError`, never from the server's `message` —
   * §18.9's rule, and the reason the service sends codes at all. `aria-invalid` goes
   * on the control and the message is already `aria-describedby`-linked by the
   * Liquid, so a screen reader reads the label, the state and the reason together.
   */
  function showFieldError(form: HTMLElement, field: string | null, code: string): boolean {
    const slot = form.querySelector<HTMLElement>(`[data-portal-field-error="${field ?? ""}"]`);
    if (!slot || field === null) return false;
    slot.textContent = runtime.copy.fieldError(code);
    slot.removeAttribute("hidden");
    const control = fieldControl(form, field);
    if (control) control.setAttribute("aria-invalid", "true");
    return true;
  }

  /**
   * Present a set of rejections, then move focus.
   *
   * Focus moves to the first failing INPUT when there is one, because that is where
   * the correction happens. When the rejection names no field this asset can point
   * at — Shopify can name `countryCodeV2`, which is not an input here — focus moves
   * to the summary instead, so the customer is not left with a message they cannot
   * find.
   */
  function presentRejections(
    form: HTMLElement,
    fields: readonly PortalFieldError[],
    fallback: string,
  ): void {
    clearFieldErrors(form);
    const unplaced: string[] = [];
    for (const rejection of fields) {
      const field = (rejection as { field?: string | null }).field ?? null;
      const placed = showFieldError(form, field, rejection.code);
      if (!placed) unplaced.push(runtime.copy.fieldError(rejection.code));
    }

    if (form === identityForm && summary && summaryList) {
      summaryList.textContent = "";
      for (const control of form.querySelectorAll<HTMLElement>("[aria-invalid='true']")) {
        const id = control.getAttribute("id");
        const label = id ? form.querySelector(`label[for="${id}"]`)?.textContent : null;
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = id ? `#${id}` : "#";
        link.textContent = label ?? "This field";
        item.appendChild(link);
        summaryList.appendChild(item);
      }
      for (const message of unplaced) {
        const item = document.createElement("li");
        item.textContent = message;
        summaryList.appendChild(item);
      }
      if (summaryList.childElementCount > 0) summary.removeAttribute("hidden");
    }

    const moved = runtime.focus.toFirstInvalid(form);
    if (!moved) {
      if (form === identityForm && summary && summaryList && summaryList.childElementCount > 0) {
        summary.focus();
      } else if (addressFormError && form === addressForm) {
        addressFormError.textContent = unplaced[0] ?? fallback;
        addressFormError.removeAttribute("hidden");
      }
    }
    runtime.announce.assertive(root, unplaced[0] ?? fallback);
  }

  /* ---------------------------------------------------------------------- *
   * Identity (N6 read, N7 write).
   * ---------------------------------------------------------------------- */

  function paintIdentity(value: PortalIdentityResponse): void {
    identity = value;
    if (!identityForm) return;
    const write = (name: string, text: string | null): void => {
      const control = fieldControl(identityForm, name);
      if (control instanceof HTMLInputElement) control.value = text ?? "";
    };
    write("firstName", value.firstName);
    write("lastName", value.lastName);
    write("phone", value.phone);
    write("email", value.email);
  }

  /** Restore whatever the customer had typed, over the stored values. */
  function restoreIdentityDraft(): void {
    if (!identityForm || !runtime.draft.has(IDENTITY_DRAFT)) return;
    const draft = runtime.draft.get(IDENTITY_DRAFT);
    for (const [name, value] of Object.entries(draft)) {
      const control = fieldControl(identityForm, name);
      // The email is read-only and is never part of the draft.
      if (control instanceof HTMLInputElement && name !== "email") control.value = value;
    }
  }

  function captureIdentityDraft(): void {
    if (!identityForm) return;
    for (const name of ["firstName", "lastName", "phone"]) {
      const control = fieldControl(identityForm, name);
      if (control instanceof HTMLInputElement) runtime.draft.set(IDENTITY_DRAFT, name, control.value);
    }
  }

  async function submitIdentity(): Promise<void> {
    if (!identityForm || inFlight.has(IDENTITY_DRAFT)) return;
    identitySubmitted = true;
    clearFieldErrors(identityForm);
    if (identityResult) identityResult.setAttribute("hidden", "hidden");

    // Retained BEFORE the request, so a failure of any kind still has the typing.
    captureIdentityDraft();

    const read = (name: string): string =>
      (fieldControl(identityForm, name) as HTMLInputElement | null)?.value.trim() ?? "";
    const firstName = read("firstName");
    const lastName = read("lastName");
    const phone = read("phone");

    // Client-side shape checks, so an obviously empty required name does not spend a
    // request. The server validates independently — this is not a substitute.
    const local: PortalFieldError[] = [];
    if (firstName === "") local.push({ field: "firstName", code: "required" } as PortalFieldError);
    if (lastName === "") local.push({ field: "lastName", code: "required" } as PortalFieldError);
    if (local.length > 0) {
      presentRejections(identityForm, local, "Please check the details and try again.");
      return;
    }

    inFlight.add(IDENTITY_DRAFT);
    if (identitySubmit) {
      identitySubmit.disabled = true;
      identitySubmit.setAttribute("aria-label", "Saving your details…");
    }

    // `phone` accepts `null` to clear it; an empty string would be rejected.
    const body: Record<string, unknown> = { firstName, lastName, phone: phone === "" ? null : phone };
    const result = await runtime.request<PortalIdentityResponse>({
      method: "PUT",
      path: "/profile/identity",
      body,
    });

    inFlight.delete(IDENTITY_DRAFT);
    if (identitySubmit) {
      identitySubmit.disabled = false;
      identitySubmit.removeAttribute("aria-label");
    }

    if (!result.ok) {
      const fields = result.error.fields ?? [];
      if (fields.length > 0) {
        presentRejections(identityForm, fields, runtime.copy.error(result.error.code));
        return;
      }
      // Requirement 5.5 — the PREVIOUSLY STORED value goes back on screen, the
      // module states the change was not saved, and a retry is offered. The draft
      // survives, so "try again" does not mean "type it again".
      if (identity) paintIdentity(identity);
      if (identityResult) {
        identityResult.textContent = `${runtime.copy.error(result.error.code)} Your change was not saved.`;
        identityResult.removeAttribute("hidden");
      }
      runtime.announce.assertive(root, `${runtime.copy.error(result.error.code)} Your change was not saved.`);
      return;
    }

    // Requirement 5.3 — display the NEWLY STORED value. Shopify normalises a phone
    // number, so this is not the same as the submitted one.
    paintIdentity(result.value);
    runtime.draft.clear(IDENTITY_DRAFT);
    identitySubmitted = false;
    if (identityResult) {
      identityResult.textContent = "Saved.";
      identityResult.removeAttribute("hidden");
    }
    runtime.announce.polite(root, "Your details were saved.");
  }

  /* ---------------------------------------------------------------------- *
   * Birthday (N10 read, N11 write) — task 25.3.
   * ---------------------------------------------------------------------- */

  function buildBirthdayControls(): void {
    if (monthSelect && monthSelect.options.length === 0) {
      for (let index = 0; index < MONTHS.length; index += 1) {
        const option = document.createElement("option");
        option.value = String(index + 1);
        option.textContent = MONTHS[index] ?? "";
        monthSelect.appendChild(option);
      }
    }
    if (daySelect && daySelect.options.length === 0) {
      for (let day = 1; day <= 31; day += 1) {
        const option = document.createElement("option");
        option.value = String(day);
        option.textContent = String(day);
        daySelect.appendChild(option);
      }
    }
  }

  function paintBirthday(value: PortalBirthdayResponse): void {
    birthday = value;
    const stored = root.querySelector<HTMLElement>("[data-portal-birthday-stored]");
    const eligibility = root.querySelector<HTMLElement>("[data-portal-birthday-eligibility]");
    const lock = root.querySelector<HTMLElement>("[data-portal-birthday-lock]");

    if (stored) {
      stored.textContent =
        value.birthday === null
          ? "You have not added your birthday yet."
          : `${String(value.birthday.day)} ${MONTHS[value.birthday.month - 1] ?? ""}`;
    }

    // Requirement 11.9 — the stored birthday, the eligibility STATE and the next
    // permitted change date. All three from identifiers through the copy map.
    if (eligibility) eligibility.textContent = runtime.copy.birthdayEligibility(value.eligibility.state);

    // The lock has no wire state of its own: it is driven off `changeable.allowed`.
    if (lock) {
      if (value.changeable.allowed === false) {
        lock.textContent = runtime.copy.birthdayEligibility("change_locked", value.changeable.allowedFrom);
        lock.removeAttribute("hidden");
      } else {
        lock.setAttribute("hidden", "hidden");
      }
    }

    if (birthdayOpen) {
      birthdayOpen.textContent = value.birthday === null ? "Add your birthday" : "Change your birthday";
      // A control that cannot succeed is disabled WITH its reason stated (§18.8).
      if (value.changeable.allowed === false) {
        birthdayOpen.disabled = true;
        birthdayOpen.setAttribute(
          "aria-label",
          runtime.copy.birthdayEligibility("change_locked", value.changeable.allowedFrom),
        );
      } else {
        birthdayOpen.disabled = false;
        birthdayOpen.removeAttribute("aria-label");
      }
    }

    if (value.birthday && monthSelect && daySelect) {
      monthSelect.value = String(value.birthday.month);
      daySelect.value = String(value.birthday.day);
    }
  }

  /** Is this day/month pair a real date? 29 February is; 31 February is not. */
  function validBirthday(month: number, day: number): boolean {
    if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
    if (month < 1 || month > 12) return false;
    const max = DAYS_IN_MONTH[month - 1] ?? 0;
    return day >= 1 && day <= max;
  }

  async function submitBirthday(): Promise<void> {
    if (!birthdayForm || inFlight.has("birthday")) return;
    clearFieldErrors(birthdayForm);
    const month = Number(monthSelect?.value ?? "");
    const day = Number(daySelect?.value ?? "");

    // Requirement 11.3 — rejected at the client, and NO stored record changes,
    // because no request is sent.
    if (!validBirthday(month, day)) {
      showFieldError(birthdayForm, "birthday", "invalid_day_for_month");
      runtime.focus.toFirstInvalid(birthdayForm);
      runtime.announce.assertive(root, runtime.copy.fieldError("invalid_day_for_month"));
      return;
    }

    inFlight.add("birthday");
    const result = await runtime.request<PortalBirthdayResponse>({
      method: "PUT",
      path: "/profile/birthday",
      body: { month, day },
    });
    inFlight.delete("birthday");

    if (!result.ok) {
      if (result.error.code === "birthday_change_locked") {
        // §23.8 — the lock is rendered WITH its reopening date. Not through
        // `copy.error`, which does not resolve the `{date}` placeholder.
        const sentence = runtime.copy.birthdayEligibility("change_locked", result.error.allowedFrom ?? null);
        showFieldError(birthdayForm, "birthday", "not_allowed");
        const slot = birthdayForm.querySelector<HTMLElement>('[data-portal-field-error="birthday"]');
        if (slot) slot.textContent = sentence;
        runtime.announce.assertive(root, sentence);
        return;
      }
      const fields = result.error.fields ?? [];
      if (fields.length > 0) {
        // The server names `month` or `day`; both share this form's one message slot.
        const first = fields[0];
        showFieldError(birthdayForm, "birthday", first?.code ?? "rejected");
        runtime.focus.toFirstInvalid(birthdayForm);
        runtime.announce.assertive(root, runtime.copy.fieldError(first?.code ?? "rejected"));
        return;
      }
      runtime.announce.assertive(root, `${runtime.copy.error(result.error.code)} Your birthday was not saved.`);
      return;
    }

    paintBirthday(result.value);
    if (birthdaySheet) runtime.sheet.close(birthdaySheet);
    runtime.announce.polite(root, "Your birthday was saved.");
  }

  /* ---------------------------------------------------------------------- *
   * Addresses (N8) — task 25.2.
   * ---------------------------------------------------------------------- */

  function countryName(code: string | null): string {
    if (!code) return "";
    for (const country of COUNTRIES) if (country.code === code) return country.name;
    // An unmapped code renders as itself rather than as nothing: the customer can
    // still recognise their own address.
    return code;
  }

  function addressLines(address: PortalSavedAddress): string {
    return [
      [address.firstName, address.lastName].filter((part) => part).join(" "),
      address.address1,
      address.address2,
      address.city,
      address.province,
      address.zip,
      countryName(address.countryCode),
    ]
      .filter((part) => typeof part === "string" && part !== "")
      .join(", ");
  }

  function paintAddresses(list: readonly PortalSavedAddress[]): void {
    addresses = list;
    if (!addressList) return;
    const rowTemplate = template("address");
    if (!rowTemplate) return;

    addressList.textContent = "";
    const { fragment, failed } = runtime.rows.list(list, rowTemplate, (address, tpl) => {
      const row = tpl.content.cloneNode(true) as DocumentFragment;
      const item = row.querySelector<HTMLElement>("[data-portal-address]");
      if (item) item.dataset.addressId = address.id;
      const lines = row.querySelector<HTMLElement>("[data-slot='lines']");
      if (lines) lines.textContent = addressLines(address);
      const isDefault = row.querySelector<HTMLElement>("[data-slot='default']");
      if (isDefault) isDefault.textContent = address.isDefault ? "Default delivery address" : "";

      const summaryName = addressLines(address);
      const edit = row.querySelector<HTMLButtonElement>("[data-portal-address-edit]");
      if (edit) {
        edit.dataset.addressId = address.id;
        edit.textContent = "Edit";
        // Every control names WHICH address it acts on, so a screen-reader user
        // hearing three "Edit" buttons can tell them apart (§17.8).
        edit.setAttribute("aria-label", `Edit ${summaryName}`);
      }
      const makeDefault = row.querySelector<HTMLButtonElement>("[data-portal-address-default]");
      if (makeDefault) {
        if (address.isDefault) {
          makeDefault.remove();
        } else {
          makeDefault.dataset.addressId = address.id;
          makeDefault.textContent = "Make default";
          makeDefault.setAttribute("aria-label", `Make ${summaryName} the default`);
        }
      }
      const remove = row.querySelector<HTMLButtonElement>("[data-portal-address-delete]");
      if (remove) {
        remove.dataset.addressId = address.id;
        remove.textContent = "Delete";
        remove.setAttribute("aria-label", `Delete ${summaryName}`);
      }
      return row;
    });
    addressList.appendChild(fragment);
    if (failed > 0) runtime.announce.polite(root, "Some addresses could not be shown.");

    if (addressEmpty) {
      if (list.length === 0) addressEmpty.removeAttribute("hidden");
      else addressEmpty.setAttribute("hidden", "hidden");
    }
  }

  function buildCountryControl(): void {
    if (!countrySelect || countrySelect.options.length > 0) return;
    for (const country of COUNTRIES) {
      const option = document.createElement("option");
      option.value = country.code;
      option.textContent = country.name;
      countrySelect.appendChild(option);
    }
  }

  function openAddressSheet(addressId: string | null, invoker: Element | null): void {
    if (!addressSheet || !addressForm) return;
    editingAddressId = addressId;
    addressSubmitted = false;
    clearFieldErrors(addressForm);
    if (addressFormError) addressFormError.setAttribute("hidden", "hidden");

    const existing = addressId === null ? null : addresses.find((a) => a.id === addressId) ?? null;
    const write = (name: string, value: string | null): void => {
      const control = fieldControl(addressForm, name);
      if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
        control.value = value ?? "";
      }
    };
    write("firstName", existing?.firstName ?? "");
    write("lastName", existing?.lastName ?? "");
    write("address1", existing?.address1 ?? "");
    write("address2", existing?.address2 ?? "");
    write("city", existing?.city ?? "");
    write("province", existing?.province ?? "");
    write("zip", existing?.zip ?? "");
    write("countryCode", existing?.countryCode ?? "GB");
    write("phone", existing?.phone ?? "");

    // Anything the customer had typed and not saved wins over the stored values.
    if (runtime.draft.has(ADDRESS_DRAFT)) {
      for (const [name, value] of Object.entries(runtime.draft.get(ADDRESS_DRAFT))) {
        write(name, value);
      }
    }
    runtime.sheet.open(addressSheet, invoker);
  }

  function captureAddressDraft(): void {
    if (!addressForm) return;
    for (const control of addressForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[name], select[name]",
    )) {
      runtime.draft.set(ADDRESS_DRAFT, control.name, control.value);
    }
  }

  async function submitAddress(): Promise<void> {
    if (!addressForm || inFlight.has(ADDRESS_DRAFT)) return;
    addressSubmitted = true;
    clearFieldErrors(addressForm);
    if (addressFormError) addressFormError.setAttribute("hidden", "hidden");
    captureAddressDraft();

    const read = (name: string): string => {
      const control = fieldControl(addressForm, name);
      if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
        return control.value.trim();
      }
      return "";
    };

    // The server makes every field optional, so an address with no line 1 would be
    // accepted and then be undeliverable. The client asks for the minimum that makes
    // an address an address.
    const local: PortalFieldError[] = [];
    for (const required of ["address1", "city", "zip", "countryCode"]) {
      if (read(required) === "") local.push({ field: required, code: "required" } as PortalFieldError);
    }
    if (local.length > 0) {
      presentRejections(addressForm, local, "Please check the address and try again.");
      return;
    }

    const body: Record<string, string> = {};
    for (const name of [
      "firstName",
      "lastName",
      "address1",
      "address2",
      "city",
      "province",
      "zip",
      "countryCode",
      "phone",
    ]) {
      const value = read(name);
      if (value !== "") body[name] = value;
    }

    inFlight.add(ADDRESS_DRAFT);
    const result =
      editingAddressId === null
        ? await runtime.request<{ addresses?: readonly PortalSavedAddress[] }>({
            method: "POST",
            path: "/profile/addresses",
            body,
          })
        : await runtime.request<{ addresses?: readonly PortalSavedAddress[] }>({
            method: "PUT",
            path: `/profile/addresses/${encodeURIComponent(editingAddressId)}`,
            body,
          });
    inFlight.delete(ADDRESS_DRAFT);

    if (!result.ok) {
      const fields = result.error.fields ?? [];
      if (fields.length > 0) {
        presentRejections(addressForm, fields, runtime.copy.error(result.error.code));
        return;
      }
      // An EDIT that Shopify refuses arrives as a bare 404 with no field codes, so
      // there is nothing to attach to a control. The form-level message says what
      // happened rather than leaving the sheet looking successful.
      if (addressFormError) {
        addressFormError.textContent = `${runtime.copy.error(result.error.code)} This address was not saved.`;
        addressFormError.removeAttribute("hidden");
      }
      runtime.announce.assertive(
        root,
        `${runtime.copy.error(result.error.code)} This address was not saved.`,
      );
      return;
    }

    paintAddresses(result.value.addresses ?? addresses);
    runtime.draft.clear(ADDRESS_DRAFT);
    addressSubmitted = false;
    if (addressSheet) runtime.sheet.close(addressSheet);
    runtime.announce.polite(root, "Your address was saved.");
  }

  /**
   * Delete or default — one address, one request.
   *
   * A failure NAMES the address that failed, in its own row, because "some addresses
   * could not be updated" gives the customer nothing to act on.
   */
  async function addressOperation(
    addressId: string,
    operation: "delete" | "default",
    control: HTMLButtonElement,
  ): Promise<void> {
    const key = `${operation}:${addressId}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    control.disabled = true;

    const result =
      operation === "delete"
        ? await runtime.request<{ addresses?: readonly PortalSavedAddress[] }>({
            method: "DELETE",
            path: `/profile/addresses/${encodeURIComponent(addressId)}`,
          })
        : await runtime.request<{ addresses?: readonly PortalSavedAddress[] }>({
            method: "PUT",
            path: `/profile/addresses/${encodeURIComponent(addressId)}/default`,
          });

    inFlight.delete(key);
    control.disabled = false;

    if (!result.ok) {
      const row = control.closest<HTMLElement>("[data-portal-address]");
      const slot = row?.querySelector<HTMLElement>("[data-portal-address-error]");
      const sentence = `${runtime.copy.error(result.error.code)} This address was not changed.`;
      if (slot) {
        slot.textContent = sentence;
        slot.removeAttribute("hidden");
      }
      runtime.announce.assertive(root, sentence);
      return;
    }
    paintAddresses(result.value.addresses ?? addresses);
    runtime.announce.polite(root, operation === "delete" ? "Address removed." : "Default address updated.");
  }

  /* ---------------------------------------------------------------------- *
   * Communication preferences (Requirement 5.6).
   * ---------------------------------------------------------------------- */

  function paintCommunication(block: Record<string, boolean> | undefined): void {
    if (!commsList || !commsBlock) return;
    const rowTemplate = template("communication");
    if (!rowTemplate || !block) {
      commsBlock.setAttribute("hidden", "hidden");
      return;
    }
    commsList.textContent = "";
    for (const entry of COMMS) {
      const fragment = rowTemplate.content.cloneNode(true) as DocumentFragment;
      const toggle = fragment.querySelector<HTMLInputElement>("[data-portal-comms-toggle]");
      const label = fragment.querySelector<HTMLElement>("[data-slot='label']");
      if (label) label.textContent = entry.label;
      if (toggle) {
        toggle.dataset.key = entry.key;
        toggle.checked = block[entry.key] === true;
      }
      commsList.appendChild(fragment);
    }
    commsBlock.removeAttribute("hidden");
  }

  async function toggleCommunication(control: HTMLInputElement): Promise<void> {
    const key = control.dataset.key;
    if (!key || inFlight.has(`comms:${key}`)) return;
    inFlight.add(`comms:${key}`);
    const intended = control.checked;

    const result = await runtime.request<CommunicationBlock>({
      method: "PUT",
      path: "/profile/preferences",
      body: { communication: { [key]: intended } },
    });
    inFlight.delete(`comms:${key}`);

    if (!result.ok) {
      // Put the control back where the SERVER last confirmed it, rather than leaving
      // it showing a preference that was not stored.
      control.checked = !intended;
      runtime.announce.assertive(root, `${runtime.copy.error(result.error.code)} That change was not saved.`);
      return;
    }
    paintCommunication(result.value.communication);
    runtime.cache.clear();
    runtime.announce.polite(root, "Saved.");
  }

  /* ---------------------------------------------------------------------- *
   * Load.
   * ---------------------------------------------------------------------- */

  async function load(): Promise<void> {
    runtime.states.set(root, "loading");
    runtime.announce.loadingOnce(root, runtime.copy.state("loading"));
    buildBirthdayControls();
    buildCountryControl();

    // Four reads in parallel. Identity is the only fatal one: without a name and an
    // email there is no profile to show.
    const [identityResultRead, addressResult, birthdayResult, preferencesResult] = await Promise.all([
      runtime.cache.read<PortalIdentityResponse>({ method: "GET", path: "/profile/identity" }),
      runtime.cache.read<AddressesResponse>({ method: "GET", path: "/profile/addresses" }),
      runtime.cache.read<PortalBirthdayResponse>({ method: "GET", path: "/profile/birthday" }),
      runtime.cache.read<CommunicationBlock>({ method: "GET", path: "/profile/preferences" }),
    ]);

    if (!identityResultRead.ok) {
      runtime.states.degrade(root, identityResultRead.error, () => void load());
      return;
    }
    paintIdentity(identityResultRead.value);
    restoreIdentityDraft();

    // Each of the other three degrades ALONE. A birthday outage must not cost the
    // customer the ability to correct their delivery phone number.
    if (addressResult.ok) paintAddresses(addressResult.value.addresses ?? []);
    else {
      const block = root.querySelector<HTMLElement>("[data-portal-addresses]");
      if (block) block.setAttribute("hidden", "hidden");
      runtime.announce.polite(root, "Your saved addresses are unavailable just now.");
    }

    if (birthdayResult.ok) paintBirthday(birthdayResult.value);
    else {
      const block = root.querySelector<HTMLElement>("[data-portal-birthday]");
      if (block) block.setAttribute("hidden", "hidden");
    }

    if (preferencesResult.ok) paintCommunication(preferencesResult.value.communication);

    runtime.states.set(root, "ready");
  }

  /* ---------------------------------------------------------------------- *
   * Wiring. Bound on this section's own root, never on `document` (§16.10).
   * ---------------------------------------------------------------------- */

  if (identityForm) {
    identityForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitIdentity();
    });
    // §17.7 — on blur ONLY after a first failed submit.
    identityForm.addEventListener(
      "blur",
      (event) => {
        if (!identitySubmitted) return;
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.name === "email") return;
        captureIdentityDraft();
        if (target.value.trim() === "" && (target.name === "firstName" || target.name === "lastName")) {
          showFieldError(identityForm, target.name, "required");
        } else {
          const slot = identityForm.querySelector<HTMLElement>(
            `[data-portal-field-error="${target.name}"]`,
          );
          if (slot) {
            slot.textContent = "";
            slot.setAttribute("hidden", "hidden");
          }
          target.removeAttribute("aria-invalid");
        }
      },
      true,
    );
  }

  if (birthdayForm) {
    birthdayForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitBirthday();
    });
  }

  if (addressForm) {
    addressForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitAddress();
    });
    addressForm.addEventListener(
      "blur",
      (event) => {
        if (!addressSubmitted) return;
        const target = event.target;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
        captureAddressDraft();
      },
      true,
    );
  }

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest("[data-portal-birthday-open]") && birthdaySheet) {
      runtime.sheet.open(birthdaySheet, target.closest("[data-portal-birthday-open]"));
      return;
    }
    const add = target.closest<HTMLButtonElement>("[data-portal-address-add]");
    if (add) {
      // A fresh add starts from a clean sheet, not from a previous edit's draft.
      runtime.draft.clear(ADDRESS_DRAFT);
      openAddressSheet(null, add);
      return;
    }
    const edit = target.closest<HTMLButtonElement>("[data-portal-address-edit]");
    if (edit?.dataset.addressId) {
      runtime.draft.clear(ADDRESS_DRAFT);
      openAddressSheet(edit.dataset.addressId, edit);
      return;
    }
    const makeDefault = target.closest<HTMLButtonElement>("[data-portal-address-default]");
    if (makeDefault?.dataset.addressId) {
      void addressOperation(makeDefault.dataset.addressId, "default", makeDefault);
      return;
    }
    const remove = target.closest<HTMLButtonElement>("[data-portal-address-delete]");
    if (remove?.dataset.addressId) void addressOperation(remove.dataset.addressId, "delete", remove);
  });

  root.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-portal-comms-toggle")) {
      void toggleCommunication(target);
    }
  });

  void load();
});
