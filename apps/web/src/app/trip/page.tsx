import type { Metadata } from "next";
import { Suspense } from "react";
import { RequireAuth } from "@/components/auth/require-auth";
import { TripBuilder } from "@/components/trip/trip-builder";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "My trip" };

export default function TripPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageHeading title="My trip" subtitle="Everything you are booking, in one place." />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <RequireAuth>
          <TripBuilder />
        </RequireAuth>
      </Suspense>
    </div>
  );
}
