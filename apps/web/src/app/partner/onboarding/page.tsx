import type { Metadata } from "next";
import { Suspense } from "react";
import { RequireAuth } from "@/components/auth/require-auth";
import { OnboardingForm } from "@/components/partner/onboarding-form";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "List your business" };

export default function PartnerOnboardingPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <PageHeading
        title="List your business on MeroStay"
        subtitle="Hotels, homestays, bus operators, guides and tour operators."
      />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <RequireAuth>
          <OnboardingForm />
        </RequireAuth>
      </Suspense>
    </div>
  );
}
