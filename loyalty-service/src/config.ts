import { z } from "zod";

/**
 * Least-privilege Admin API scopes the Shopify custom app requests.
 *
 * Requirement 11.11 lists: read_customers, read_orders, read_products,
 * write_discounts, and required webhook scopes.
 *
 * This is the single source of truth for scope configuration/documentation.
 * NOTE (task-1.1 scope): defined as configuration only — no Shopify app is
 * created and no webhooks are registered here (webhook registration is task 3.2).
 *
 * NOTE: `write_price_rules` was removed because the service uses only
 * `discountCodeBasicCreate` (the newer Discounts API) and never calls the
 * legacy PriceRule API. The `discount_codes.shopify_price_rule_id` column
 * exists in the schema but is always NULL.
 */
export const ADMIN_API_SCOPES = [
  "read_customers",
  "read_orders",
  "read_products",
  "write_discounts",
] as const;

/**
 * Webhook topics the service subscribes to (registration deferred to task 3.2).
 * Kept here so the scope/topic surface is documented alongside config.
 */
export const WEBHOOK_TOPICS = [
  "customers/create",
  "orders/paid",
  "refunds/create",
  "orders/cancelled",
] as const;

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

/**
 * Environment schema. Secrets (Admin API token, webhook secret, App Proxy
 * shared secret, DB credentials) are loaded here from the environment and are
 * NEVER hardcoded or committed (Requirement 11.6). See .env.example.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  REQUIRE_HTTPS: boolish.default(false),

  // Shopify custom app
  SHOPIFY_SHOP_DOMAIN: z.string().min(1).default("myathoorlondon.myshopify.com"),
  SHOPIFY_ADMIN_API_TOKEN: z.string().min(1).optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(1).optional(),
  SHOPIFY_APP_PROXY_SECRET: z.string().min(1).optional(),

  // Admin management surface (task 17.1, Req 10.1). Shared secret presented as
  // `Authorization: Bearer <secret>` by an Admin_User. Loaded from secrets/env,
  // never committed (Req 11.6). When absent the admin surface fails closed.
  ADMIN_AUTH_SECRET: z.string().min(1).optional(),

  // Membership-Credential service (task 19.2, Req 19.5/19.6). A DEDICATED
  // signing key — separate from the Admin token, webhook secret, and App Proxy
  // secret — used ONLY to sign/verify the Digital Membership Card / QR member
  // identifier (design.md → "new dedicated signing key" held in secrets
  // management). Loaded from secrets/env, never committed (Req 11.6). When
  // absent the membership-card surface fails closed.
  MEMBERSHIP_SIGNING_KEY: z.string().min(1).optional(),

  // Lazy enrollment fallback (src/enrollment/ensureCustomerEnrollment.ts).
  // DEFAULTS TO FALSE, deliberately: the `customers` table is empty in
  // production, so every authenticated /v1 request 401s with
  // `identity_resolution_failed`. The fallback repairs that by creating the
  // missing local row for a customer Shopify has ALREADY verified — but it
  // changes when loyalty state comes into existence, so it ships off. Merging it
  // therefore changes nothing at runtime, and enabling it is a reversible config
  // change rather than a deploy. It NEVER awards a signup bonus (a repaired row
  // is not a signup), so turning it on cannot mint points for the historical
  // cohort.
  ENROLLMENT_LAZY_FALLBACK_ENABLED: boolish.default(false),

  // Database
  DATABASE_URL: z.string().min(1).optional(),
  PGHOST: z.string().optional(),
  PGPORT: z.coerce.number().int().positive().optional(),
  PGUSER: z.string().optional(),
  PGPASSWORD: z.string().optional(),
  PGDATABASE: z.string().optional(),
  PGSSL: boolish.default(false),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env["NODE_ENV"];
  port: number;
  logLevel: Env["LOG_LEVEL"];
  requireHttps: boolean;
  shopify: {
    shopDomain: string;
    adminApiToken?: string;
    webhookSecret?: string;
    appProxySecret?: string;
    adminApiScopes: readonly string[];
    webhookTopics: readonly string[];
  };
  admin: {
    /** Shared secret for the /v1/admin surface (Req 10.1); undefined = fail closed. */
    authSecret?: string;
  };
  membership: {
    /**
     * Dedicated key used ONLY to sign/verify the Digital Membership Card / QR
     * member identifier (task 19.2, Req 19.5/19.6). Never reuses another
     * secret; undefined = the membership-card surface fails closed.
     */
    signingKey?: string;
  };
  enrollment: {
    /**
     * Whether an authenticated request may lazily enrol a VERIFIED Shopify
     * customer who has no local row yet. Default FALSE (fail closed): enrollment
     * then happens only via the `customers/create` webhook, exactly as today.
     */
    lazyFallbackEnabled: boolean;
  };
  database: {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    ssl: boolean;
  };
}

/**
 * Loads and validates configuration from the process environment.
 * Throws a descriptive error if validation fails so misconfiguration is caught
 * at boot rather than at request time.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Requirement 11.11: enforce HTTPS assumptions in production.
  if (env.NODE_ENV === "production" && !env.REQUIRE_HTTPS) {
    throw new Error(
      "REQUIRE_HTTPS must be true in production (Requirement 11.11: serve all traffic over HTTPS).",
    );
  }

  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    requireHttps: env.REQUIRE_HTTPS,
    shopify: {
      shopDomain: env.SHOPIFY_SHOP_DOMAIN,
      adminApiToken: env.SHOPIFY_ADMIN_API_TOKEN,
      webhookSecret: env.SHOPIFY_WEBHOOK_SECRET,
      appProxySecret: env.SHOPIFY_APP_PROXY_SECRET,
      adminApiScopes: ADMIN_API_SCOPES,
      webhookTopics: WEBHOOK_TOPICS,
    },
    admin: {
      authSecret: env.ADMIN_AUTH_SECRET,
    },
    membership: {
      signingKey: env.MEMBERSHIP_SIGNING_KEY,
    },
    enrollment: {
      lazyFallbackEnabled: env.ENROLLMENT_LAZY_FALLBACK_ENABLED,
    },
    database: {
      connectionString: env.DATABASE_URL,
      host: env.PGHOST,
      port: env.PGPORT,
      user: env.PGUSER,
      password: env.PGPASSWORD,
      database: env.PGDATABASE,
      ssl: env.PGSSL,
    },
  };
}
