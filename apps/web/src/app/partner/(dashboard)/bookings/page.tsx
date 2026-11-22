import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingList } from "@/components/partner/bookings-view";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Bookings" };

export default function PartnerBookingsPage() {
  return (
    <>
      <PageHeading title="Bookings" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <BookingList />
      </Suspense>
    </>
  );
}
