/**
 * Disk-backed backup writer for the M0 export (task 7.1).
 *
 * This is the production implementation of {@link BackupWriter}: it writes the
 * versioned M0 backup JSON to a directory on disk (the rollback anchor of
 * Req 14.1). It is intentionally kept separate from `m0Export.ts` so the export
 * logic stays free of filesystem concerns and can be unit-tested with an
 * in-memory writer that touches no disk.
 *
 * SAFETY: this only writes NEW backup files into a chosen directory; it never
 * reads, mutates, or deletes any Shopify data. During M0 execution the backup
 * directory is the local rollback anchor, not a live system.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BackupWriter } from "./m0Export.js";

/**
 * A {@link BackupWriter} that persists backups as files under a base directory.
 * The directory is created if it does not exist. `write` returns the absolute
 * path the backup was written to.
 */
export class FileBackupWriter implements BackupWriter {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  async write(filename: string, contents: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });
    const target = join(this.baseDir, filename);
    // `wx` fails if the file already exists, so a timestamped backup is never
    // silently overwritten — each export produces a fresh, immutable anchor.
    await writeFile(target, contents, { encoding: "utf8", flag: "wx" });
    return target;
  }
}
