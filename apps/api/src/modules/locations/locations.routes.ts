import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { uuidSchema } from "../../lib/validation.js";

/**
 * Public, read-only location tree (Province → District → City/Area), one level at a time
 * (Phase 7 Track B, owner approved; first part of operational gap 20).
 *
 * - `GET /locations` → the top level (rows without a parent, e.g. "Nepal").
 * - `GET /locations?parentId=<uuid>` → that location's direct children; an unknown parent → 404.
 *
 * One level per request keeps responses small on mobile data. Names only: no listing data.
 */
export const locationsQuerySchema = z.object({ parentId: uuidSchema.optional() }).strict();

/** Generous cap per level: Nepal's largest level (a district's municipalities) is far smaller. */
const MAX_CHILDREN = 1000;

export async function listLocationLevel(prisma: PrismaClient, parentId: string | undefined) {
  if (parentId) {
    const parent = await prisma.location.findUnique({
      where: { id: parentId },
      select: { id: true },
    });
    if (!parent) throw new AppError(404, "LOCATION_NOT_FOUND", "Location not found.");
  }
  const rows = await prisma.location.findMany({
    where: { parentId: parentId ?? null },
    select: {
      id: true,
      parentId: true,
      kind: true,
      name: true,
      slug: true,
      _count: { select: { children: true } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_CHILDREN,
  });
  return rows.map(({ _count, ...row }) => ({ ...row, hasChildren: _count.children > 0 }));
}

export function createLocationsRouter({ prisma }: { prisma: PrismaClient }): Router {
  const router = Router();
  router.get("/locations", async (req, res) => {
    const { parentId } = locationsQuerySchema.parse(req.query);
    res.json({ data: await listLocationLevel(prisma, parentId) });
  });
  return router;
}
