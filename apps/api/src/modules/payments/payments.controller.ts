import type { RequestHandler } from "express";
import { idParamsSchema } from "../../lib/validation.js";
import { currentUser } from "../auth/auth-context.js";
import {
  callbackParamsSchema,
  confirmPaymentBodySchema,
  createIntentBodySchema,
  esewaCallbackBodySchema,
  khaltiCallbackBodySchema,
  paymentParamsSchema,
} from "./payments.schemas.js";
import {
  serializeApplication,
  serializeConfirmation,
  serializeIntent,
  serializePaymentList,
} from "./payments.serializers.js";
import type { PaymentsService } from "./payments.service.js";

/** Customer payment endpoints: always the LOGGED-IN user's own trip (404 otherwise). */
export function createPaymentsController(service: PaymentsService) {
  const createIntent: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { gateway } = createIntentBodySchema.parse(req.body ?? {});
    const intent = await service.createIntent(id, currentUser(req).id, gateway);
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

  const refresh: RequestHandler = async (req, res) => {
    const { id, paymentId } = paymentParamsSchema.parse(req.params);
    res.json(
      serializeApplication(await service.refreshPayment(id, currentUser(req).id, paymentId)),
    );
  };

  const list: RequestHandler = async (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const { currency, payments } = await service.listPayments(id, currentUser(req).id);
    res.json(serializePaymentList(currency, payments));
  };

  /** No session: the gateway's own data is verified server-side (ADR 0017). */
  const callback: RequestHandler = async (req, res) => {
    const { gateway } = callbackParamsSchema.parse(req.params);
    const body =
      gateway === "esewa"
        ? esewaCallbackBodySchema.parse(req.body ?? {})
        : khaltiCallbackBodySchema.parse(req.body ?? {});
    const { paymentId, ...payload } = body;
    res.setHeader("Cache-Control", "no-store");
    res.json(serializeApplication(await service.handleCallback(gateway, paymentId, payload)));
  };

  return { createIntent, confirm, refresh, list, callback };
}
