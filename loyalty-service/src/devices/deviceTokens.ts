/**
 * Device_Token registration + notification-event model (task 19.1).
 *
 * MOBILE READINESS (Requirement 19). This module implements the data-side of
 * the design's mobile-readiness surface — registering/de-registering push
 * Device_Tokens and modelling notification events that target those tokens —
 * WITHOUT altering any existing web request/response contract (Req 19.1, 19.7).
 * It backs the additive `/v1` routes `POST /v1/devices` and
 * `DELETE /v1/devices/:token` (design.md `/v1` route table).
 *
 * Two capabilities live here:
 *
 *  1. {@link DeviceTokenStore} — register / de-register / list a customer's
 *     Device_Tokens. Registration is idempotent per `(customer_id, token)`
 *     (matching the table's UNIQUE constraint): re-registering a revoked token
 *     re-activates it; de-registering sets `revoked_at` rather than deleting,
 *     preserving an audit trail. Only NON-revoked tokens are "active".
 *
 *  2. Notification-event model (Req 19.2) — a {@link NotificationEvent} is a
 *     customer-scoped event (e.g. points expiring, reward ready) that can be
 *     ISSUED to that customer's registered Device_Tokens WITHOUT requiring a
 *     web client to consume it. {@link resolveNotificationTargets} resolves the
 *     event to the customer's active Device_Tokens — proving the event targets
 *     devices directly, independent of any web session. Actual push DELIVERY is
 *     future (design.md: "Delivery is future"); this models the event so the
 *     capability is not precluded.
 *
 * ADDITIVE-ONLY / OFF-LEDGER: nothing here touches `ledger_entries` /
 * `point_lots` or affects any customer's Balance or Spendable_Balance, and no
 * existing `/v1` endpoint or field is changed (Req 19.7). It never calls the
 * Shopify Admin API.
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * a PoolClient), mirroring the balance/profile/portal-visit source pattern, so
 * the logic is testable without a live database.
 *
 * SAFETY: defining this module touches no live/production system. The Pg-backed
 * store issues SQL only when a caller passes a real Pool/PoolClient at runtime;
 * all logic is unit-tested against an in-memory store, so no live system is
 * touched during verification.
 */
