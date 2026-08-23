/**
 * READ-ONLY verification that the four business webhook topics are registered
 * to THIS app and point at our endpoint. One GraphQL query, no mutation.
 *
 * WHY A SEPARATE SCRIPT, AND WHY IT NEEDS THE LOYALTY APP'S OWN TOKEN
 * ------------------------------------------------------------------
 * `webhookSubscriptions` is scoped PER APP. Querying it with any other app's
 * Admin token returns that app's subscriptions — which is why the existing
 * `scripts/probe-admin.mjs webhooks` returns `[]`: its credential belongs to a
 * different custom app ("permanent token"), not the loyalty app. An empty result
 * from the wrong token is not evidence of anything, and treating it as evidence
 * would be the worst possible outcome here, because it reads as proof.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * ----------------------------------
 * `src/webhooks/registration.ts` exists but is invoked from NO production code
 * path, no npm script, and no operator script — only referenced in a comment in
 * `index.ts` saying registration is a separate deploy step. Meanwhile production
 * has recorded ZERO webhook events of any topic, and zero `earn_signup` entries
 * in its entire history. That combination is consistent with two very different
 * worlds: a quiet store with no qualifying events, or four subscriptions that
 * were never created. Those differ enormously — in the second, no purchase has
 * ever earned points — and only Shopify can say which is true.
 *
 * SECURITY: the token is read from the environment, never from an argument (so
 * it cannot land in shell history) and is NEVER printed. Read-only: the only
 * GraphQL operation is a query.
 *
 * Usage, from the loyalty-service directory. Copy the value of
 * SHOPIFY_ADMIN_API_TOKEN from the Render dashboard into your own shell — do not
 * paste it into a chat or a file:
 *
 *   export SHOPIFY_ADMIN_API_TOKEN='<paste from Render>'
 *   node scripts/verify-webhook-subscriptions.mjs
 *   unset SHOPIFY_ADMIN_API_TOKEN
 */
const REQUIRED_TOPICS = [
  "CUSTOMERS_CREATE",
  "ORDERS_PAID",
  "REFUNDS_CREATE",
  "ORDERS_CANCELLED",
];

/** Shopify reports topics in SCREAMING_SNAKE; our config uses slash form. */
const HUMAN = {
  CUSTOMERS_CREATE: "customers/create",
  ORDERS_PAID: "orders/paid",
  REFUNDS_CREATE: "refunds/create",
  ORDERS_CANCELLED: "orders/cancelled",
};

const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
const domain = process.env.SHOPIFY_SHOP_DOMAIN ?? "myathoorlondon.myshopify.com";
const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2024-10";

if (!token) {
  console.error(
    "SHOPIFY_ADMIN_API_TOKEN is not set in this shell.\n" +
      "Copy it from the Render dashboard (Environment) into your own terminal:\n" +
      "  export SHOPIFY_ADMIN_API_TOKEN='<paste>'\n" +
      "Then re-run, and `unset SHOPIFY_ADMIN_API_TOKEN` afterwards.",
  );
  process.exit(2);
}

const QUERY = `{
  webhookSubscriptions(first: 50) {
    edges {
      node {
        id
        topic
        endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
      }
    }
  }
}`;

const res = await fetch(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
  body: JSON.stringify({ query: QUERY }),
});

const text = await res.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error(`Non-JSON response (HTTP ${res.status}). First 200 chars:`);
  // Cannot contain the token: it is only ever sent as a request header.
  console.error(text.slice(0, 200));
  process.exit(2);
}

if (payload.errors) {
  console.error("GraphQL errors:", JSON.stringify(payload.errors, null, 2));
  process.exit(2);
}

const nodes = (payload.data?.webhookSubscriptions?.edges ?? []).map((e) => e.node);

console.log("\nWEBHOOK SUBSCRIPTION VERIFICATION (read-only)\n");
console.log(`shop        : ${domain}`);
console.log(`apiVersion  : ${apiVersion}`);
console.log(`subscriptions owned by THIS app: ${nodes.length}\n`);

const found = new Map(nodes.map((n) => [n.topic, n.endpoint?.callbackUrl ?? n.endpoint?.__typename]));

let missing = 0;
for (const topic of REQUIRED_TOPICS) {
  const target = found.get(topic);
  if (target) {
    console.log(`PASS  ${HUMAN[topic]}  ->  ${target}`);
  } else {
    console.log(`FAIL  ${HUMAN[topic]}  ->  NOT REGISTERED to this app`);
    missing += 1;
  }
}

const extra = nodes.filter((n) => !REQUIRED_TOPICS.includes(n.topic));
if (extra.length) {
  console.log("\nother subscriptions this app owns:");
  for (const n of extra) {
    console.log(`      ${n.topic} -> ${n.endpoint?.callbackUrl ?? n.endpoint?.__typename}`);
  }
}

console.log(`\nallPassed = ${missing === 0}`);
if (missing > 0) {
  console.log(
    `${missing} of ${REQUIRED_TOPICS.length} business topics are not registered to this app.\n` +
      "If this is the loyalty app's token, those events have never been delivered — meaning no\n" +
      "purchase has earned points and no new customer has been enrolled by webhook.",
  );
}
process.exitCode = missing === 0 ? 0 : 1;
