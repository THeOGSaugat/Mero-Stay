import { z } from "zod";

/**
 * Offset pagination for partner/admin lists: `?page=1&pageSize=20` (pageSize ≤ 100, any page).
 * Responses carry `page: { page, pageSize, total, totalPages }` next to `data`. Lists are
 * ordered with a unique tie-breaker (`id`), so pages never overlap or skip rows.
 */
export const paginationShape = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

/** Free-text search on admin lists (gap 25): trimmed, 1–100 characters. */
export const searchShape = {
  q: z.string().trim().min(1).max(100).optional(),
};

/** List order on admin lists (gap 25). Every order ends with `id` so it is stable. */
export const sortShape = {
  sort: z.enum(["newest", "oldest", "name"]).default("newest"),
};
export type ListSort = "newest" | "oldest" | "name";

export interface Page {
  page: number;
  pageSize: number;
}

export function skipTake({ page, pageSize }: Page): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** Number of pages for `total` rows (at least 1, so "page 1 of 1" for an empty list). */
export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function pageInfo({ page, pageSize }: Page, total: number) {
  return { page, pageSize, total, totalPages: totalPages(total, pageSize) };
}

/** `%text%` for a parameterized ILIKE, with LIKE wildcards in the text escaped (raw SQL only). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
