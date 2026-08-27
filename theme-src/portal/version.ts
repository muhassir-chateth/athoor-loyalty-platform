/**
 * The portal bundle's own version string (spec task 7.1).
 *
 * HAND-MAINTAINED, AND DELIBERATELY SO. The obvious alternative — stamping a
 * build timestamp or a git SHA at build time — would make esbuild's output
 * differ on every run for identical source. That breaks two things at once: the
 * `--check` mode of `scripts/build/portal-assets.mjs`, which proves the
 * committed artefacts match the committed source by rebuilding and comparing
 * bytes, and design §25.5's requirement that the approved bytes equal the pushed
 * bytes. A deterministic build is worth more than an automatic version string.
 *
 * NOTHING BRANCHES ON THIS. It is not a cache key — Shopify's asset URL already
 * carries a content hash — and no code compares it. It exists so that a page
 * behaving unexpectedly can be asked which bundle it is running, in a console,
 * without inferring it from a CDN filename. If it goes stale the only cost is
 * that the answer to that question is imprecise.
 *
 * Bump on a change to the portal's public boot contract, not on every edit.
 */
export const PORTAL_BUILD_VERSION = "0.1.0";
