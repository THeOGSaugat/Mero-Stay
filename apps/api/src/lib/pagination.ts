import { z } from "zod";

/**
 * Offset pagination for partner/admin lists: `?page=1&pageSize=20` (pageSize ≤ 100).
 * Responses carry `page: { page, pageSize, total }` next to `data`.
 */
export const paginationShape = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export interface Page {
  page: number;
  pageSize: number;
}

export function skipTake({ page, pageSize }: Page): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function pageInfo({ page, pageSize }: Page, total: number) {
  return { page, pageSize, total };
}
