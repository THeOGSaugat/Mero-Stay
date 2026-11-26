import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { parseEnv, storageConfigFromEnv } from "../../config/env.js";
import { assertStorageKey, documentStorageKey } from "./document-storage.js";
import { createDocumentStorage, LocalDiskStorage, S3Storage } from "./index.js";

describe("storage keys (ADR 0016)", () => {
  it("are server-generated: documents/<provider>/<document>/<random>, different every time", () => {
    const provider = "8b0c0c59-9d4b-4f43-9a51-5b8a4f7c2f10";
    const doc = "1e9b4a43-34f2-4b38-9c2a-6a51ef3bb0d2";
    const a = documentStorageKey(provider, doc);
    expect(a).toMatch(new RegExp(`^documents/${provider}/${doc}/[0-9a-f]{32}$`));
    expect(documentStorageKey(provider, doc)).not.toBe(a);
  });

  it.each(["../secret", "/etc/passwd", "a//b", "a/../b", "A/B", "a b", "", "https://x.example/y"])(
    "refuses %s",
    (key) => {
      expect(() => assertStorageKey(key)).toThrow();
    },
  );
});

describe("local-disk storage (dev, tests, CI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "merostay-storage-unit-"));
  const storage = new LocalDiskStorage(dir);

  it("stores, reads, replaces and deletes; owner-only file permissions", async () => {
    await storage.put("documents/p/d/k1", Buffer.from("first"));
    expect(await storage.get("documents/p/d/k1")).toEqual(Buffer.from("first"));
    expect(statSync(join(dir, "documents/p/d/k1")).mode & 0o777).toBe(0o600);
    await storage.put("documents/p/d/k1", Buffer.from("second"));
    expect(await storage.get("documents/p/d/k1")).toEqual(Buffer.from("second"));
    await storage.delete("documents/p/d/k1");
    expect(await storage.get("documents/p/d/k1")).toBeNull();
    await expect(storage.delete("documents/p/d/k1")).resolves.toBeUndefined(); // idempotent
  });

  it("never leaves its directory and needs an absolute root", async () => {
    await expect(storage.get("../outside")).rejects.toThrow();
    await expect(storage.put("a/../../b", Buffer.from("x"))).rejects.toThrow();
    expect(() => new LocalDiskStorage("relative/dir")).toThrow();
  });
});

describe("S3-compatible storage (production option)", () => {
  type Sent = { name: string; input: Record<string, unknown> };
  function fakeClient(respond: (command: unknown) => unknown) {
    const sent: Sent[] = [];
    const client = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: command.constructor.name, input: command.input });
        return Promise.resolve(respond(command));
      },
    };
    return { sent, client: client as unknown as ConstructorParameters<typeof S3Storage>[1] };
  }

  it("puts private objects (encrypted on AWS), reads and deletes them by key", async () => {
    const { sent, client } = fakeClient((command) =>
      command instanceof GetObjectCommand
        ? { Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) } }
        : {},
    );
    const storage = new S3Storage({ bucket: "merostay-docs", region: "ap-south-1" }, client);
    await storage.put("documents/p/d/k", Buffer.from("abc"), "application/pdf");
    expect(await storage.get("documents/p/d/k")).toEqual(Buffer.from([1, 2, 3]));
    await storage.delete("documents/p/d/k");
    expect(sent.map((s) => s.name)).toEqual([
      PutObjectCommand.name,
      GetObjectCommand.name,
      DeleteObjectCommand.name,
    ]);
    expect(sent[0]?.input).toMatchObject({
      Bucket: "merostay-docs",
      Key: "documents/p/d/k",
      ContentType: "application/pdf",
      ContentLength: 3,
      ServerSideEncryption: "AES256",
    });
    expect(sent[0]?.input).not.toHaveProperty("ACL"); // never public
  });

  it("does not send the encryption header to S3-compatible endpoints (R2, MinIO)", async () => {
    const { sent, client } = fakeClient(() => ({}));
    const storage = new S3Storage(
      { bucket: "b", region: "auto", endpoint: "https://acc.r2.cloudflarestorage.com" },
      client,
    );
    await storage.put("documents/p/d/k", Buffer.from("x"), "image/png");
    expect(sent[0]?.input).not.toHaveProperty("ServerSideEncryption");
  });

  it("a missing object is null; other errors propagate; bad keys never reach the store", async () => {
    const missing = fakeClient(() => {
      throw new NoSuchKey({ message: "missing", $metadata: {} });
    });
    expect(await new S3Storage({ bucket: "b", region: "r" }, missing.client).get("a/b")).toBeNull();
    const broken = fakeClient(() => {
      throw new Error("network down");
    });
    await expect(
      new S3Storage({ bucket: "b", region: "r" }, broken.client).get("a/b"),
    ).rejects.toThrow("network down");
    const guarded = fakeClient(() => ({}));
    await expect(
      new S3Storage({ bucket: "b", region: "r" }, guarded.client).put("../x", Buffer.from(""), "x"),
    ).rejects.toThrow();
    expect(guarded.sent).toHaveLength(0);
  });
});

describe("storage configuration", () => {
  const url = "postgresql://u:p@localhost/db";
  const prod = {
    DATABASE_URL: `${url}?sslmode=require`,
    NODE_ENV: "production",
    TRUST_PROXY_HOPS: "0",
  };

  it("defaults to local disk (apps/api/.storage) outside production", () => {
    const config = storageConfigFromEnv(parseEnv({ DATABASE_URL: url }));
    expect(config.driver).toBe("local");
    expect(config.driver === "local" && config.directory.endsWith(join("api", ".storage"))).toBe(
      true,
    );
    expect(createDocumentStorage(config).driver).toBe("local");
  });

  it("production must choose a driver; local needs an absolute directory; s3 needs bucket and region", () => {
    expect(() => parseEnv(prod)).toThrow(/STORAGE_DRIVER: is required in production/);
    expect(() => parseEnv({ ...prod, STORAGE_DRIVER: "local" })).toThrow(
      /STORAGE_LOCAL_DIR: is required/,
    );
    expect(() => parseEnv({ ...prod, STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: "docs" })).toThrow(
      /STORAGE_LOCAL_DIR: must be an absolute directory/,
    );
    expect(() => parseEnv({ ...prod, STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET: is required/);
    const s3 = storageConfigFromEnv(
      parseEnv({
        ...prod,
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "merostay-docs",
        S3_REGION: "ap-south-1",
      }),
    );
    expect(s3).toEqual({
      driver: "s3",
      bucket: "merostay-docs",
      region: "ap-south-1",
      forcePathStyle: false,
    });
  });

  it("access keys come together, and are never echoed in an error", () => {
    let message = "";
    try {
      parseEnv({
        DATABASE_URL: url,
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "bucket",
        S3_REGION: "r",
        S3_SECRET_ACCESS_KEY: "super-secret-value",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must be set together/);
    expect(message).not.toContain("super-secret-value");
  });
});
