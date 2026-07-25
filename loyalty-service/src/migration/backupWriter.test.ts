/**
 * Unit tests for the disk-backed {@link FileBackupWriter} (task 7.1).
 *
 * These tests exercise ONLY the local filesystem in an OS temp directory that
 * is cleaned up afterwards. No Shopify Admin API is involved and no live data
 * is touched — the writer's sole job is persisting the local rollback anchor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackupWriter } from "./backupWriter.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "m0-backup-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileBackupWriter", () => {
  it("writes the backup file and returns its absolute path", async () => {
    const writer = new FileBackupWriter(dir);
    const contents = JSON.stringify({ kind: "m0-metafield-export" });

    const path = await writer.write("m0-metafield-export-2025-01-15T12-00-00-000Z.json", contents);

    expect(path).toContain("m0-metafield-export-2025-01-15T12-00-00-000Z.json");
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("refuses to overwrite an existing backup (immutable anchor)", async () => {
    const writer = new FileBackupWriter(dir);
    const filename = "m0-metafield-export-2025-01-15T12-00-00-000Z.json";
    await writer.write(filename, "first");

    await expect(writer.write(filename, "second")).rejects.toThrow();
    // The original anchor is preserved unchanged.
    expect(await readFile(join(dir, filename), "utf8")).toBe("first");
  });
});
