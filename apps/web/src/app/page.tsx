import { Suspense } from "react";
import { SystemStatus, SystemStatusSkeleton } from "@/components/system-status";

/**
 * Phase 1 placeholder landing page. The real home page is built later from the
 * owner's design references; the status panel then moves to an internal page.
 */
export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-20">
      <section className="max-w-2xl">
        <p className="text-sm font-semibold tracking-wide text-brand-700 uppercase">Coming soon</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Find your stay anywhere in Nepal
        </h1>
        <p className="mt-4 text-lg text-pretty text-slate-600">
          Hotels, guesthouses and homestays, from Kathmandu to Pokhara and beyond. MeroStay is being
          built.
        </p>
      </section>

      <section
        aria-labelledby="system-status-heading"
        className="mt-12 max-w-md rounded-xl border border-slate-200 p-5 shadow-sm"
      >
        <h2 id="system-status-heading" className="text-base font-semibold">
          System status
        </h2>
        <Suspense fallback={<SystemStatusSkeleton />}>
          <SystemStatus />
        </Suspense>
      </section>
    </div>
  );
}
