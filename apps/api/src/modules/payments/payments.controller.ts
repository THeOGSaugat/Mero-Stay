import type { RequestHandler } from "express";
import { idParamsSchema } from "../../lib/validation.js";
import { currentUser } from "../auth/auth-context.js";
import {
  confirmPaymentBodySchema,
  createIntentBodySchema,
  paymentParamsSchema,
} from "./payments.schemas.js";
import {
  serializeConfirmation,
  serializeIntent,
  serializePaymentList,
} from "./payments.serializers.js";
import type { PaymentsService } from "./payments.service.js";

/** Customer payment endpoints: always the LOGGED-IN user's own trip (404 otherwise). */
export function createPaymentsController(service: PaymentsService) {
  const createIntent: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    createIntentBodySchema.parse(req.body ?? {});
    const intent = await service.createIntent(id, currentUser(req).id);
    res
      .status(intent.created ? 201 : 200)
      .location(`/api/v1/trips/${id}/payments/${intent.payment.id}`)
      .json(serializeIntent(intent));
  };

  const confirm: RequestHandler = async (req, res) => {
    const { id, paymentId } = paymentParamsSchema.parse(req.params);
    const body = confirmPaymentBodySchema.parse(req.body ?? {});
    const confirmation = await service.confirmPayment(id, currentUser(req).id, paymentId, body);
    res.json(serializeConfirmation(confirmation));
  };

  const list: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { currency, payments } = await service.listPayments(id, currentUser(req).id);
    res.json(serializePaymentList(currency, payments));
  };

  return { createIntent, confirm, list };
}
