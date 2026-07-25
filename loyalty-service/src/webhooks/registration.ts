/**
 * Deploy-time webhook topic registration (task 3.2).
 *
 * The Shopify custom app must subscribe to `customers/create` and `orders/paid`
 * so those events reach the receiver. This module produces the registration
 * *plan* (topics + callback address + format) and offers a helper to apply it
 * through an injected Admin client.
 *
 * SAFETY — READ THIS:
 *   Nothing in this module runs at import or service startup. It does NOT open
 *   any network connection and NEVER registers webhooks against the live
 *   Athoor store on its own. `registerWebhookTopics` acts only when a caller
 *   explicitly passes a real Admin client at deploy time. Tests exercise it
 *   with a fake client. This keeps task 3.2 "local code + config only".
 *
 * Topic scope: task 3.2 covers exactly `customers/create` and `orders/paid`
 * ({@link REGISTERED_WEBHOOK_TOPICS}). The clawback topics (`refunds/create`,
 * `orders/cancelled`) are added by task 9.1 as a SEPARATE set
 * ({@link CLAWBACK_WEBHOOK_TOPICS}) so the MVP registration surface is
 * unchanged; {@link ALL_WEBHOOK_TOPICS} and {@link buildAllWebhookRegistrations}
 * register the full clawback-inclusive set at deploy time.
 */

/** The webhook topics registered by task 3.2 (the MVP earning set). */
export const REGISTERED_WEBHOOK_TOPICS = ["customers/create", "orders/paid"] as const;

export type RegisteredWebhookTopic = (typeof REGISTERED_WEBHOOK_TOPICS)[number];

/** The clawback webhook topics added by task 9.1 (refund / cancellation). */
export const CLAWBACK_WEBHOOK_TOPICS = ["refunds/create", "orders/cancelled"] as const;

export type ClawbackWebhookTopic = (typeof CLAWBACK_WEBHOOK_TOPICS)[number];

/**
 * Every webhook topic the service subscribes to across tasks 3.2 + 9.1. This is
 * the complete set the deploy/bootstrap script should register so refund and
 * cancellation clawback events reach the receiver.
 */
export const ALL_WEBHOOK_TOPICS = [
  ...REGISTERED_WEBHOOK_TOPICS,
  ...CLAWBACK_WEBHOOK_TOPICS,
] as const;

export type AnyWebhookTopic = (typeof ALL_WEBHOOK_TOPICS)[number];

/** The receiver path each topic is delivered to (mounted under /webhooks). */
export const WEBHOOK_CALLBACK_PATH = "/webhooks/shopify" as const;

/** A single webhook subscription to create in Shopify. */
export interface WebhookRegistration {
  topic: AnyWebhookTopic;
  /** Absolute HTTPS callback URL Shopify posts the event to. */
  address: string;
  /** Delivery format; JSON to match the receiver's content-type parser. */
  format: "json";
}

/** Builds one HTTPS JSON registration per topic in `topics` to the receiver path. */
function buildRegistrationsFor(
  topics: readonly AnyWebhookTopic[],
  publicBaseUrl: string,
): WebhookRegistration[] {
  const base = publicBaseUrl.replace(/\/+$/, "");
  return topics.map((topic) => ({
    topic,
    address: `${base}${WEBHOOK_CALLBACK_PATH}`,
    format: "json" as const,
  }));
}

/**
 * Builds the MVP (task 3.2) registration plan from the service's public base
 * URL, e.g. `https://loyalty.athoor.example`. The address must be HTTPS in
 * production so events are delivered over TLS (Requirement 11.11).
 */
export function buildWebhookRegistrations(publicBaseUrl: string): WebhookRegistration[] {
  return buildRegistrationsFor(REGISTERED_WEBHOOK_TOPICS, publicBaseUrl);
}

/**
 * Builds the clawback (task 9.1) registration plan for `refunds/create` and
 * `orders/cancelled` so refund/cancellation events reach the receiver.
 */
export function buildClawbackWebhookRegistrations(publicBaseUrl: string): WebhookRegistration[] {
  return buildRegistrationsFor(CLAWBACK_WEBHOOK_TOPICS, publicBaseUrl);
}

/**
 * Builds the complete registration plan (tasks 3.2 + 9.1). This is what the
 * deploy/bootstrap script should register so every earning and clawback event
 * is delivered.
 */
export function buildAllWebhookRegistrations(publicBaseUrl: string): WebhookRegistration[] {
  return buildRegistrationsFor(ALL_WEBHOOK_TOPICS, publicBaseUrl);
}

/**
 * The minimal Admin API surface needed to create a webhook subscription.
 * Implemented at deploy time by the real Shopify Admin Gateway (task 5.3+);
 * declared here structurally so this module stays decoupled and testable.
 */
export interface WebhookRegistrationClient {
  /**
   * Create (or upsert) a webhook subscription for one topic/address. Returns
   * the created subscription's id (implementation-defined).
   */
  registerWebhook(registration: WebhookRegistration): Promise<{ id: string }>;
}

export interface RegisterWebhookResult {
  topic: AnyWebhookTopic;
  id: string;
}

/** Applies a given registration plan through an injected client. */
async function applyRegistrations(
  client: WebhookRegistrationClient,
  plan: readonly WebhookRegistration[],
): Promise<RegisterWebhookResult[]> {
  const results: RegisterWebhookResult[] = [];
  for (const registration of plan) {
    const { id } = await client.registerWebhook(registration);
    results.push({ topic: registration.topic, id });
  }
  return results;
}

/**
 * Applies the MVP (task 3.2) registration plan through an injected client. Call
 * this from a deploy/bootstrap script — NOT from request handling and NOT at
 * import time.
 *
 * @param client the Admin client (real at deploy time; fake in tests).
 * @param publicBaseUrl the service's public HTTPS base URL.
 */
export async function registerWebhookTopics(
  client: WebhookRegistrationClient,
  publicBaseUrl: string,
): Promise<RegisterWebhookResult[]> {
  return applyRegistrations(client, buildWebhookRegistrations(publicBaseUrl));
}

/**
 * Applies the clawback (task 9.1) registration plan (`refunds/create`,
 * `orders/cancelled`) through an injected client.
 */
export async function registerClawbackWebhookTopics(
  client: WebhookRegistrationClient,
  publicBaseUrl: string,
): Promise<RegisterWebhookResult[]> {
  return applyRegistrations(client, buildClawbackWebhookRegistrations(publicBaseUrl));
}

/**
 * Applies the complete registration plan (tasks 3.2 + 9.1) through an injected
 * client — the full set a deploy should register.
 */
export async function registerAllWebhookTopics(
  client: WebhookRegistrationClient,
  publicBaseUrl: string,
): Promise<RegisterWebhookResult[]> {
  return applyRegistrations(client, buildAllWebhookRegistrations(publicBaseUrl));
}
