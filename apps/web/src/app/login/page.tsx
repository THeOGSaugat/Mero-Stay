import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/auth-forms";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:px-6">
      <PageHeading title="Log in" subtitle="Plan and book your trip across Nepal." />
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
