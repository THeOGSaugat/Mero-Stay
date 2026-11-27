import type { Metadata } from "next";
import { Suspense } from "react";
import { RegisterForm } from "@/components/auth/auth-forms";
import { PageHeading } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Create an account" };

export default function RegisterPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10 sm:px-6">
      <PageHeading title="Create an account" subtitle="One account for stays, buses and guides." />
      <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
        <RegisterForm />
      </Suspense>
    </div>
  );
}
