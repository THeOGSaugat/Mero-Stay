import type { Metadata } from "next";
import { Suspense } from "react";
import { PaymentReturn } from "@/components/payments/payment-return";
import { PageHeading } from "@/components/ui/primitives";

// The address carries the gateway's response: keep it out of Referer headers and search engines.
export const metadata: Metadata = {
  title: "Payment",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/** eSewa's failure_url (ADR 0017): the API asks eSewa what happened; nothing is assumed. */
export default function PaymentFailurePage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <PageHeading title="Payment" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <PaymentReturn />
      </Suspense>
    </div>
  );
}
