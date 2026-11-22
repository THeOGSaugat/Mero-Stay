"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { apiRequest } from "@/lib/api-client";
import type { SessionPayload } from "@/lib/api-types";
import { authReducer, INITIAL_AUTH_STATE, type AuthState } from "@/lib/auth-state";

/**
 * Who is logged in (ADR 0010). Hydrated from GET /api/v1/auth/me on load. The session cookie is
 * httpOnly (JavaScript never reads it); the CSRF token for writes is kept in memory only.
 */

interface AuthContextValue {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    fullName: string;
    email: string;
    password: string;
    phone?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-reads the session (e.g. after a 401 or a CSRF error). */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, INITIAL_AUTH_STATE);

  const refresh = useCallback(async () => {
    try {
      const body = await apiRequest<{ data: SessionPayload }>("/auth/me");
      dispatch({ type: "session", session: body.data });
    } catch {
      // 401 = not logged in. If the API is unreachable, the app also behaves as logged out;
      // the pages that need the API show their own error.
      dispatch({ type: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const body = await apiRequest<{ data: SessionPayload }>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    dispatch({ type: "session", session: body.data });
  }, []);

  const register = useCallback(
    async (input: { fullName: string; email: string; password: string; phone?: string }) => {
      const body = await apiRequest<{ data: SessionPayload }>("/auth/register", {
        method: "POST",
        body: input.phone
          ? input
          : { fullName: input.fullName, email: input.email, password: input.password },
      });
      dispatch({ type: "session", session: body.data });
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await apiRequest("/auth/logout", { method: "POST", csrfToken: state.csrfToken });
    } finally {
      dispatch({ type: "anonymous" });
    }
  }, [state.csrfToken]);

  const value = useMemo(
    () => ({ state, login, register, logout, refresh }),
    [state, login, register, logout, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
