import { z } from "zod";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { toDbDate } from "../../domain/dates.js";
import { pageInfo, paginationShape, skipTake, type Page } from "../../lib/pagination.js";
import { isoDateSchema, uuidSchema } from "../../lib/validation.js";

/** ADMIN: read the audit log, newest first, with filters (ADR 0008). */

export const auditLogQuerySchema = z
  .object({
    ...paginationShape,
    actorUserId: uuidSchema.optional(),
    action: z
      .string()
      .regex(/^[a-z_]+(\.[a-z_]+)+$/)
      .optional(),
    entityType: z
      .string()
      .regex(/^[a-z_]+$/)
      .optional(),
    entityId: z.string().min(1).max(100).optional(),
    /** created_at range [from, to), UTC dates. */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .strict();

type AuditRow = Prisma.AuditLogGetPayload<object>;

export function createAuditLogService({ prisma }: { prisma: PrismaClient }) {
  async function list(query: z.infer<typeof auditLogQuerySchema>) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: toDbDate(query.from) } : {}),
              ...(query.to ? { lt: toDbDate(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...skipTake(query),
      }),
      prisma.auditLog.count({ where }),
    ]);
    return { rows, total };
  }
  return { list };
}

export function serializeAuditLog(rows: AuditRow[], total: number, page: Page) {
  return {
    data: rows.map((row) => ({
      id: row.id,
      actor: row.actorUserId ? { userId: row.actorUserId, role: row.actorRole } : null,
      action: row.action,
      entity: { type: row.entityType, id: row.entityId },
      before: row.before,
      after: row.after,
      ip: row.ip,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
    })),
    page: pageInfo(page, total),
  };
}

export type AuditLogService = ReturnType<typeof createAuditLogService>;
