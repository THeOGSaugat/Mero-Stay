import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { assertStorageKey, type DocumentStorage } from "./document-storage.js";

/**
 * Documents on the local disk (ADR 0016): development, tests and CI, or a single-instance
 * deployment with backed-up disk. The root must be outside any web root; files are written
 * owner-only (0600) and atomically (temporary file + rename), so a reader never sees half a file.
 */
export class LocalDiskStorage implements DocumentStorage {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("LocalDiskStorage needs an absolute directory");
    this.root = resolve(root);
  }

  /** The file for a key; refuses anything that would leave the root. */
  private pathOf(key: string): string {
    assertStorageKey(key);
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return path;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}
