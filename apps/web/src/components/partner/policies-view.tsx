"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { CancellationTerms } from "@/components/ui/cancellation-terms";
import {
  draftFromTiers,
  policySummary,
  tiersFromDraft,
  type TierDraft,
} from "@/lib/cancellation-policy";
import { describePartnerError } from "@/lib/partner-access";
import type { CancellationPolicy, ManagedListing, PolicyList } from "@/lib/partner-types";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { usePartner } from "./partner-context";
import { Panel, PartnerError, usePartnerData } from "./partner-ui";

/**
 * /partner/cancellation-policies (ADR 0015, gap 23): the business's own policies, which one is
 * the default for listings without their own, and a form to add or edit one. Policies are data
 * the partner writes (no MeroStay presets); the API checks every rule again.
 */
export function PoliciesView() {
  const { request } = usePartner();
  const { data, error, reload } = usePartnerData<{ data: PolicyList }>("/cancellation-policies");
  const [editing, setEditing] = useState<CancellationPolicy | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <PartnerError view={error} backHref="/partner" backLabel="Back to overview" />;
  if (!data) return <p className="text-sm text-muted">Loading policies…</p>;
  const { policies, defaultPolicyId } = data.data;
  const active = policies.filter((p) => p.isActive);

  async function act(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      reload();
    } catch (err) {
      setActionError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {actionError ? <Alert>{actionError}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Panel title="Default policy">
        <p className="text-sm text-muted">
          Used for every listing that has no policy of its own. A listing&apos;s own policy always
          wins.
        </p>
        {defaultPolicyId === null ? (
          <div className="mt-3" data-testid="no-default-policy">
            <Alert tone="info">
              No default policy is set: listings without their own policy show customers that no
              cancellation policy applies.
            </Alert>
          </div>
        ) : null}
        <label className={`${labelClass} mt-3`}>
          Default for your listings
          <select
            className={inputClass}
            value={defaultPolicyId ?? ""}
            disabled={busy}
            onChange={(e) =>
              void act(
                () =>
                  request("/cancellation-policies/default", {
                    method: "PUT",
                    body: { policyId: e.target.value || null },
                  }),
                "Default policy saved.",
              )
            }
          >
            <option value="">No default policy</option>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </Panel>

      <Panel
        title="Your policies"
        actions={
          editing === null ? (
            <button type="button" className={buttonSecondary} onClick={() => setEditing("new")}>
              Add a policy
            </button>
          ) : null
        }
      >
        {editing !== null ? (
          <PolicyForm
            policy={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(message) => {
              setEditing(null);
              setNotice(message);
              reload();
            }}
          />
        ) : null}
        {policies.length === 0 && editing === null ? (
          <p className="text-sm text-muted" data-testid="no-policies">
            You have no cancellation policies yet. Add one so customers know their terms.
          </p>
        ) : null}
        <ul className="mt-3 space-y-3" data-testid="policy-list">
          {policies.map((p) => (
            <li
              key={p.id}
              className="rounded-control border border-line p-3"
              data-testid="policy-row"
              data-policy={p.id}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium text-primary">{p.name}</p>
                <div className="flex flex-wrap gap-2">
                  {p.usage?.providerDefault ? <StatusPill label="Default" tone="good" /> : null}
                  <StatusPill
                    label={p.isActive ? "On" : "Off"}
                    tone={p.isActive ? "good" : "neutral"}
                  />
                </div>
              </div>
              <p className="mt-1 text-sm text-ink">{policySummary(p)}</p>
              <p className="mt-1 text-xs text-slate-500">
                Used by {p.usage?.listings ?? 0} listing{p.usage?.listings === 1 ? "" : "s"}
                {p.usage?.providerDefault ? " and as your default" : ""}.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={busy}
                  onClick={() => setEditing(p)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () =>
                        request(`/cancellation-policies/${p.id}`, {
                          method: "PATCH",
                          body: { isActive: !p.isActive },
                        }),
                      p.isActive ? "Policy switched off." : "Policy switched on.",
                    )
                  }
                >
                  {p.isActive ? "Switch off" : "Switch on"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

/** Add or edit one policy: name, optional description, non-refundable or refund tiers. */
function PolicyForm({
  policy,
  onCancel,
  onSaved,
}: {
  policy: CancellationPolicy | null;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const { request } = usePartner();
  const [nonRefundable, setNonRefundable] = useState(policy?.nonRefundable ?? false);
  const [rows, setRows] = useState<TierDraft[]>(
    policy && policy.rules.length > 0
      ? draftFromTiers(policy.rules)
      : [{ hours: "48", percent: "100" }],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => `policy-${crypto.randomUUID()}`);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    if (!name) return setProblem("Give the policy a name.");
    const tiers = nonRefundable ? { ok: true as const, tiers: [] } : tiersFromDraft(rows);
    if (!tiers.ok) return setProblem(tiers.message);
    setProblem(null);
    setBusy(true);
    try {
      const body = { name, description, nonRefundable, rules: tiers.tiers };
      if (policy) {
        await request(`/cancellation-policies/${policy.id}`, { method: "PATCH", body });
        onSaved("Policy saved. Existing bookings keep the terms they were booked with.");
      } else {
        await request("/cancellation-policies", {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body,
        });
        onSaved("Policy added.");
      }
    } catch (err) {
      setProblem(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  const setRow = (i: number, patch: Partial<TierDraft>) =>
    setRows((current) => current.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-control border border-primary-light/40 bg-surface/40 p-3"
      data-testid="policy-form"
    >
      {problem ? <Alert>{problem}</Alert> : null}
      <label className={labelClass}>
        Name
        <input
          name="name"
          className={inputClass}
          defaultValue={policy?.name ?? ""}
          maxLength={120}
          required
        />
      </label>
      <label className={labelClass}>
        Description (optional)
        <textarea
          name="description"
          className={inputClass}
          defaultValue={policy?.description ?? ""}
          maxLength={1000}
          rows={2}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          name="nonRefundable"
          checked={nonRefundable}
          onChange={(e) => setNonRefundable(e.target.checked)}
        />
        Non-refundable (no refund at any time)
      </label>
      {!nonRefundable ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">
            Refund tiers (most notice first; a 100% first tier is free cancellation)
          </legend>
          {rows.map((row, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2" data-testid="tier-row">
              <label className={labelClass}>
                At least (hours before the start)
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={row.hours}
                  onChange={(e) => setRow(i, { hours: e.target.value })}
                  aria-label={`Tier ${i + 1} hours before the start`}
                />
              </label>
              <label className={labelClass}>
                Refund (%)
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={row.percent}
                  onChange={(e) => setRow(i, { percent: e.target.value })}
                  aria-label={`Tier ${i + 1} refund percent`}
                />
              </label>
              {rows.length > 1 ? (
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => setRows((current) => current.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {rows.length < 10 ? (
            <button
              type="button"
              className={buttonSecondary}
              onClick={() => setRows((current) => [...current, { hours: "", percent: "" }])}
            >
              Add a tier
            </button>
          ) : null}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonPrimary} disabled={busy}>
          {busy ? "Saving…" : policy ? "Save policy" : "Add policy"}
        </button>
        <button type="button" className={buttonSecondary} onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The cancellation policy of one bookable listing: its own, the default, or none (with a
 * warning: booking is not blocked, but customers are told no policy applies).
 */
export function ListingPolicyPanel({
  listing,
  onSaved,
}: {
  listing: ManagedListing;
  onSaved: (listing: ManagedListing) => void;
}) {
  const { request } = usePartner();
  const { data } = usePartnerData<{ data: PolicyList }>("/cancellation-policies");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const { policies, defaultPolicyId } = data.data;
  const own = policies.find((p) => p.id === listing.defaultCancellationPolicyId) ?? null;
  const fallback = policies.find((p) => p.id === defaultPolicyId) ?? null;
  const effective = own ?? fallback;

  async function choose(policyId: string) {
    setBusy(true);
    setError(null);
    try {
      const saved = await request<{ data: ManagedListing }>(`/listings/${listing.id}`, {
        method: "PATCH",
        body: { defaultCancellationPolicyId: policyId || null },
      });
      onSaved(saved.data);
    } catch (err) {
      setError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Cancellation policy">
      {error ? <Alert>{error}</Alert> : null}
      {effective === null ? (
        <div data-testid="no-policy-warning">
          <Alert tone="info">
            No cancellation policy set: customers will see that none applies. Choose one below, or{" "}
            <Link href="/partner/cancellation-policies" className="underline">
              add a policy
            </Link>
            .
          </Alert>
        </div>
      ) : null}
      <label className={`${labelClass} mt-3`}>
        Policy for this listing
        <select
          className={inputClass}
          value={listing.defaultCancellationPolicyId ?? ""}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
          data-testid="listing-policy-select"
        >
          <option value="">
            {fallback ? `Use my default (${fallback.name})` : "No policy (none applies)"}
          </option>
          {policies
            .filter((p) => p.isActive || p.id === listing.defaultCancellationPolicyId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      {effective ? (
        <div className="mt-3">
          <CancellationTerms
            terms={{ ...effective, source: own ? "listing" : "provider" }}
            context="listing"
            headingLevel={3}
          />
        </div>
      ) : null}
    </Panel>
  );
}
