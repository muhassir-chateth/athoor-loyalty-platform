/**
 * Unit tests for the concrete rollback restore client (task 33).
 *
 * Injected fake `fetch` throughout: no network, no live store. Pinned here:
 *
 *   - the upsert sends `ownerId` + verbatim namespace/key/type/value;
 *   - `userErrors` become a hard failure so the caller records not-restored;
 *   - null-valued backup entries are SKIPPED and REPORTED, never written as "";
 *   - the read-back paginates and returns metafields verbatim;
 *   - throttle retry then success; hard failure propagates immediately;
 *   - the method surface is exactly upsert + read — there is NO delete path
 *     (Req 14.8 structurally).
 */
import { describe, expect, it } from "vitest";
import {
  ShopifyAdminRequestError,
  type FetchLike,
  type FetchRequestInit,
  type HttpResponse,
} from "../shopify/graphqlClient.js";
import {
  ShopifyGraphqlMetafieldRestoreClient,
  type SkippedNullMetafield,
} from "./metafieldRestoreClient.js";

const SHOP = "athoor-loyalty-staging.myshopify.com";
const TOKEN = "shpua_test_token_never_logged";
const GID = "gid://shopify/Customer/9034269556935";

function recordingSleeper(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

interface Call {
  operation: string;
  variables: Record<string, unknown>;
  body: string;
}

function scriptedFetch(script: {
  metafieldsSet?: (variables: Record<string, unknown>) => unknown;
  read?: (variables: Record<string, unknown>) => unknown;
  statusScript?: number[];
}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const statuses = [...(script.statusScript ?? [])];

  const fetch: FetchLike = async (_url, init: FetchRequestInit) => {
    const parsed = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation =
      /mutation\s+(\w+)/.exec(parsed.query)?.[1] ?? /query\s+(\w+)/.exec(parsed.query)?.[1] ?? "?";
    calls.push({ operation, variables: parsed.variables, body: init.body });

    const status = statuses.shift();
    if (status !== undefined && status !== 200) {
      return {
        ok: false,
        status,
        headers: { get: () => null },
        text: async () => "{}",
      } satisfies HttpResponse;
    }

    let data: unknown;
    if (operation === "migrationMetafieldsSet") {
      data =
        script.metafieldsSet?.(parsed.variables) ??
        { metafieldsSet: { metafields: [], userErrors: [] } };
    } else {
      data =
        script.read?.(parsed.variables) ??
        {
          customer: {
            id: parsed.variables.id,
            metafields: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data }),
    } satisfies HttpResponse;
  };

  return { fetch, calls };
}

describe("ShopifyGraphqlMetafieldRestoreClient — method surface (Req 14.8)", () => {
  it("exposes exactly restoreCustomerMetafields and readCustomerMetafields — no delete", () => {
    const { fetch } = scriptedFetch({});
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(client))
      .filter((name) => name !== "constructor")
      .filter((name) => typeof (client as unknown as Record<string, unknown>)[name] === "function")
      .sort();

    expect(surface).toEqual(["readCustomerMetafields", "restoreCustomerMetafields"]);
    expect(surface.some((name) => /delete|remove|destroy/i.test(name))).toBe(false);
  });
});

