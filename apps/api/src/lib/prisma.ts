import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

/**
 * Creates the Prisma client using the `pg` driver adapter (required by Prisma 7).
 * Create ONE client per process and pass it to the code that needs it.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    // Fail fast instead of hanging when the database is unreachable.
    connectionTimeoutMillis: 5_000,
  });
  return new PrismaClient({ adapter });
}

/** Runs a trivial query to prove the database is reachable. Rejects otherwise. */
export async function checkDatabaseConnection(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
