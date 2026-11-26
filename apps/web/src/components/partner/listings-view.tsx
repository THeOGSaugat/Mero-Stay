"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  buildDetails,
  buildListingFields,
  detailFieldsFor,
  detailInputName,
  detailValuesFrom,
  type DetailField,
  listingTypeChoices,
  parentTypeCodes,
} from "@/lib/listing-forms";
import { formatMoney, splitMinor } from "@/lib/money";
import { describePartnerError } from "@/lib/partner-access";
import {
  bpsToPercentInput,
  bpsToPercentText,
  listingStatusLabel,
  partnerListingMoves,
} from "@/lib/partner-display";
import type { ManagedListing, Paged } from "@/lib/partner-types";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { InventoryManager } from "./inventory-manager";
import { LocationPicker } from "./location-picker";
import { ListingPolicyPanel } from "./policies-view";
import { usePartner } from "./partner-context";
import {
  Facts,
  Pager,
  Panel,
  PartnerError,
  tableClass,
  tdClass,
  thClass,
  usePartnerData,
} from "./partner-ui";

export function listingTone(status: string): "good" | "wait" | "neutral" | "bad" {
  if (status === "APPROVED") return "good";
  if (status === "DRAFT" || status === "PENDING_REVIEW") return "wait";
  if (status === "REJECTED" || status === "SUSPENDED") return "bad";
  return "neutral";
}

const STATUS_FILTERS = [
  "",
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "ARCHIVED",
];

