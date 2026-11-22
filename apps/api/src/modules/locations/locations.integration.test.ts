import { randomUUID } from "node:crypto";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import type { ErrorResponseBody } from "../../lib/errors.js";
import { createPrismaClient } from "../../lib/prisma.js";
import { testAuthConfig } from "../../testing/auth-config.js";
import { createWorld, type World } from "../../testing/fixtures.js";
import { resolveTestDatabase } from "../../testing/test-database.js";

/** GET /api/v1/locations: the public location tree, one level per request (Phase 7 Track B). */

const prisma = createPrismaClient(resolveTestDatabase().pooledUrl);
const app = createApp({
  logger: pino({ level: "silent" }),
  checkDatabase: () => Promise.resolve(),
  prisma,
  auth: testAuthConfig(),
});
let world: World;

interface LocationRow {
  id: string;
  parentId: string | null;
  kind: string;
  name: string;
  slug: string;
  hasChildren: boolean;
}

const rowsOf = (res: request.Response) => (res.body as { data: LocationRow[] }).data;
const codeOf = (res: request.Response) => [res.status, (res.body as ErrorResponseBody).error?.code];

beforeAll(async () => {
  world = await createWorld(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/v1/locations", () => {
  it("lists the top level without a session, then each level's direct children", async () => {
    const { province, town, village } = world.locations;

    const roots = await request(app).get("/api/v1/locations");
    expect(roots.status).toBe(200);
    const root = rowsOf(roots).find((r) => r.id === province.id);
    expect(root).toEqual({
      id: province.id,
      parentId: null,
      kind: "PROVINCE",
      name: province.name,
      slug: province.slug,
      hasChildren: true,
    });
    expect(rowsOf(roots).every((r) => r.parentId === null)).toBe(true);
    expect(rowsOf(roots).some((r) => r.id === town.id)).toBe(false);

    const towns = rowsOf(await request(app).get(`/api/v1/locations?parentId=${province.id}`));
    expect(towns).toEqual([
      expect.objectContaining({ id: town.id, parentId: province.id, hasChildren: true }),
    ]);
    const villages = rowsOf(await request(app).get(`/api/v1/locations?parentId=${town.id}`));
    expect(villages).toEqual([
      expect.objectContaining({ id: village.id, kind: "AREA", hasChildren: false }),
    ]);
    expect(rowsOf(await request(app).get(`/api/v1/locations?parentId=${village.id}`))).toEqual([]);
  });

  it("an unknown parent is 404; malformed or unknown parameters are 400", async () => {
    expect(codeOf(await request(app).get(`/api/v1/locations?parentId=${randomUUID()}`))).toEqual([
      404,
      "LOCATION_NOT_FOUND",
    ]);
    expect(codeOf(await request(app).get("/api/v1/locations?parentId=pokhara"))).toEqual([
      400,
      "VALIDATION_ERROR",
    ]);
    expect(codeOf(await request(app).get("/api/v1/locations?q=pok"))).toEqual([
      400,
      "VALIDATION_ERROR",
    ]);
  });
});
