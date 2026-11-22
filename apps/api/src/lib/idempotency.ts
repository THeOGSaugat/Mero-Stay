import { createHash } from "node:crypto";
import type { Request } from "express";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { inspectDatabaseError } from "./database-errors.js";
import { AppError } from "./errors.js";

/**
 * Idempotency keys (ADR 0008). A client sends `Idempotency-Key: <8–128 chars of A–Z a–z 0–9 _ ->`
 * on a write; a retry with the same key returns the first result instead of applying again.
 *
 * The key is claimed in the SAME transaction as the write, after the work: if the work fails,
 * nothing is stored and the request can be retried. If two requests with the same key race, the
 * second one's transaction fails on the unique (user, key) index and is rolled back, then it replays
 * the first one's stored result. The same key with a different request is refused (422).
 */

export interface IdempotencyRequest {
  userId: string;
  key: string;
  /** Operation name, e.g. "partner.settle_at_property". */
  scope: string;
  /** What identifies "the same request": route params and body. */
  request: unknown;
}

export interface IdempotentResult {
  resourceId: string;
  status: number;
  /** true when this is a retry answered from the stored first result. */
  replayed: boolean;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/** The Idempotency-Key header, validated; null when absent (unless required). */
export function idempotencyKeyOf(req: Request, required: boolean): string | null {
  const key = req.get("idempotency-key");
  if (key === undefined || key === "") {
    if (!required) return null;
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Send an Idempotency-Key header (8–128 letters, digits, - or _) with this request.",
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Idempotency-Key must be 8–128 letters, digits, - or _.",
    );
  }
  return key;
}

/** Stable SHA-256 of scope + request (object keys sorted, so key order does not matter). */
export function requestFingerprint(scope: string, request: unknown): string {
  return createHash("sha256")
    .update(`${scope}|${canonicalJson(request)}`)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function replay(
  stored: { scope: string; requestFingerprint: string; resourceId: string; responseStatus: number },
  scope: string,
  fingerprint: string,
): IdempotentResult {
  if (stored.scope !== scope || stored.requestFingerprint !== fingerprint) {
    throw new AppError(
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different request.",
    );
  }
  return { resourceId: stored.resourceId, status: stored.responseStatus, replayed: true };
}

/**
 * Runs `work` in one transaction. With a key, the first successful result is remembered and every
 * retry (also a concurrent one) returns it without running `work` again.
 */
export async function withIdempotency(
  prisma: PrismaClient,
  /** Falsy (no key sent) = run once without remembering a result. */
  idem: IdempotencyRequest | null | false | "",
  work: (tx: Prisma.TransactionClient) => Promise<{ resourceId: string; status: number }>,
): Promise<IdempotentResult> {
  if (!idem) {
    const result = await prisma.$transaction(work, TX_OPTIONS);
    return { ...result, replayed: false };
  }
  const fingerprint = requestFingerprint(idem.scope, idem.request);
  const where = { userId_key: { userId: idem.userId, key: idem.key } };

  const existing = await prisma.idempotencyKey.findUnique({ where });
  if (existing) return replay(existing, idem.scope, fingerprint);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const done = await work(tx);
      await tx.idempotencyKey.create({
        data: {
          userId: idem.userId,
          key: idem.key,
          scope: idem.scope,
          requestFingerprint: fingerprint,
          resourceId: done.resourceId,
          responseStatus: done.status,
        },
      });
      return done;
    }, TX_OPTIONS);
    return { ...result, replayed: false };
  } catch (err) {
    const info = inspectDatabaseError(err);
    const isKeyRace =
      info?.sqlState === "23505" &&
      (info.constraint === undefined || info.constraint.startsWith("idempotency_keys_"));
    if (!isKeyRace) throw err;
    // Another request with this key committed first: answer with its result.
    const winner = await prisma.idempotencyKey.findUnique({ where });
    if (!winner) throw err;
    return replay(winner, idem.scope, fingerprint);
  }
}
