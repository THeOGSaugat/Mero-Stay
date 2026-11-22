import type { Metadata } from "next";
import { Suspense } from "react";
import { RequireAuth } from "@/components/auth/require-auth";
import { TripList } from "@/components/trip/trip-history";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Your trips" };

export default function TripsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeading title="Your trips" />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <RequireAuth>
          <TripList />
        </RequireAuth>
      </Suspense>
    </div>
  );
}
