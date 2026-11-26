"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiRequest, describeApiError } from "@/lib/api-client";
import {
  callbackBody,
  gatewayLabel,
  isOnlineGateway,
  outcomeView,
  type PaymentOutcomeView,
} from "@/lib/payment-flow";
import { Alert, buttonSecondary } from "../ui/primitives";

/**
 * The page eSewa or Khalti sends the customer back to (ADR 0017). It hands what the gateway put
 * in the address (eSewa's signed `data`, Khalti's `pidx`) to the API, which verifies it with the
 * gateway server to server and answers with the outcome. Nothing is trusted from the address
 * itself; repeating the request (reload, back button) changes nothing.
 */
export function PaymentReturn() {
  const params = useParams<{ gateway: string; paymentId: string }>();
  const query = useSearchParams();
  const [view, setView] = useState<PaymentOutcomeView | null>(null);
  const [tripId, setTripId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const gateway = isOnlineGateway(params.gateway) ? params.gateway : null;

  useEffect(() => {
    if (!gateway || started.current) return;
    started.current = true;
    apiRequest<{ data: { outcome: string; tripId: string } }>(`/payment-callbacks/${gateway}`, {
      method: "POST",
      body: callbackBody(gateway, params.paymentId, new URLSearchParams(query)),
    })
      .then((body) => {
        setView(outcomeView(body.data.outcome));
        setTripId(body.data.tripId);
      })
      .catch((err: unknown) => setError(describeApiError(err)));
  }, [gateway, params.paymentId, query]);

  const tripLink = (
    <Link href={tripId ? `/trips/${tripId}` : "/trips"} className={buttonSecondary}>
      {tripId ? "Back to your trip" : "Your trips"}
    </Link>
  );

  const problem = gateway ? error : "Unknown payment method.";
  if (problem) {
    return (
      <div className="space-y-4">
        <Alert>{problem}</Alert>
        {tripLink}
      </div>
    );
  }
  if (!view) {
    return (
      <p className="text-sm text-slate-600" role="status">
        Checking your {gatewayLabel(params.gateway)} payment…
      </p>
    );
  }
  return (
    <div className="space-y-4" data-testid="payment-outcome">
      <Alert tone={view.tone}>
        <strong className="block">{view.title}</strong>
        {view.text}
      </Alert>
      {tripLink}
    </div>
  );
}
