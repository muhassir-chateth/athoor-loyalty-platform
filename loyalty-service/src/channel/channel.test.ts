/**
 * Unit tests for channel attribution + channel gating (task 21.1) —
 * Requirement 19.3/19.4 and design.md "Channel attribution".
 *
 * These exercise the pure, side-effect-free gating interface that the reward
 * (redemption) and entitlement paths delegate to, and that the optional
 * Property 15 test (task 21.2) validates:
 *
 *   > An app-exclusive item is granted iff the attributed channel == 'app'.
 *
 * Nothing here touches a database, Shopify, or any live system.
 */
import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  DEFAULT_CHANNEL,
  channelSchema,
  isChannel,
  isGrantableOnChannel,
  normalizeChannel,
  type Channel,
} from "./channel.js";

describe("channel constants", () => {
  it("knows exactly web and app", () => {
    expect([...CHANNELS]).toEqual(["web", "app"]);
  });

  it("defaults to web (the pre-app channel, matching the column default)", () => {
    expect(DEFAULT_CHANNEL).toBe("web");
  });
});

describe("isChannel", () => {
  it("accepts the two known channels", () => {
    expect(isChannel("web")).toBe(true);
    expect(isChannel("app")).toBe(true);
  });

  it("rejects anything else, including empty string and non-strings", () => {
    for (const value of ["", "APP", "mobile", "ios", " web", undefined, null, 1, {}]) {
      expect(isChannel(value)).toBe(false);
    }
  });
});

describe("normalizeChannel", () => {
  it("returns a known channel unchanged", () => {
    expect(normalizeChannel("web")).toBe("web");
    expect(normalizeChannel("app")).toBe("app");
  });

  it("falls back to web for undefined/unknown values", () => {
    expect(normalizeChannel(undefined)).toBe("web");
    expect(normalizeChannel("nope")).toBe("web");
    expect(normalizeChannel(null)).toBe("web");
  });

  it("honours an explicit fallback", () => {
    expect(normalizeChannel("nope", "app")).toBe("app");
  });
});

describe("channelSchema (zod)", () => {
  it("parses the two known channels", () => {
    expect(channelSchema.parse("web")).toBe("web");
    expect(channelSchema.parse("app")).toBe("app");
  });

  it("rejects an unknown channel", () => {
    expect(channelSchema.safeParse("mobile").success).toBe(false);
  });
});

describe("isGrantableOnChannel (Property 15 core, Req 19.4)", () => {
  it("grants a non-app-exclusive item on every channel", () => {
    for (const channel of CHANNELS) {
      expect(isGrantableOnChannel({}, channel)).toBe(true);
      expect(isGrantableOnChannel({ appExclusive: false }, channel)).toBe(true);
    }
  });

  it("grants an app-exclusive item ONLY on the app channel", () => {
    expect(isGrantableOnChannel({ appExclusive: true }, "app")).toBe(true);
    expect(isGrantableOnChannel({ appExclusive: true }, "web")).toBe(false);
  });

  it("holds the iff invariant across the full input space", () => {
    const channels: Channel[] = ["web", "app"];
    for (const appExclusive of [true, false]) {
      for (const channel of channels) {
        const expected = !appExclusive || channel === "app";
        expect(isGrantableOnChannel({ appExclusive }, channel)).toBe(expected);
      }
    }
  });
});
