import { Suspense } from "react";
import { AdminGate } from "@/components/admin/admin-ui";
import { RequireAuth } from "@/components/auth/require-auth";

/**
 * The admin console (Phase 7 Track C, ADR 0012). Client-rendered behind the login and role gate;
 * a logged-in non-admin sees "Page not found". The API refuses every /admin call with 403 anyway.
 */
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <Suspense fallback={<p className="text-sm text-slate-600">Loading…</p>}>
        <RequireAuth>
          <AdminGate>{children}</AdminGate>
        </RequireAuth>
      </Suspense>
    </div>
  );
}
