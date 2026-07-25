/**
 * Channel attribution + channel gating (task 21.1) — design.md "Channel
 * attribution (Requirement 19)" and Requirement 19.3, 19.4, 19.7.
 *
 * A {@link Channel} is the ORIGIN of a loyalty interaction — `web` (the existing
 * storefront, via App Proxy) or `app` (a future native mobile app, via a
 * Customer Account API token). It matches the `channel` already carried on
 * {@link import("../auth/identity.js").AuthCtx}, so a resolved request's channel
 * flows straight through to the reward/entitlement layer with no new plumbing.
 *
 * This module is the single, pure, side-effect-free home of the channel gating
 * rule (Property 15, task 21.2):
 *
 *   > An app-exclusive item is granted **iff** the attributed `channel == 'app'`.
 *
 * It is intentionally tiny and dependency-free so it can be reused by BOTH the
 * reward/redemption path (task 5.2) AND the entitlement resolver (task 15.2) —
 * "attribute rewards AND entitlements to an originating Channel" (Req 19.3) — and
 * unit/property tested in isolation. Nothing here touches a database, Shopify,
 * or any live system.
 *
 * ADDITIVE (Req 19.7): `web` is the default channel everywhere, matching the
 * `redemptions.channel` column default (`'web'`). A caller that never supplies a
 * channel behaves exactly as before, and a reward/benefit that is not marked
 * app-exclusive is grantable on every channel — so no existing `/v1` contract or
 * behaviour changes.
 */
import { z } from "zod";

/** The origin of a loyalty interaction/reward (Req 19.3). */
export type Channel = "web" | "app";

/** Every known channel, for iteration/validation. */
export const CHANNELS: readonly Channel[] = ["web", "app"] as const;

/**
 * The default channel when none is attributed. `web` matches the existing
 * storefront and the `redemptions.channel` column default, so omitting a channel
 * preserves current behaviour (Req 19.7, additive).
 */
export const DEFAULT_CHANNEL: Channel = "web";

/** Zod schema for a channel value, matching the service's zod validation convention. */
export const channelSchema = z.enum(["web", "app"]);

const CHANNEL_SET: ReadonlySet<string> = new Set<string>(CHANNELS);

/** Type guard: true iff `value` is a known {@link Channel} (`web` or `app`). */
export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && CHANNEL_SET.has(value);
}

/**
 * Coerces an untrusted value to a {@link Channel}, falling back to
 * {@link DEFAULT_CHANNEL} (`web`) for anything unrecognised (including
 * `undefined`). Lets a caller pass an optional channel through without a guard
 * while never trusting an unknown value.
 */
export function normalizeChannel(value: unknown, fallback: Channel = DEFAULT_CHANNEL): Channel {
  return isChannel(value) ? value : fallback;
}

/**
 * Anything that can be gated by channel: a reward or a benefit/entitlement that
 * MAY be flagged app-exclusive. `appExclusive` is optional and defaults to
 * `false` (grantable everywhere), so the vast majority of items — which are not
 * app-exclusive — need no channel at all.
 */
export interface ChannelGated {
  /** When `true`, the item is granted ONLY on the `app` channel (Req 19.4). */
  appExclusive?: boolean;
}

/**
 * The channel gating rule (Property 15, Req 19.4):
 *
 *   granted iff `!item.appExclusive || channel === 'app'`.
 *
 * Equivalently: a non-app-exclusive item is grantable on every channel; an
 * app-exclusive item is grantable **iff** the attributed channel is `app`. Pure
 * and total — no side effects, defined for every input.
 */
export function isGrantableOnChannel(item: ChannelGated, channel: Channel): boolean {
  if (!item.appExclusive) {
    return true;
  }
  return channel === "app";
}
