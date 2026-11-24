import { describe, expect, it } from "vitest";
import { adminProviderOrder, adminProviderWhere } from "../modules/providers/providers.service.js";
import { adminProvidersQuerySchema } from "../modules/providers/providers.schemas.js";
import { likePattern, pageInfo, skipTake, totalPages } from "./pagination.js";

describe("paging math (gap 25)", () => {
  it("offsets and page counts for any page, beyond 100 rows too", () => {
    expect(skipTake({ page: 1, pageSize: 50 })).toEqual({ skip: 0, take: 50 });
    expect(skipTake({ page: 3, pageSize: 50 })).toEqual({ skip: 100, take: 50 });
    expect(totalPages(105, 50)).toBe(3);
    expect(totalPages(100, 50)).toBe(2);
    expect(totalPages(0, 20)).toBe(1);
    expect(pageInfo({ page: 3, pageSize: 50 }, 105)).toEqual({
      page: 3,
      pageSize: 50,
      total: 105,
      totalPages: 3,
    });
  });

  it("the query keeps pageSize ≤ 100 but allows any page", () => {
    expect(adminProvidersQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(adminProvidersQuerySchema.parse({ page: "7", pageSize: "100" })).toMatchObject({
      page: 7,
      pageSize: 100,
      sort: "newest",
    });
  });
});

describe("admin provider search and ordering", () => {
  it("q searches names, owner email and type; combined with the filters", () => {
    expect(adminProviderWhere({ q: "Fewa", status: "VERIFIED", providerType: undefined })).toEqual({
      status: "VERIFIED",
      OR: [
        { displayName: { contains: "Fewa", mode: "insensitive" } },
        { legalName: { contains: "Fewa", mode: "insensitive" } },
        { owner: { email: { contains: "Fewa", mode: "insensitive" } } },
        { providerType: { name: { contains: "Fewa", mode: "insensitive" } } },
        { providerTypeCode: "fewa" },
      ],
    });
    expect(
      adminProviderWhere({ q: undefined, status: undefined, providerType: undefined }),
    ).toEqual({});
  });

  it("q is trimmed and bounded; empty is rejected", () => {
    expect(adminProvidersQuerySchema.parse({ q: "  lodge  " }).q).toBe("lodge");
    expect(adminProvidersQuerySchema.safeParse({ q: "   " }).success).toBe(false);
    expect(adminProvidersQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
  });

  it("every order ends with id, so pages never overlap", () => {
    for (const sort of ["newest", "oldest", "name"] as const) {
      expect(adminProviderOrder(sort).at(-1)).toHaveProperty("id");
    }
    expect(adminProviderOrder("newest")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("raw-SQL search escapes LIKE wildcards", () => {
    expect(likePattern("Fewa")).toBe("%Fewa%");
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});
