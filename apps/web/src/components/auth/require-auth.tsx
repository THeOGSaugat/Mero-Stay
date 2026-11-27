"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { loginHref } from "@/lib/auth-state";
import { useAuth } from "./auth-provider";

/**
 * Shows its children only to a logged-in user; anyone else is sent to /login and brought back
 * afterwards. This is navigation convenience, NOT security: the API refuses unauthenticated
 * requests (401) and other users' trips (404) on its own.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  useEffect(() => {
    if (state.status === "anonymous") {
      const query = search.toString();
      router.replace(loginHref(query ? `${pathname}?${query}` : pathname));
    }
  }, [state.status, router, pathname, search]);

  if (state.status !== "authenticated") {
    return (
      <p className="py-8 text-sm text-muted" aria-live="polite">
        {state.status === "loading" ? "Loading your account…" : "Redirecting to log in…"}
      </p>
    );
  }
  return <>{children}</>;
}