/** /partner/listings: the business's own listings, every status (GET /partner/listings). */
export function ListingList() {
  const search = useSearchParams();
  const page = Math.max(1, Number.parseInt(search.get("page") ?? "1", 10) || 1);
  const status = search.get("status") ?? "";
  const query = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (status) query.set("status", status);
  const { data, error } = usePartnerData<Paged<ManagedListing>>(`/listings?${query.toString()}`);
  const router = useRouter();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className={labelClass}>
          Status
          <select
            className={inputClass}
            value={status}
            onChange={(e) =>
              router.push(
                e.target.value ? `/partner/listings?status=${e.target.value}` : "/partner/listings",
              )
            }
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s ? listingStatusLabel(s) : "All"}
              </option>
            ))}
          </select>
        </label>
        <Link href="/partner/listings/new" className={buttonPrimary}>
          New listing
        </Link>
      </div>
      {error ? <PartnerError view={error} /> : null}
      {!data && !error ? <p className="text-sm text-slate-600">Loading listings…</p> : null}
      {data && data.data.length === 0 ? <Alert tone="info">No listings yet.</Alert> : null}
      {data && data.data.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-mist bg-white">
          <table className={tableClass} data-testid="partner-listings">
            <thead>
              <tr>
                <th className={thClass}>Listing</th>
                <th className={thClass}>Status</th>
                <th className={thClass}>Price</th>
                <th className={thClass}>Place</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist">
              {data.data.map((listing) => (
                <tr key={listing.id} data-testid="partner-listing-row">
                  <td className={tdClass}>
                    <Link
                      href={`/partner/listings/${listing.id}`}
                      className="font-semibold text-navy hover:underline"
                    >
                      {listing.title}
                    </Link>
                    <span className="block text-slate-600">
                      {listing.listingType.name}
                      {listing.parent ? ` · ${listing.parent.title}` : ""}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <StatusPill
                      label={listingStatusLabel(listing.status)}
                      tone={listingTone(listing.status)}
                    />
                  </td>
                  <td className={tdClass}>
                    {listing.listingType.isBookable
                      ? `${formatMoney(listing.basePriceMinor, listing.currency, listing.currencyExponent)} / ${listing.listingType.unitLabel}`
                      : "—"}
                  </td>
                  <td className={tdClass}>{listing.location?.name ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data ? (
        <Pager
          page={data.page}
          hrefFor={(p) => `/partner/listings?page=${p}${status ? `&status=${status}` : ""}`}
        />
      ) : null}
    </div>
  );
}

function DetailInput({ field, value }: { field: DetailField; value: string }) {
  const name = detailInputName(field.name);
  const label = `${field.label}${field.required ? "" : " (optional)"}`;
  if (field.kind === "select") {
    return (
      <label className={labelClass}>
        {label}
        <select name={name} required={field.required} defaultValue={value} className={inputClass}>
          <option value="">Choose…</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className={labelClass}>
      {label}
      <input
        name={name}
        required={field.required}
        defaultValue={value}
        type={field.kind === "time" ? "time" : "text"}
        inputMode={field.kind === "integer" ? "numeric" : undefined}
        pattern={field.kind === "integer" ? "\\d*" : undefined}
        placeholder={field.hint}
        className={inputClass}
      />
    </label>
  );
}

/** The amount of a minor-unit string as the rupee text for an input ("350000" → "3500.00"). */
function majorText(minor: string, exponent: number): string {
  const [whole, fraction] = splitMinor(minor, exponent);
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Create or edit a listing. The listing types offered are the ones the API says this business
 * may list (its profile's `allowedListingTypes`: mapped to its provider type and active, ADR
 * 0013); the details fields follow the chosen type (lib/listing-forms). The API re-checks both.
 */
export function ListingForm({
  listing,
  onSaved,
}: {
  listing?: ManagedListing;
  onSaved?: (listing: ManagedListing) => void;
}) {
  const { request, profile } = usePartner();
  const router = useRouter();
  const mode = listing ? "edit" : "create";
  const types = listingTypeChoices(profile);
  const [typeCode, setTypeCode] = useState(listing?.listingType.code ?? "");
  const [parents, setParents] = useState<ManagedListing[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(() => `listing-${crypto.randomUUID()}`);

  const parentCodes = parentTypeCodes(types).join(",");
  useEffect(() => {
    if (listing || !parentCodes) return;
    let cancelled = false;
    // Own listings that others can belong to (e.g. a property for its rooms), by type.
    Promise.all(
      parentCodes
        .split(",")
        .map((code) =>
          request<Paged<ManagedListing>>(
            `/listings?listingType=${encodeURIComponent(code)}&pageSize=100`,
          ).then((body) => body.data),
        ),
    )
      .then((lists) => !cancelled && setParents(lists.flat()))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [listing, parentCodes, request]);

  const fields = detailFieldsFor(typeCode);
  const values = detailValuesFrom(listing?.details ?? null);
  const exponent = listing?.currencyExponent ?? 2;
  const bookable = listing
    ? listing.listingType.isBookable
    : (types.find((t) => t.code === typeCode)?.isBookable ?? true);
  const unit =
    listing?.listingType.unitLabel ?? types.find((t) => t.code === typeCode)?.unitLabel ?? "unit";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    const common = buildListingFields(
      {
        title: text("title"),
        description: text("description"),
        price: bookable ? text("price") : "0",
        serviceChargePercent: text("serviceChargePercent"),
        taxPercent: text("taxPercent"),
        addressLine: text("addressLine"),
        locationId: text("locationId"),
        parentId: text("parentId"),
      },
      exponent,
    );
    const detailValues = Object.fromEntries(
      fields.map((f) => [f.name, text(detailInputName(f.name))]),
    );
    const details = buildDetails(typeCode, detailValues, mode);
    const all = [...common.problems, ...details.problems];
    setProblems(all);
    setError(null);
    setNotice(null);
    if (all.length > 0 || !common.value) return;

    setBusy(true);
    try {
      if (listing) {
        const body = { ...common.value, ...(details.value ? { details: details.value } : {}) };
        const saved = await request<{ data: ManagedListing }>(`/listings/${listing.id}`, {
          method: "PATCH",
          body,
        });
        setNotice("Listing saved.");
        onSaved?.(saved.data);
      } else {
        const body = {
          listingTypeCode: typeCode,
          currency: "NPR",
          ...common.value,
          ...(text("parentId") ? { parentId: text("parentId") } : {}),
          ...(details.value ? { details: details.value } : {}),
        };
        const created = await request<{ data: ManagedListing }>("/listings", {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
          body,
        });
        router.push(`/partner/listings/${created.data.id}?created=1`);
      }
    } catch (err) {
      setError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" data-testid="listing-form">
      {error ? <Alert>{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {problems.length > 0 ? (
        <Alert>
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {!listing && types.length === 0 ? (
        <div data-testid="no-listing-types">
          <Alert>
            Your kind of business can&apos;t create listings yet (it isn&apos;t offered). Contact
            MeroStay.
          </Alert>
        </div>
      ) : null}
      {!listing && types.length > 0 ? (
        <label className={labelClass}>
          Kind of listing
          <select
            name="listingTypeCode"
            required
            value={typeCode}
            onChange={(e) => setTypeCode(e.target.value)}
            className={inputClass}
          >
            <option value="">Choose…</option>
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
                {t.isBookable ? "" : " (groups other listings)"}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {typeCode ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={`${labelClass} sm:col-span-2`}>
              Title
              <input
                name="title"
                required
                minLength={3}
                maxLength={160}
                defaultValue={listing?.title}
                className={inputClass}
              />
            </label>
            <label className={`${labelClass} sm:col-span-2`}>
              Description (optional)
              <textarea
                name="description"
                rows={3}
                maxLength={5000}
                defaultValue={listing?.description ?? ""}
                className={inputClass}
              />
            </label>
            {bookable ? (
              <label className={labelClass}>
                Price per {unit} (Rs)
                <input
                  name="price"
                  required
                  inputMode="decimal"
                  pattern="\d+(\.\d{1,2})?"
                  defaultValue={listing ? majorText(listing.basePriceMinor, exponent) : ""}
                  className={inputClass}
                />
              </label>
            ) : null}
            {bookable ? (
              <label className={labelClass}>
                Service charge (%)
                <input
                  name="serviceChargePercent"
                  inputMode="decimal"
                  defaultValue={listing ? bpsToPercentInput(listing.serviceChargeRateBps) : "0"}
                  className={inputClass}
                />
              </label>
            ) : null}
            {bookable ? (
              <label className={labelClass}>
                VAT (%)
                <input
                  name="taxPercent"
                  inputMode="decimal"
                  defaultValue={listing ? bpsToPercentInput(listing.taxRateBps) : "0"}
                  className={inputClass}
                />
              </label>
            ) : null}
            <label className={labelClass}>
              Address (optional)
              <input
                name="addressLine"
                maxLength={300}
                defaultValue={listing?.addressLine ?? ""}
                className={inputClass}
              />
            </label>
            {!listing && parents.length > 0 ? (
              <label className={labelClass}>
                Part of (optional)
                <select name="parentId" className={inputClass} defaultValue="">
                  <option value="">None</option>
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <LocationPicker
            name="locationId"
            label="Place (shown in search)"
            current={listing?.location}
          />
          {fields.length > 0 ? (
            <fieldset className="space-y-3 rounded-lg border border-mist p-3">
              <legend className="px-1 text-sm font-semibold text-navy">Details</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((field) =>
                  field.kind === "location" ? (
                    <div key={field.name} className="sm:col-span-2">
                      <LocationPicker
                        name={detailInputName(field.name)}
                        label={field.label}
                        required={field.required}
                        current={
                          values[field.name]
                            ? { id: values[field.name]!, name: "Current place" }
                            : null
                        }
                      />
                    </div>
                  ) : (
                    <DetailInput key={field.name} field={field} value={values[field.name] ?? ""} />
                  ),
                )}
              </div>
            </fieldset>
          ) : null}
          <button type="submit" className={buttonPrimary} disabled={busy}>
            {busy ? "Saving…" : listing ? "Save changes" : "Create listing"}
          </button>
        </>
      ) : null}
    </form>
  );
}

/** /partner/listings/[id]: one own listing. Another business's listing is a 404 → "Not found". */
export function ListingDetailView() {
  const params = useParams<{ id: string }>();
  const created = useSearchParams().get("created") === "1";
  const { request } = usePartner();
  const { data, error, setData } = usePartnerData<{ data: ManagedListing }>(
    `/listings/${encodeURIComponent(params.id)}`,
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error)
    return (
      <PartnerError view={error} backHref="/partner/listings" backLabel="Back to your listings" />
    );
  if (!data) return <p className="text-sm text-slate-600">Loading listing…</p>;
  const listing = data.data;

  async function move(to: string) {
    setBusy(true);
    setStatusError(null);
    try {
      const body = await request<{ data: ManagedListing }>(`/listings/${listing.id}`, {
        method: "PATCH",
        body: { status: to },
      });
      setData(body);
    } catch (err) {
      setStatusError(describePartnerError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {created ? <Alert tone="success">Listing created as a draft.</Alert> : null}
      <Panel
        title={listing.title}
        actions={
          <StatusPill
            label={listingStatusLabel(listing.status)}
            tone={listingTone(listing.status)}
          />
        }
      >
        <Facts
          rows={[
            { label: "Kind", value: listing.listingType.name },
            ...(listing.parent ? [{ label: "Part of", value: listing.parent.title }] : []),
            { label: "Place", value: listing.location?.name ?? "—" },
            ...(listing.listingType.isBookable
              ? [
                  {
                    label: "Price",
                    value: `${formatMoney(listing.basePriceMinor, listing.currency, listing.currencyExponent)} / ${listing.listingType.unitLabel}`,
                  },
                  {
                    label: "Service charge",
                    value: bpsToPercentText(listing.serviceChargeRateBps),
                  },
                  { label: "VAT", value: bpsToPercentText(listing.taxRateBps) },
                ]
              : []),
            {
              label: "MeroStay commission",
              value:
                listing.commissionRateBps === null
                  ? "Your business's rate (set by MeroStay)"
                  : `${bpsToPercentText(listing.commissionRateBps)} (set by MeroStay)`,
            },
          ]}
        />
        {listing.status === "PENDING_REVIEW" ? (
          <p className="mt-3 text-sm text-slate-600">
            MeroStay reviews listings before they go live.
          </p>
        ) : null}
        {statusError ? (
          <div className="mt-3">
            <Alert>{statusError}</Alert>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {partnerListingMoves(listing.status).map((m) => (
            <button
              key={m.to}
              type="button"
              className={buttonSecondary}
              disabled={busy}
              onClick={() => void move(m.to)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </Panel>
      {listing.listingType.isBookable ? (
        <ListingPolicyPanel listing={listing} onSaved={(saved) => setData({ data: saved })} />
      ) : null}
      {listing.listingType.isBookable ? <InventoryManager listing={listing} /> : null}
      {listing.status !== "SUSPENDED" ? (
        <Panel title="Edit listing">
          <ListingForm listing={listing} onSaved={(saved) => setData({ data: saved })} />
        </Panel>
      ) : null}
    </div>
  );
}
