"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiRequest, type ApiRequest } from "@/lib/api-client";
import { partnerAccess, partnerErrorView, providerHeaders } from "@/lib/partner-access";
import type { PartnerProfile } from "@/lib/partner-types";
import { useAuth } from "../auth/auth-provider";
import { Alert, buttonPrimary, buttonSecondary } from "../ui/primitives";

/**
 * The partner area's context (Phase 7 Track B, ADR 0011).
 *
 * - Every call goes to `/api/v1/partner…` on the web origin with the session cookie, the CSRF
 *   token on writes and, when the partner manages several businesses, `X-Provider-Id`.
 * - The API scopes everything to that provider; another provider's data is a 404. The UI never
 *   filters or hides data for security; it shows what the API returns.
 * - The chosen provider lives in memory (React state) only, like the CSRF token.
 */

interface PartnerContextValue {
  profile: PartnerProfile;
  /** Calls `/partner${path}` for the current provider. */
  request: <T>(path: string, options?: Omit<ApiRequest, "csrfToken">) => Promise<T>;
  /** Re-reads the profile (after a change elsewhere on the page). */
  reloadProfile: () => Promise<void>;
  setProfile: (profile: PartnerProfile) => void;
}

const PartnerContext = createContext<PartnerContextValue | null>(null);

type Load =
  | { status: "loading" }
  | { status: "ready"; profile: PartnerProfile }
  | { status: "choose"; choices: { id: string; name: string }[] }
  | { status: "onboard" }
  | { status: "error"; message: string };

function PartnerProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const csrfToken = state.csrfToken;
  const [providerId, setProviderId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const request = useCallback(
    <T,>(path: string, options: Omit<ApiRequest, "csrfToken"> = {}) =>
      apiRequest<T>(`/partner${path}`, {
        ...options,
        csrfToken,
        headers: { ...providerHeaders(providerId), ...options.headers },
      }),
    [csrfToken, providerId],
  );

  const loadProfile = useCallback(async (): Promise<Load> => {
    try {
      const body = await request<{ data: PartnerProfile }>("/profile");
      return { status: "ready", profile: body.data };
    } catch (err) {
      const view = partnerErrorView(err);
      if (view.kind === "choose-provider") {
        // Names for the choice: each provider's own profile (all of them are the user's own).
        const choices = await Promise.all(
          view.providerIds.map(async (id) => {
            try {
              const body = await apiRequest<{ data: PartnerProfile }>("/partner/profile", {
                headers: providerHeaders(id),
              });
              return { id, name: body.data.displayName };
            } catch {
              return { id, name: "Business" };
            }
          }),
        );
        return { status: "choose", choices };
      }
      if (view.kind === "onboard") return { status: "onboard" };
      return {
        status: "error",
        message: view.kind === "message" ? view.message : "The partner area is not available.",
      };
    }
  }, [request]);

  useEffect(() => {
    let cancelled = false;
    void loadProfile().then((next) => {
      if (!cancelled) setLoad(next);
    });
    return () => {
      cancelled = true;
    };
  }, [loadProfile]);

  const reloadProfile = useCallback(async () => {
    setLoad(await loadProfile());
  }, [loadProfile]);

  const setProfile = useCallback((profile: PartnerProfile) => {
    setLoad({ status: "ready", profile });
  }, []);

  const value = useMemo(
    () =>
      load.status === "ready"
        ? { profile: load.profile, request, reloadProfile, setProfile }
        : null,
    [load, request, reloadProfile, setProfile],
  );

  if (load.status === "loading") {
    return <p className="py-6 text-sm text-slate-600">Loading your business…</p>;
  }
  if (load.status === "choose") {
    return (
      <section aria-labelledby="choose-business" className="space-y-4">
        <h2 id="choose-business" className="text-lg font-semibold text-navy">
          Which business do you want to manage?
        </h2>
        <ul className="flex flex-wrap gap-3">
          {load.choices.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                className={buttonSecondary}
                onClick={() => {
                  setLoad({ status: "loading" });
                  setProviderId(choice.id);
                }}
              >
                {choice.name}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (load.status === "onboard") {
    return (
      <div className="space-y-4">
        <Alert tone="info">Set up your business to start listing on MeroStay.</Alert>
        <Link href="/partner/onboarding" className={buttonPrimary}>
          Set up your business
        </Link>
      </div>
    );
  }
  if (load.status === "error" || !value) {
    return <Alert>{load.status === "error" ? load.message : "Something went wrong."}</Alert>;
  }
  return <PartnerContext.Provider value={value}>{children}</PartnerContext.Provider>;
}

export function usePartner(): PartnerContextValue {
  const value = useContext(PartnerContext);
  if (!value) throw new Error("usePartner must be used inside the partner area");
  return value;
}

/**
 * Lets only partner accounts into the dashboard. Navigation convenience, not security: the API
 * answers 403 to every other role for every /partner URL.
 */
export function PartnerGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const access = partnerAccess(state);
  if (access === "become-partner") {
    return (
      <div className="space-y-4">
        <Alert tone="info">
          The partner area is for hotels, homestays, bus operators, guides and tour operators who
          list on MeroStay.
        </Alert>
        <Link href="/partner/onboarding" className={buttonPrimary}>
          List your business
        </Link>
      </div>
    );
  }
  if (access === "not-for-admins") {
    return <Alert>Admin accounts can&apos;t use the partner area.</Alert>;
  }
  if (access !== "partner") {
    return <p className="py-6 text-sm text-slate-600">Loading your account…</p>;
  }
  return <PartnerProvider>{children}</PartnerProvider>;
}
