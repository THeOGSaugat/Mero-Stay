import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingDetailView } from "@/components/partner/bookings-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Booking" };

export default function PartnerBookingPage() {
  return (
    <>
      <PageHeading title="Booking" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <BookingDetailView />
      </Suspense>
    </>
  );
}
