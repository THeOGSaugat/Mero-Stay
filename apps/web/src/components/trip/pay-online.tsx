"use client";

import { useState } from "react";
import { apiRequest, describeApiError } from "@/lib/api-client";
import type { Trip } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import {
  checkoutStep,
  ONLINE_GATEWAYS,
  type CheckoutInstruction,
  type OnlineGateway,
} from "@/lib/payment-flow";
import { useAuth } from "../auth/auth-provider";
import { Alert, buttonPrimary } from "../ui/primitives";

/**
 * "Pay online" on a confirmed trip (ADR 0017): the customer picks eSewa or Khalti; the API starts
 * the payment for exactly what is due and returns the checkout (eSewa: a signed form; Khalti: a
 * payment page). The browser goes there; the gateway sends it back to /payments/… afterwards.
 */
export function PayOnline({ trip }: { trip: Trip }) {
  const { state } = useAuth();
  const csrfToken = state.status === "authenticated" ? state.csrfToken : null;
  const [gateway, setGateway] = useState<OnlineGateway>("esewa");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = formatMoney(trip.onlinePayment.dueMinor, trip.currency, trip.currencyExponent);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const body = await apiRequest<{ data: { checkout: CheckoutInstruction | null } }>(
        `/trips/${encodeURIComponent(trip.id)}/payments/intent`,
        { method: "POST", body: { gateway }, csrfToken },
      );
      const step = checkoutStep(body.data.checkout);
      if (!step) throw new Error("no checkout");
      if (step.kind === "redirect") {
        window.location.assign(step.url);
        return;
      }
      // eSewa: POST the signed form (built by the API) to eSewa, as a normal page navigation.
      const form = document.createElement("form");
      form.method = "POST";
      form.action = step.url;
      form.hidden = true;
      for (const [name, value] of step.fields) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }
      document.body.append(form);
      form.submit();
    } catch (err) {
      setError(describeApiError(err));
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="pay-online-heading"
      className="rounded-xl border border-mist bg-white p-4 shadow-sm"
    >
      <h2 id="pay-online-heading" className="font-semibold text-navy">
        Pay online
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Due online now: <span className="font-semibold text-ink">{due}</span>. You will be sent to
        the payment gateway and back here when you are done.
      </p>
      <fieldset className="mt-3">
        <legend className="text-sm font-medium text-ink">Pay with</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {ONLINE_GATEWAYS.map((g) => (
            <label
              key={g.id}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-mist px-3 py-2 text-sm has-checked:border-navy"
            >
              <input
                type="radio"
                name="gateway"
                value={g.id}
                checked={gateway === g.id}
                onChange={() => setGateway(g.id)}
                disabled={busy}
              />
              {g.label}
            </label>
          ))}
        </div>
      </fieldset>
      {error ? (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <button
        type="button"
        className={`${buttonPrimary} mt-4`}
        onClick={() => void pay()}
        disabled={busy || !csrfToken}
      >
        {busy
          ? "Opening the payment page…"
          : `Pay ${due} with ${ONLINE_GATEWAYS.find((g) => g.id === gateway)?.label ?? ""}`}
      </button>
    </section>
  );
}
