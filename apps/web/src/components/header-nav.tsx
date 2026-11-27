"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "./auth/auth-provider";

const link =
  "inline-flex min-h-10 items-center rounded-control px-3 py-1.5 text-sm font-medium text-white/90 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60";

/** Navigation that depends on whether someone is logged in. */
export function HeaderNav() {
  const { state, logout } = useAuth();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  async function onLogout() {
    setLeaving(true);
    // Leave the page first: on a protected page, the auth state turning "anonymous" would
    // otherwise send the person to /login instead of home.
    router.push("/");
    try {
      await logout();
    } finally {
      setLeaving(false);
    }
  }

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      <Link href="/search" className={link}>
        Search
      </Link>
      {state.status === "authenticated" ? (
        <>
          <Link href="/trip" className={link}>
            My trip
          </Link>
          <Link href="/trips" className={link}>
            Trips
          </Link>
          {state.user.role === "PARTNER" ? (
            <Link href="/partner" className={link}>
              Partner
            </Link>
          ) : null}
          {state.user.role === "ADMIN" ? (
            <Link href="/admin" className={link}>
              Admin
            </Link>
          ) : null}
          <span className="hidden px-2 text-sm text-white/80 sm:inline" data-testid="signed-in-as">
            {state.user.fullName}
          </span>
          <button type="button" onClick={onLogout} disabled={leaving} className={link}>
            Log out
          </button>
        </>
      ) : state.status === "anonymous" ? (
        <>
          <Link href="/login" className={`${link} ring-1 ring-white/60 ring-inset`}>
            Log in
          </Link>
          <Link
            href="/register"
            className="inline-flex min-h-10 items-center rounded-control bg-accent-strong px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sign up
          </Link>
        </>
      ) : null}
    </nav>
  );
}