import { z } from "zod";
import type { QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";

/** The mobile platforms a Device_Token can belong to (design.md → `DeviceRegistration.platform`). */
export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * A device registration request (design.md → `DeviceRegistration`): the opaque
 * push `token` and the `platform` it belongs to.
 */
export interface DeviceRegistration {
  token: string;
  platform: DevicePlatform;
}

/**
 * Zod schema validating a `POST /v1/devices` body. `token` is a non-empty
 * string (bounded to a generous 4096 chars — real APNs/FCM tokens are far
 * shorter); `platform` must be one of the known platforms. Unknown keys are
 * stripped so the contract stays additive-friendly.
 */
export const deviceRegistrationSchema = z
  .object({
    token: z.string().trim().min(1, "token must be a non-empty string").max(4096),
    platform: z.enum(DEVICE_PLATFORMS),
  })
  .strip();

/** An active (non-revoked) registered Device_Token for a customer. */
export interface RegisteredDeviceToken {
  token: string;
  platform: DevicePlatform;
}

/**
 * Registers, de-registers, and lists a customer's push Device_Tokens
 * (Requirement 19.1). Expressed as an injectable interface so the routes are
 * unit-testable with an in-memory fake and boot without a live Postgres
 * (mirrors the balance / portal-visit source pattern).
 */
export interface DeviceTokenStore {
  /**
   * Registers a Device_Token for a customer. Idempotent per
   * `(customerId, token)`: registering an already-active token is a no-op that
   * may refresh its platform; registering a previously de-registered token
   * re-activates it.
   */
  register(customerId: string, registration: DeviceRegistration): Promise<void>;
  /**
   * De-registers a Device_Token for a customer (sets `revoked_at`). A no-op
   * when the token is unknown or already revoked, so de-registration is
   * idempotent.
   */
  deregister(customerId: string, token: string): Promise<void>;
  /**
   * Lists a customer's ACTIVE (non-revoked) Device_Tokens — the set a
   * notification event is issued to (Req 19.2).
   */
  listActiveTokens(customerId: string): Promise<RegisteredDeviceToken[]>;
}

/**
 * A notification event that can be issued to a customer's registered
 * Device_Tokens (Requirement 19.2).
 *
 * It is bound to a `customerId` — never to a web session or client — so it can
 * be delivered to devices without a web client consuming it. `type` names the
 * notification (e.g. `points_expiring`, `reward_ready`, `tier_upgraded`);
 * `payload` carries the event-specific data (e.g. expiring amount + expiry
 * date). This mirrors the `notification_events` table (task 19.1 migration).
 */
export interface NotificationEvent {
  customerId: string;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Resolves a {@link NotificationEvent} to the set of active Device_Tokens it
 * should be issued to (Requirement 19.2).
 *
 * This is the modelling point of Req 19.2: a notification targets a customer's
 * registered devices DIRECTLY, so it can be delivered without any web client in
 * the loop. Returns an empty list when the customer has no active device — a
 * valid state (e.g. web-only customer), never an error. Actual push delivery is
 * future and intentionally out of scope here.
 */
export async function resolveNotificationTargets(
  store: DeviceTokenStore,
  event: NotificationEvent,
): Promise<RegisteredDeviceToken[]> {
  return store.listActiveTokens(event.customerId);
}

/**
 * In-memory {@link DeviceTokenStore} — the default for local runs and tests, so
 * the device endpoints run with no live Postgres. Keyed by
 * `customerId → (token → record)`, tracking `revoked` state to mirror the
 * persisted `revoked_at` semantics without a database.
 */
export class InMemoryDeviceTokenStore implements DeviceTokenStore {
  private readonly byCustomer = new Map<string, Map<string, { platform: DevicePlatform; revoked: boolean }>>();

  async register(customerId: string, registration: DeviceRegistration): Promise<void> {
    let tokens = this.byCustomer.get(customerId);
    if (!tokens) {
      tokens = new Map();
      this.byCustomer.set(customerId, tokens);
    }
    // Idempotent upsert: (re-)activate the token and refresh its platform.
    tokens.set(registration.token, { platform: registration.platform, revoked: false });
  }

  async deregister(customerId: string, token: string): Promise<void> {
    const record = this.byCustomer.get(customerId)?.get(token);
    if (record) {
      record.revoked = true;
    }
    // Unknown token → no-op (idempotent), matching the Pg store.
  }

  async listActiveTokens(customerId: string): Promise<RegisteredDeviceToken[]> {
    const tokens = this.byCustomer.get(customerId);
    if (!tokens) {
      return [];
    }
    const active: RegisteredDeviceToken[] = [];
    for (const [token, record] of tokens) {
      if (!record.revoked) {
        active.push({ token, platform: record.platform });
      }
    }
    return active;
  }
}

const REGISTER_SQL = `
  INSERT INTO device_tokens (customer_id, token, platform)
  VALUES ($1, $2, $3)
  ON CONFLICT (customer_id, token)
  DO UPDATE SET platform = EXCLUDED.platform, revoked_at = NULL
`;

const DEREGISTER_SQL = `
  UPDATE device_tokens
  SET revoked_at = now()
  WHERE customer_id = $1 AND token = $2 AND revoked_at IS NULL
`;

const LIST_ACTIVE_SQL = `
  SELECT token, platform
  FROM device_tokens
  WHERE customer_id = $1 AND revoked_at IS NULL
  ORDER BY created_at
`;

interface DeviceTokenRow extends QueryResultRow {
  token: string;
  platform: string;
}

/**
 * Postgres-backed {@link DeviceTokenStore}: writes to the `device_tokens` table
 * (task 19.1 migration). Registration upserts on the `(customer_id, token)`
 * UNIQUE key, clearing `revoked_at` so re-registering re-activates a token;
 * de-registration sets `revoked_at` rather than deleting (audit-preserving);
 * listing returns only non-revoked tokens.
 *
 * OFF-LEDGER: writes ONLY to `device_tokens` and never to `ledger_entries`
 * (Req 19.7).
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing.
 */
export class PgDeviceTokenStore implements DeviceTokenStore {
  constructor(private readonly db: Queryable) {}

  async register(customerId: string, registration: DeviceRegistration): Promise<void> {
    await this.db.query(REGISTER_SQL, [customerId, registration.token, registration.platform]);
  }

  async deregister(customerId: string, token: string): Promise<void> {
    await this.db.query(DEREGISTER_SQL, [customerId, token]);
  }

  async listActiveTokens(customerId: string): Promise<RegisteredDeviceToken[]> {
    const result = await this.db.query<DeviceTokenRow>(LIST_ACTIVE_SQL, [customerId]);
    return result.rows.map((row) => ({
      token: row.token,
      platform: row.platform as DevicePlatform,
    }));
  }
}
