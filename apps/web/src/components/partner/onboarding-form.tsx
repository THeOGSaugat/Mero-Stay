"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest } from "@/lib/api-client";
import { describePartnerError } from "@/lib/partner-access";
import { documentTypeLabel, requirementLabel } from "@/lib/partner-display";
import type { PartnerProfile, ProviderTypeOffer } from "@/lib/partner-types";
import { useAuth } from "../auth/auth-provider";
import { Alert, buttonPrimary, inputClass, labelClass } from "../ui/primitives";

/**
 * A customer sets up a business and becomes a partner (POST /partner/onboarding). Business kinds
 * come from GET /provider-types: only the ones MeroStay offers (ADR 0009), each with the documents
 * verification will need, shown up front.
 */
export function OnboardingForm() {
  const { state, refresh } = useAuth();
  const router = useRouter();
  const [types, setTypes] = useState<ProviderTypeOffer[] | null>(null);
  const [typeCode, setTypeCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per form: a retried submit (e.g. after a lost response) creates the business once.
  const [idempotencyKey] = useState(() => `onboard-${crypto.randomUUID()}`);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ data: ProviderTypeOffer[] }>("/provider-types")
      .then((body) => !cancelled && setTypes(body.data))
      .catch((err: unknown) => !cancelled && setError(describePartnerError(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "authenticated" && state.user.role === "PARTNER") {
    return (
      <div className="space-y-4">
        <Alert tone="info">Your account already manages a business on MeroStay.</Alert>
        <Link href="/partner" className={buttonPrimary}>
          Go to the partner area
        </Link>
      </div>
    );
  }
  if (state.status === "authenticated" && state.user.role === "ADMIN") {
    return <Alert>Admin accounts can&apos;t set up a business.</Alert>;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const optional = (name: string) => text(name) || undefined;
    setBusy(true);
    setError(null);
    try {
      await apiRequest<{ data: PartnerProfile }>("/partner/onboarding", {
        method: "POST",
        csrfToken: state.csrfToken,
        headers: { "Idempotency-Key": idempotencyKey },
        body: {
          providerTypeCode: typeCode,
          legalName: text("legalName"),
          displayName: text("displayName"),
          contactPhone: optional("contactPhone"),
          contactEmail: optional("contactEmail"),
          addressLine: optional("addressLine"),
          panNumber: optional("panNumber"),
        },
      });
      await refresh(); // the account is a partner now
      router.push("/partner/verification");
    } catch (err) {
      setError(describePartnerError(err));
      setBusy(false);
    }
  }

  const selected = types?.find((t) => t.code === typeCode);
  return (
    <form
      onSubmit={onSubmit}
      className="space-y-6"
      aria-describedby={error ? "onboard-error" : undefined}
    >
      {error ? (
        <div id="onboard-error">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <fieldset className="space-y-3">
        <legend className="text-base font-semibold text-primary">
          What kind of business is it?
        </legend>
        {types === null && !error ? <p className="text-sm text-muted">Loading…</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {types?.map((type) => (
            <label
              key={type.code}
              className={`flex cursor-pointer gap-3 rounded-control border p-3 text-sm ${
                typeCode === type.code ? "border-primary bg-surface" : "border-slate-300 bg-white"
              }`}
            >
              <input
                type="radio"
                name="providerTypeCode"
                value={type.code}
                checked={typeCode === type.code}
                onChange={() => setTypeCode(type.code)}
                required
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block font-semibold text-primary">{type.name}</span>
                {type.description ? (
                  <span className="mt-0.5 block text-muted">{type.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {selected ? (
        <Alert tone="info">
          <p className="font-semibold">Documents you&apos;ll need for verification</p>
          <ul className="mt-1 list-disc pl-5">
            {selected.requiredDocuments.map((group) => (
              <li key={group.requirement}>
                {requirementLabel(group.requirement)}:{" "}
                {group.acceptedDocumentTypes.map(documentTypeLabel).join(" or ")}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelClass}>
          Legal name
          <input name="legalName" required maxLength={200} className={inputClass} />
        </label>
        <label className={labelClass}>
          Name shown to travellers
          <input name="displayName" required maxLength={120} className={inputClass} />
        </label>
        <label className={labelClass}>
          Phone (optional)
          <input
            name="contactPhone"
            type="tel"
            placeholder="+97798XXXXXXXX"
            pattern="\+977\d{8,10}"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Email (optional)
          <input name="contactEmail" type="email" className={inputClass} />
        </label>
        <label className={labelClass}>
          Address (optional)
          <input name="addressLine" maxLength={300} className={inputClass} />
        </label>
        <label className={labelClass}>
          PAN (optional, 9 digits)
          <input name="panNumber" inputMode="numeric" pattern="\d{9}" className={inputClass} />
        </label>
      </div>
      <button type="submit" className={buttonPrimary} disabled={busy || !typeCode}>
        {busy ? "Setting up…" : "Set up my business"}
      </button>
    </form>
  );
}
