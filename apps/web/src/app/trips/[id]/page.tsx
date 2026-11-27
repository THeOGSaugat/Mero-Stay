import type { Metadata } from "next";
import { Suspense } from "react";
import { RequireAuth } from "@/components/auth/require-auth";
import { TripDetail } from "@/components/trip/trip-history";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Trip" };

export default function TripDetailPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeading title="Trip details" />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <RequireAuth>
          <TripDetail />
        </RequireAuth>
      </Suspense>
    </div>
  );
}
