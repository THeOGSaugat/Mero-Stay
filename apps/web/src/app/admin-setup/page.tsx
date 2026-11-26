import type { Metadata } from "next";
import { AdminSetupForm } from "@/components/auth/admin-setup-form";
import { PageHeading } from "@/components/ui/primitives";

// The address carries a one-time token: never indexed, never sent as a Referer.
export const metadata: Metadata = {
  title: "Set up your admin account",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/** Where an invited admin's one-time link lands (ADR 0018). No login needed. */
export default function AdminSetupPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-8 sm:px-6">
      <PageHeading
        title="Set up your admin account"
        subtitle="Choose the password you will log in with."
      />
      <AdminSetupForm />
    </div>
  );
}
