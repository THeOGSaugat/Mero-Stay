import type { RequestHandler } from "express";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { todayInKathmandu } from "../../domain/dates.js";
import { idParamsSchema } from "../../lib/validation.js";
import { listingDetailQuerySchema, searchListingsQuerySchema } from "./listings.schemas.js";
import {
  serializeListingDetail,
  serializeListingType,
  serializeSearchResult,
} from "./listings.serializers.js";
import {
  getListingDetailService,
  getListingTypes,
  searchListingsService,
} from "./listings.service.js";

export interface ListingsControllerDeps {
  prisma: PrismaClient;
  now: () => Date;
}

/** Parses/validates input with Zod (errors → 400 via the error handler), calls the service, serializes. */
export function createListingsController({ prisma, now }: ListingsControllerDeps) {
  const listTypes: RequestHandler = async (_req, res) => {
    const types = await getListingTypes(prisma);
    res.json({ data: types.map(serializeListingType) });
  };

  const search: RequestHandler = async (req, res) => {
    const query = searchListingsQuerySchema.parse(req.query);
    const result = await searchListingsService(prisma, query, todayInKathmandu(now()));
    res.json(serializeSearchResult(result));
  };

  const detail: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const query = listingDetailQuerySchema.parse(req.query);
    const result = await getListingDetailService(prisma, id, query, todayInKathmandu(now()));
    res.json(serializeListingDetail(result));
  };

  return { listTypes, search, detail };
}
