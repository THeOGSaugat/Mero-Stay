"use client";

import { useState, type FormEvent } from "react";
import { describeAdminError } from "@/lib/admin-access";
import { adminAccountLabel, setupUrl, type AdminAccount, type SetupLink } from "@/lib/admin-ops";
import { formatTimestamp } from "@/lib/partner-display";
import { useAuth } from "../auth/auth-provider";
import { tableClass, tdClass, thClass } from "../ui/data";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { AdminError, useAdminData, useAdminRequest } from "./admin-ui";

/**
 * Admin accounts (Phase 12, gap 9, ADR 0018). A new admin gets a one-time setup link (24 h),
 * shown here ONCE: hand it over in person or by phone (MeroStay sends no email yet). The new
 * admin chooses their own password. You cannot suspend yourself or the last active admin.
 */
export function AdminAccounts() {
  const { data, error, reload } = useAdminData<{ data: AdminAccount[] }>("/admins");
  const request = useAdminRequest();
  const { state } = useAuth();
  const me = state.status === "authenticated" ? state.user.id : null;
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [link, setLink] = useState<{ for: string; link: SetupLink } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setProblem(null);
    try {
      return await fn();
    } catch (err) {
      setProblem(describeAdminError(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const body = await run(() =>
      request<{ data: { admin: AdminAccount; setupLink: SetupLink } }>("/admins", {
        method: "POST",
        body: { email: email.trim(), fullName: fullName.trim() },
      }),
    );
    if (body) {
      setLink({
        for: body.data.admin.email ?? body.data.admin.fullName,
        link: body.data.setupLink,
      });
      setEmail("");
      setFullName("");
      reload();
    }
  }

  async function reissue(admin: AdminAccount) {
    const body = await run(() =>
      request<{ data: { setupLink: SetupLink } }>(`/admins/${admin.id}/setup-link`, {
        method: "POST",
      }),
    );
    if (body) setLink({ for: admin.email ?? admin.fullName, link: body.data.setupLink });
  }

  async function setStatus(admin: AdminAccount, action: "suspend" | "reactivate") {
    const body = await run(() => request(`/admins/${admin.id}/${action}`, { method: "POST" }));
    if (body) reload();
  }

  if (error) return <AdminError view={error} />;
  return (
    <div className="space-y-4">
      <form onSubmit={(e) => void create(e)} className="grid items-end gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Full name
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            maxLength={200}
            className={inputClass}
          />
        </label>
        <button type="submit" className={buttonPrimary} disabled={busy}>
          Add admin
        </button>
      </form>
      {link ? (
        <div data-testid="admin-setup-link">
          <Alert tone="success">
            <strong className="block">Setup link for {link.for} (shown once)</strong>
            <span className="break-all font-mono text-xs" data-testid="admin-setup-url">
              {setupUrl(window.location.origin, link.link)}
            </span>
            <span className="mt-1 block">
              Works once until {formatTimestamp(link.link.expiresAt)}. Hand it over in person or by
              phone; MeroStay does not email it yet.
            </span>
          </Alert>
        </div>
      ) : null}
      {problem ? <Alert>{problem}</Alert> : null}
      {!data ? (
        <p className="text-sm text-muted">Loading admins…</p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-white">
          <table className={tableClass} data-testid="admin-accounts">
            <thead>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Email</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Last login</th>
                <th className={thClass}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.data.map((admin) => (
                <tr key={admin.id} data-testid="admin-account-row" data-email={admin.email ?? ""}>
                  <td className={tdClass}>
                    {admin.fullName}
                    {admin.id === me ? " (you)" : ""}
                  </td>
                  <td className={tdClass}>{admin.email}</td>
                  <td className={tdClass}>
                    <StatusPill
                      label={adminAccountLabel(admin)}
                      tone={
                        admin.status === "SUSPENDED" ? "bad" : admin.setupPending ? "wait" : "good"
                      }
                    />
                  </td>
                  <td className={tdClass}>{formatTimestamp(admin.lastLoginAt)}</td>
                  <td className={`${tdClass} space-x-3 whitespace-nowrap`}>
                    {admin.setupPending && admin.status === "ACTIVE" ? (
                      <button
                        type="button"
                        className="text-sm font-semibold text-primary underline"
                        disabled={busy}
                        onClick={() => void reissue(admin)}
                      >
                        New setup link
                      </button>
                    ) : null}
                    {admin.id !== me ? (
                      <button
                        type="button"
                        className={buttonSecondary}
                        disabled={busy}
                        onClick={() =>
                          void setStatus(
                            admin,
                            admin.status === "ACTIVE" ? "suspend" : "reactivate",
                          )
                        }
                      >
                        {admin.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
