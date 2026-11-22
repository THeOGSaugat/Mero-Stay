"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { describePartnerError } from "@/lib/partner-access";
import {
  bpsToPercentText,
  formatTimestamp,
  payoutAccountSummary,
  providerStatusLabel,
  safeMaskedAccountNumber,
} from "@/lib/partner-display";
import type { PartnerProfile } from "@/lib/partner-types";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { usePartner } from "./partner-context";
import { Facts, Panel } from "./partner-ui";

export function providerStatusTone(status: string): "good" | "wait" | "neutral" | "bad" {
  if (status === "VERIFIED") return "good";
  if (status === "PENDING_VERIFICATION" || status === "DRAFT") return "wait";
  if (status === "REJECTED" || status === "SUSPENDED") return "bad";
  return "neutral";
}

/** /partner: where the business stands and what to do next. */
export function PartnerOverview() {
  const { profile } = usePartner();
  const next =
    profile.status === "DRAFT" || profile.status === "REJECTED"
      ? { href: "/partner/verification", text: "Add your documents and submit for verification" }
      : !profile.payoutAccount
        ? { href: "/partner/profile", text: "Add a bank account for online payouts" }
        : { href: "/partner/listings", text: "Manage your listings and availability" };
  return (
    <div className="space-y-4">
      <Panel title={profile.displayName}>
        <div className="flex flex-wrap items-center gap-3">
          <StatusPill
            label={providerStatusLabel(profile.status)}
            tone={providerStatusTone(profile.status)}
          />
          <span className="text-sm text-slate-600">{profile.providerType.name}</span>
        </div>
        {profile.status === "REJECTED" && profile.rejectionReason ? (
          <div className="mt-3">
            <Alert>MeroStay asked for changes: {profile.rejectionReason}</Alert>
          </div>
        ) : null}
        <div className="mt-4">
          <Link href={next.href} className={buttonPrimary}>
            {next.text}
          </Link>
        </div>
      </Panel>
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { href: "/partner/bookings", title: "Bookings", text: "Upcoming and past bookings" },
          { href: "/partner/invoices", title: "Invoices", text: "MeroStay commission invoices" },
          { href: "/partner/payouts", title: "Payouts", text: "Online payments owed to you" },
        ].map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-xl border border-mist bg-white p-4 shadow-sm hover:border-teal focus-visible:outline-2 focus-visible:outline-teal"
          >
            <span className="block font-semibold text-navy">{card.title}</span>
            <span className="mt-1 block text-sm text-slate-600">{card.text}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * /partner/profile: business details, contact (editable any time), legal/tax (editable only
 * before verification: the API answers 409 PROVIDER_IDENTITY_LOCKED otherwise) and the payout
 * account, always shown masked. A new account number is sent once and never shown again.
 */
export function PartnerProfileView() {
  const { profile, request, setProfile } = usePartner();
  const [editing, setEditing] = useState<"contact" | "bank" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const identityEditable = profile.status === "DRAFT" || profile.status === "REJECTED";

  async function save(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await request<{ data: PartnerProfile }>("/profile", {
        method: "PATCH",
        body: patch,
      });
      setProfile(body.data);
      setEditing(null);
      setNotice(done);
    } catch (err) {
      setError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  function onContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? "").trim() || null;
    const patch: Record<string, unknown> = {
      displayName: String(form.get("displayName") ?? "").trim(),
      contactPhone: value("contactPhone"),
      contactEmail: value("contactEmail"),
      addressLine: value("addressLine"),
      description: value("description"),
    };
    if (identityEditable) {
      patch.legalName = String(form.get("legalName") ?? "").trim();
      patch.panNumber = value("panNumber");
      patch.vatNumber = value("vatNumber");
      patch.businessRegistrationNo = value("businessRegistrationNo");
    }
    void save(patch, "Business details saved.");
  }

  function onBank(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const accountNumber = text("accountNumber");
    // Clear the field at once: the number is not kept in the page after it is sent.
    event.currentTarget.reset();
    void save(
      {
        payoutAccount: {
          bankName: text("bankName"),
          branch: text("branch") || null,
          accountName: text("accountName"),
          accountNumber,
        },
      },
      "Payout account saved. MeroStay verifies new accounts before paying out.",
    );
  }

  const account = profile.payoutAccount;
  return (
    <div className="space-y-4">
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      <Panel
        title="Business details"
        actions={
          editing !== "contact" ? (
            <button type="button" className={buttonSecondary} onClick={() => setEditing("contact")}>
              Edit
            </button>
          ) : null
        }
      >
        {editing === "contact" ? (
          <form onSubmit={onContact} className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>
              Name shown to travellers
              <input
                name="displayName"
                required
                defaultValue={profile.displayName}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Phone
              <input
                name="contactPhone"
                type="tel"
                pattern="\+977\d{8,10}"
                placeholder="+97798XXXXXXXX"
                defaultValue={profile.contact.phone ?? ""}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Email
              <input
                name="contactEmail"
                type="email"
                defaultValue={profile.contact.email ?? ""}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Address
              <input
                name="addressLine"
                defaultValue={profile.contact.addressLine ?? ""}
                className={inputClass}
              />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Description
              <textarea
                name="description"
                rows={3}
                defaultValue={profile.description ?? ""}
                className={inputClass}
              />
            </label>
            {identityEditable ? (
              <>
                <label className={labelClass}>
                  Legal name
                  <input
                    name="legalName"
                    required
                    defaultValue={profile.legalName}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  PAN (9 digits)
                  <input
                    name="panNumber"
                    pattern="\d{9}"
                    defaultValue={profile.tax.panNumber ?? ""}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  VAT number (9 digits)
                  <input
                    name="vatNumber"
                    pattern="\d{9}"
                    defaultValue={profile.tax.vatNumber ?? ""}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  Business registration no.
                  <input
                    name="businessRegistrationNo"
                    defaultValue={profile.tax.businessRegistrationNo ?? ""}
                    className={inputClass}
                  />
                </label>
              </>
            ) : (
              <p className="text-sm text-slate-600 sm:col-span-2">
                Legal and tax details are locked while your business is{" "}
                {providerStatusLabel(profile.status).toLowerCase()}.
              </p>
            )}
            <div className="flex gap-3 sm:col-span-2">
              <button type="submit" className={buttonPrimary} disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </button>
              <button type="button" className={buttonSecondary} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <Facts
            rows={[
              { label: "Shown as", value: profile.displayName },
              { label: "Legal name", value: profile.legalName },
              { label: "Kind", value: profile.providerType.name },
              {
                label: "Status",
                value: (
                  <StatusPill
                    label={providerStatusLabel(profile.status)}
                    tone={providerStatusTone(profile.status)}
                  />
                ),
              },
              { label: "Phone", value: profile.contact.phone ?? "—" },
              { label: "Email", value: profile.contact.email ?? "—" },
              { label: "Address", value: profile.contact.addressLine ?? "—" },
              { label: "PAN", value: profile.tax.panNumber ?? "—" },
              { label: "VAT", value: profile.tax.vatNumber ?? "—" },
              { label: "Registration no.", value: profile.tax.businessRegistrationNo ?? "—" },
              {
                label: "MeroStay commission",
                value:
                  profile.commissionRateBps === null
                    ? "Platform rate (set by MeroStay)"
                    : `${bpsToPercentText(profile.commissionRateBps)} (set by MeroStay)`,
              },
            ]}
          />
        )}
      </Panel>

      <Panel
        title="Payout bank account"
        actions={
          editing !== "bank" ? (
            <button type="button" className={buttonSecondary} onClick={() => setEditing("bank")}>
              {account ? "Change account" : "Add account"}
            </button>
          ) : null
        }
      >
        <p className="mb-3 text-sm text-slate-600" data-testid="payout-account-summary">
          {payoutAccountSummary(account)}
        </p>
        {account ? (
          <Facts
            rows={[
              { label: "Bank", value: account.bankName },
              { label: "Branch", value: account.branch ?? "—" },
              { label: "Account name", value: account.accountName },
              {
                label: "Account number",
                value: (
                  <span data-testid="account-number-masked">
                    {safeMaskedAccountNumber(account.accountNumberMasked)}
                  </span>
                ),
              },
              {
                label: "Verified",
                value: account.verified
                  ? `Yes, ${formatTimestamp(account.verifiedAt)}`
                  : "Not yet: MeroStay checks it first",
              },
            ]}
          />
        ) : null}
        {editing === "bank" ? (
          <form onSubmit={onBank} className="mt-4 grid gap-4 sm:grid-cols-2" autoComplete="off">
            <label className={labelClass}>
              Bank
              <input name="bankName" required maxLength={120} className={inputClass} />
            </label>
            <label className={labelClass}>
              Branch (optional)
              <input name="branch" maxLength={120} className={inputClass} />
            </label>
            <label className={labelClass}>
              Account name
              <input name="accountName" required maxLength={200} className={inputClass} />
            </label>
            <label className={labelClass}>
              Account number
              <input
                name="accountNumber"
                required
                pattern="[0-9A-Za-z\-]{6,34}"
                inputMode="numeric"
                autoComplete="off"
                className={inputClass}
              />
            </label>
            <p className="text-sm text-slate-600 sm:col-span-2">
              After saving, only the last four characters are ever shown. A new account must be
              verified again before payouts.
            </p>
            <div className="flex gap-3 sm:col-span-2">
              <button type="submit" className={buttonPrimary} disabled={busy}>
                {busy ? "Saving…" : "Save account"}
              </button>
              <button type="button" className={buttonSecondary} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </Panel>
    </div>
  );
}
