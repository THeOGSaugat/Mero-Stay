import { isExpired } from "./trips-client";

/**
 * Paying online with eSewa or Khalti (ADR 0017). The API computes every amount and signs eSewa's
 * form; the browser only carries out the checkout it is given and later hands the gateway's
 * answer back to the API, which verifies it server to server. Nothing here decides "paid".
 */

export const ONLINE_GATEWAYS = [
  { id: "esewa", label: "eSewa" },
  { id: "khalti", label: "Khalti" },
] as const;
export type OnlineGateway = (typeof ONLINE_GATEWAYS)[number]["id"];

export function isOnlineGateway(value: string): value is OnlineGateway {
  return ONLINE_GATEWAYS.some((g) => g.id === value);
}

export function gatewayLabel(gateway: string): string {
  return ONLINE_GATEWAYS.find((g) => g.id === gateway)?.label ?? gateway;
}

/** What POST /trips/:id/payments/intent returns as `checkout`. */
export type CheckoutInstruction =
  | { type: "form"; method: "POST"; url: string; fields: Record<string, string> }
  | { type: "redirect"; url: string }
  | { type: "simulated" };

export type CheckoutStep =
  { kind: "form"; url: string; fields: [string, string][] } | { kind: "redirect"; url: string };

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** The browser step for a checkout, or null if it is not one we can follow (never a script URL). */
export function checkoutStep(
  checkout: CheckoutInstruction | null | undefined,
): CheckoutStep | null {
  if (!checkout) return null;
  if (checkout.type === "form" && checkout.method === "POST" && isWebUrl(checkout.url)) {
    return {
      kind: "form",
      url: checkout.url,
      fields: Object.entries(checkout.fields).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    };
  }
  if (checkout.type === "redirect" && isWebUrl(checkout.url)) {
    return { kind: "redirect", url: checkout.url };
  }
  return null;
}

/** Online payment can start: the trip waits for payment, its hold is live and something is due. */
export function canPayOnline(
  trip: { status: string; expiresAt: string | null; onlinePayment: { dueMinor: string } },
  now: Date = new Date(),
): boolean {
  return (
    trip.status === "PENDING" &&
    !isExpired(trip, now) &&
    /^[1-9]\d*$/.test(trip.onlinePayment.dueMinor)
  );
}

/**
 * The body for POST /payment-callbacks/:gateway from the return page's query string: eSewa's
 * signed `data`, or Khalti's `pidx`. Khalti's other parameters (status, amount) are not sent:
 * the API never trusts them.
 */
export function callbackBody(
  gateway: OnlineGateway,
  paymentId: string,
  query: URLSearchParams,
): Record<string, string> {
  const name = gateway === "esewa" ? "data" : "pidx";
  const value = query.get(name);
  return value ? { paymentId, [name]: value } : { paymentId };
}

export interface PaymentOutcomeView {
  tone: "success" | "info" | "error";
  title: string;
  text: string;
}

/** What the customer is told after the API checked the payment with the gateway. */
export function outcomeView(outcome: string): PaymentOutcomeView {
  switch (outcome) {
    case "paid":
    case "replayed":
      return {
        tone: "success",
        title: "Payment received",
        text: "Your payment was confirmed with the gateway. Your trip is updated.",
      };
    case "pending":
      return {
        tone: "info",
        title: "Payment not confirmed yet",
        text: "The gateway has not confirmed this payment yet. Check again in a moment from your trip.",
      };
    case "reconciliation":
      return {
        tone: "info",
        title: "Payment received, needs a check",
        text: "We received your money but could not apply it to this trip (for example, its hold had expired). MeroStay will contact you; nothing is lost.",
      };
    case "expired":
    case "failed":
    default:
      return {
        tone: "error",
        title: "Payment not completed",
        text: "The payment was not completed. You have not been charged by MeroStay. You can try again from your trip while its hold lasts.",
      };
  }
}
