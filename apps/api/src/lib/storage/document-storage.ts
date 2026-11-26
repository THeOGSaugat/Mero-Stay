import { randomBytes } from "node:crypto";

/**
 * Private object storage for verification documents (ADR 0016, gap 14).
 *
 * One small interface, two implementations:
 * - `LocalDiskStorage` (local-disk-storage.ts): development, tests and CI. No secrets.
 * - `S3Storage` (s3-storage.ts): any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze).
 *
 * Objects are never public. Clients never see a key or a storage URL: the API reads the object
 * and streams it to an authorised caller (the owning partner or an admin).
 */
export interface DocumentStorage {
  readonly driver: "local" | "s3";
  /** Stores (or replaces) the object. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The object's bytes, or null when it does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Removes the object. Removing a missing object is not an error. */
  delete(key: string): Promise<void>;
}

/** Server-generated keys only: lower-case letters, digits, `-`, `_` and single `/` separators. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

export function assertStorageKey(key: string): void {
  if (key.length > 255 || !KEY_PATTERN.test(key)) {
    throw new Error("Invalid storage key");
  }
}

/** `documents/<providerId>/<documentId>/<random>`: never derived from the user's file name. */
export function documentStorageKey(providerId: string, documentId: string): string {
  const key = `documents/${providerId}/${documentId}/${randomBytes(16).toString("hex")}`;
  assertStorageKey(key);
  return key;
}