describe("ShopifyGraphqlMetafieldRestoreClient.restoreCustomerMetafields", () => {
  it("upserts via metafieldsSet with ownerId and verbatim namespace/key/type/value", async () => {
    const { fetch, calls } = scriptedFetch({});
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    await client.restoreCustomerMetafields({
      customerGid: GID,
      customerId: "9034269556935",
      metafields: [
        { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "50" },
        { namespace: "loyalty", key: "activity_log", type: "json", value: '{"events":[]}' },
        { namespace: "loyalty", key: "referral_code", type: "single_line_text_field", value: "" },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe("migrationMetafieldsSet");
    expect(calls[0]?.variables.metafields).toEqual([
      { ownerId: GID, namespace: "loyalty", key: "points_balance", type: "number_integer", value: "50" },
      { ownerId: GID, namespace: "loyalty", key: "activity_log", type: "json", value: '{"events":[]}' },
      { ownerId: GID, namespace: "loyalty", key: "referral_code", type: "single_line_text_field", value: "" },
    ]);
    expect(calls[0]?.body).not.toContain("metafieldsDelete");
  });

  it("skips and reports a null-valued backup entry instead of writing an empty string", async () => {
    const skipped: SkippedNullMetafield[] = [];
    const { fetch, calls } = scriptedFetch({});
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch, {
      onSkippedNullValue: (s) => skipped.push(s),
    });

    await client.restoreCustomerMetafields({
      customerGid: GID,
      customerId: "9034269556935",
      metafields: [
        { namespace: "loyalty", key: "points_expiry_date", type: "date", value: null },
        { namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "bronze" },
      ],
    });

    expect(skipped).toEqual([
      {
        customerId: "9034269556935",
        customerGid: GID,
        namespace: "loyalty",
        key: "points_expiry_date",
        type: "date",
      },
    ]);
    const sent = calls[0]?.variables.metafields as Array<Record<string, string>>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.key).toBe("tier");
    expect(JSON.stringify(sent)).not.toContain("points_expiry_date");
  });

  it("issues no mutation at all for a customer with nothing writable", async () => {
    const { fetch, calls } = scriptedFetch({});
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    await client.restoreCustomerMetafields({
      customerGid: GID,
      customerId: "9034269589703",
      metafields: [],
    });

    expect(calls).toHaveLength(0);
  });

  it("batches at 25 metafields per metafieldsSet call", async () => {
    const { fetch, calls } = scriptedFetch({});
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    await client.restoreCustomerMetafields({
      customerGid: GID,
      customerId: "1",
      metafields: Array.from({ length: 27 }, (_unused, i) => ({
        namespace: "loyalty",
        key: `k${i}`,
        type: "single_line_text_field",
        value: String(i),
      })),
    });

    expect(calls).toHaveLength(2);
    expect((calls[0]?.variables.metafields as unknown[]).length).toBe(25);
    expect((calls[1]?.variables.metafields as unknown[]).length).toBe(2);
  });

  it("maps metafieldsSet userErrors to a hard failure so the caller records not-restored", async () => {
    const { fetch } = scriptedFetch({
      metafieldsSet: () => ({
        metafieldsSet: {
          metafields: [],
          userErrors: [{ field: ["metafields", "0", "value"], message: "value is invalid", code: "INVALID_VALUE" }],
        },
      }),
    });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    await expect(
      client.restoreCustomerMetafields({
        customerGid: GID,
        customerId: "1",
        metafields: [{ namespace: "loyalty", key: "tier", type: "number_integer", value: "bronze" }],
      }),
    ).rejects.toBeInstanceOf(ShopifyAdminRequestError);
  });

  it("retries a throttled upsert with the shared backoff, then succeeds", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetch, calls } = scriptedFetch({ statusScript: [429] });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch, { sleep });

    await client.restoreCustomerMetafields({
      customerGid: GID,
      customerId: "1",
      metafields: [{ namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "gold" }],
    });

    expect(delays).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });

  it("propagates a hard failure immediately without retrying", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetch, calls } = scriptedFetch({ statusScript: [500] });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch, { sleep });

    await expect(
      client.restoreCustomerMetafields({
        customerGid: GID,
        customerId: "1",
        metafields: [{ namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "gold" }],
      }),
    ).rejects.toBeInstanceOf(ShopifyAdminRequestError);
    expect(delays).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("never puts the access token in a thrown error", async () => {
    const { fetch } = scriptedFetch({ statusScript: [500] });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    const err = await client
      .restoreCustomerMetafields({
        customerGid: GID,
        customerId: "1",
        metafields: [{ namespace: "loyalty", key: "tier", type: "single_line_text_field", value: "gold" }],
      })
      .catch((e: unknown) => e);
    expect(JSON.stringify({ message: (err as Error).message, err })).not.toContain(TOKEN);
  });
});

describe("ShopifyGraphqlMetafieldRestoreClient.readCustomerMetafields", () => {
  it("returns every loyalty metafield verbatim, following pages", async () => {
    const { fetch, calls } = scriptedFetch({
      read: (v) =>
        v.cursor === null
          ? {
              customer: {
                id: v.id,
                metafields: {
                  pageInfo: { hasNextPage: true, endCursor: "MF-1" },
                  nodes: [
                    { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "50" },
                  ],
                },
              },
            }
          : {
              customer: {
                id: v.id,
                metafields: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { namespace: "loyalty", key: "activity_log", type: "json", value: '{"e":1}' },
                  ],
                },
              },
            },
    });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    const read = await client.readCustomerMetafields(GID);

    expect(read).toEqual([
      { namespace: "loyalty", key: "points_balance", type: "number_integer", value: "50" },
      { namespace: "loyalty", key: "activity_log", type: "json", value: '{"e":1}' },
    ]);
    expect(calls.map((c) => c.variables.cursor)).toEqual([null, "MF-1"]);
    expect(calls[0]?.variables.namespace).toBe("loyalty");
    for (const call of calls) {
      expect(call.body).not.toMatch(/mutation/);
    }
  });

  it("throws when the customer cannot be read back", async () => {
    const { fetch } = scriptedFetch({ read: () => ({ customer: null }) });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch);

    await expect(client.readCustomerMetafields(GID)).rejects.toThrow(/no customer/);
  });

  it("retries a throttled read, then succeeds", async () => {
    const { sleep, delays } = recordingSleeper();
    const { fetch } = scriptedFetch({ statusScript: [429] });
    const client = new ShopifyGraphqlMetafieldRestoreClient(SHOP, TOKEN, fetch, { sleep });

    await expect(client.readCustomerMetafields(GID)).resolves.toEqual([]);
    expect(delays).toEqual([1000]);
  });
});
