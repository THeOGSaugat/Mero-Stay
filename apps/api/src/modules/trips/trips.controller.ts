import type { RequestHandler } from "express";
import { idParamsSchema } from "../../lib/validation.js";
import { currentUser } from "../auth/auth-context.js";
import {
  addItemBodySchema,
  createTripBodySchema,
  listTripsQuerySchema,
  quoteBodySchema,
  tripItemParamsSchema,
  updateItemBodySchema,
} from "./trips.schemas.js";
import { serializeQuote, serializeTrip, serializeTripList } from "./trips.serializers.js";
import type { TripsService } from "./trips.service.js";

/**
 * Validates input (Zod → 400), calls the service with the LOGGED-IN user as owner, serializes the
 * customer view (money → strings, no commission/payout fields).
 */
export function createTripsController(service: TripsService) {
  const create: RequestHandler = async (req, res) => {
    const body = createTripBodySchema.parse(req.body ?? {});
    const trip = await service.createTrip(currentUser(req).id, body);
    res.status(201).location(`/api/v1/trips/${trip.id}`).json(serializeTrip(trip));
  };

  const list: RequestHandler = async (req, res) => {
    const query = listTripsQuerySchema.parse(req.query);
    res.json(serializeTripList(await service.listTrips(currentUser(req).id, query)));
  };

  const get: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(serializeTrip(await service.getTrip(id, currentUser(req).id)));
  };

  const addItem: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = addItemBodySchema.parse(req.body ?? {});
    const { trip, itemId } = await service.addItem(id, currentUser(req).id, body);
    res.status(201).location(`/api/v1/trips/${id}/items/${itemId}`).json(serializeTrip(trip));
  };

  const updateItem: RequestHandler = async (req, res) => {
    const { id, itemId } = tripItemParamsSchema.parse(req.params);
    const body = updateItemBodySchema.parse(req.body ?? {});
    res.json(serializeTrip(await service.updateItem(id, currentUser(req).id, itemId, body)));
  };

  const removeItem: RequestHandler = async (req, res) => {
    const { id, itemId } = tripItemParamsSchema.parse(req.params);
    res.json(serializeTrip(await service.removeItem(id, currentUser(req).id, itemId)));
  };

  const quote: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const body = quoteBodySchema.parse(req.body ?? {});
    res.json(serializeQuote(await service.quote(id, currentUser(req).id, body.items)));
  };

  const confirm: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    res.json(serializeTrip(await service.confirm(id, currentUser(req).id)));
  };

  return { create, list, get, addItem, updateItem, removeItem, quote, confirm };
}
