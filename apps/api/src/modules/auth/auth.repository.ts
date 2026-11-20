import type { Prisma } from "../../generated/prisma/client.js";
import type { Db } from "../listings/listings.repository.js";

/**
 * Prisma queries for users and sessions. `password_hash` is selected ONLY by
 * findUserForLogin; every other query uses PUBLIC_USER_SELECT, which cannot include it.
 */

export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  fullName: true,
  role: true,
  status: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_USER_SELECT }>;

export async function findUserForLogin(db: Db, email: string) {
  return db.user.findUnique({
    where: { email },
    select: { id: true, status: true, passwordHash: true },
  });
}

export async function createUser(
  db: Db,
  data: { email: string; passwordHash: string; fullName: string; phone?: string },
): Promise<PublicUser> {
  return db.user.create({
    data: { ...data, role: "CUSTOMER", status: "ACTIVE" },
    select: PUBLIC_USER_SELECT,
  });
}

export async function findPublicUser(db: Db, id: string): Promise<PublicUser | null> {
  return db.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
}

export async function recordLogin(db: Db, userId: string, at: Date): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: at }, select: { id: true } });
}

export async function insertSession(
  db: Db,
  data: { userId: string; tokenHash: string; expiresAt: Date },
) {
  return db.session.create({ data, select: { id: true, tokenHash: true, expiresAt: true } });
}

export async function findSessionByTokenHash(db: Db, tokenHash: string) {
  return db.session.findUnique({
    where: { tokenHash },
    select: { id: true, tokenHash: true, expiresAt: true, user: { select: PUBLIC_USER_SELECT } },
  });
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.session.deleteMany({ where: { id } });
}
