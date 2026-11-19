import type { RequestHandler } from "express";
import { idParamsSchema } from "../../lib/validation.js";
import {
  addItemBodySchema,
  createTripBodySchema,
  quoteBodySchema,
  tripItemParamsSchema,
  updateItemBodySchema,
} from "./trips.schemas.js";
import { serializeQuote, serializeTrip } from "./trips.serializers.js";
import type { TripsService } from "./trips.service.js";

/** Validates input (Zod → 400), calls the service, serializes (money → strings). */
export function createTripsController(service: TripsService) {
  const create: RequestHandler = async (req, res) => {
    const body = createTripBodySchema.parse(req.body ?? {});
    const trip = await service.createTrip(body);
    res.status(201).location(`/api/v1/trips/${trip.id}`).json(serializeTrip(trip));
  };

  const get: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(serializeTrip(await service.getTrip(id)));
  };

  const addItem: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = addItemBodySchema.parse(req.body ?? {});
    const { trip, itemId } = await service.addItem(id, body);
    res.status(201).location(`/api/v1/trips/${id}/items/${itemId}`).json(serializeTrip(trip));
  };

  const updateItem: RequestHandler = async (req, res) => {
    const { id, itemId } = tripItemParamsSchema.parse(req.params);
    const body = updateItemBodySchema.parse(req.body ?? {});
    res.json(serializeTrip(await service.updateItem(id, itemId, body)));
  };

  const removeItem: RequestHandler = async (req, res) => {
    const { id, itemId } = tripItemParamsSchema.parse(req.params);
    res.json(serializeTrip(await service.removeItem(id, itemId)));
  };

  const quote: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = quoteBodySchema.parse(req.body ?? {});
    res.json(serializeQuote(await service.quote(id, body.items)));
  };

  const confirm: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(serializeTrip(await service.confirm(id)));
  };

  return { create, get, addItem, updateItem, removeItem, quote, confirm };
}
