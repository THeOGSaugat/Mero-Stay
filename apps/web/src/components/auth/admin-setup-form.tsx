"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { apiRequest, ApiError, describeApiError } from "@/lib/api-client";
import { setupTokenFromHash } from "@/lib/admin-ops";
import { Alert, buttonPrimary, buttonSecondary, inputClass, labelClass } from "../ui/primitives";

/**
 * An invited admin chooses their password (Phase 12, gap 9, ADR 0018). The one-time token is in
 * the address's fragment (#token=…), which browsers never send to a server or in a Referer; it is
 * read only when the form is sent and removed from the address once used.
 */
export function AdminSetupForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(null);
    const token = setupTokenFromHash(window.location.hash);
    if (!token) {
      setProblem("This setup link is incomplete. Open the full link you were given.");
      return;
    }
    if (password !== confirm) {
      setProblem("The two passwords are different.");
      return;
    }
    setBusy(true);
    try {
      await apiRequest("/auth/admin-setup", { method: "POST", body: { token, password } });
      window.history.replaceState(null, "", window.location.pathname);
      setDone(true);
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.code === "SETUP_LINK_INVALID"
          ? "This setup link is invalid, already used or expired. Ask an admin for a new one."
          : describeApiError(err),
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4" data-testid="admin-setup-done">
        <Alert tone="success">
          Your password is set. Log in with your email and this password.
        </Alert>
        <Link href="/login?next=%2Fadmin" className={buttonSecondary}>
          Log in
        </Link>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <label className={labelClass}>
        New password (at least 12 characters)
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Repeat the password
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass}
        />
      </label>
      {problem ? <Alert>{problem}</Alert> : null}
      <button type="submit" className={buttonPrimary} disabled={busy}>
        {busy ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}
