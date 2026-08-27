/**
 * `athoor-portal-overview.js` — the Overview section bundle's entry point.
 *
 * TASK 7.1 OWNS THIS FILE'S EXISTENCE; TASK 27.2 OWNS ITS BEHAVIOUR.
 * The multi-entry build of design §16.7 emits one bundle per section, so each
 * section needs an entry point before the build can be verified at all. This is
 * that entry point and nothing more: it registers the section name against the
 * core runtime so the wiring is real and testable, and its boot function is
 * empty because every Overview behaviour — composing the tiles, the omit-empty
 * rule, the no-shift rule — is task 27.2 and 27.3.
 *
 * The body is left empty rather than filled with placeholder work. An empty
 * function whose owner is named is legible; a body that appears to do something
 * is not, and would have to be unpicked before task 27.2 could start.
 *
 * Overview is built LAST among the sections (tasks.md ordering rule) because it
 * composes the others.
 */
import { registerSection } from "./registration.js";

registerSection("overview", () => {
  // Task 27.2.
});
