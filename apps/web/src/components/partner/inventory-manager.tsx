"use client";

import { useState, type FormEvent } from "react";
import { majorInputToMinor, formatMoney } from "@/lib/money";
import { describePartnerError } from "@/lib/partner-access";
import { kathmanduToday } from "@/lib/partner-display";
import type { ManagedListing, SlotsPayload, SlotsWriteResult } from "@/lib/partner-types";
import { addIsoDays } from "@/lib/search";
import { formatServiceDate } from "@/lib/trip-display";
import {
  Alert,
  buttonPrimary,
  buttonSecondary,
  inputClass,
  labelClass,
  StatusPill,
} from "../ui/primitives";
import { usePartner } from "./partner-context";
import { Panel, PartnerError, tableClass, tdClass, thClass, usePartnerData } from "./partner-ui";

/**
 * Availability and date prices of one listing (/partner/listings/:id/slots).
 *
 * Ranges are [from, to): "to" is the first date NOT included, like check-out. Capacity can't go
 * below what is already booked: the API refuses with 409 (CAPACITY_BELOW_BOOKED, or the
 * overbooking CHECK's INSUFFICIENT_AVAILABILITY), changes nothing, and the message says so.
 */
export function InventoryManager({ listing }: { listing: ManagedListing }) {
  const { request } = usePartner();
  const [range, setRange] = useState(() => {
    const start = kathmanduToday();
    return { startDate: start, endDate: addIsoDays(start, 14) };
  });
  const path = `/listings/${listing.id}/slots?startDate=${range.startDate}&endDate=${range.endDate}`;
  const { data, error, setData } = usePartnerData<{ data: SlotsPayload }>(path);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (minor: string) => formatMoney(minor, listing.currency, listing.currencyExponent);

  function onRange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const startDate = String(form.get("startDate") ?? "");
    const endDate = String(form.get("endDate") ?? "");
    if (startDate && endDate && endDate > startDate) setRange({ startDate, endDate });
  }

  async function write(event: FormEvent<HTMLFormElement>, method: "POST" | "PATCH") {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const body: Record<string, unknown> = {
      startDate: text("startDate"),
      endDate: text("endDate"),
    };
    if (!body.startDate || !body.endDate || String(body.endDate) <= String(body.startDate)) {
      setResult({
        tone: "error",
        text: "Choose a range: the end date must be after the start date.",
      });
      return;
    }
    const capacity = text("capacityTotal");
    if (capacity !== "") {
      if (!/^\d{1,5}$/.test(capacity)) {
        setResult({ tone: "error", text: "Units must be a whole number." });
        return;
      }
      body.capacityTotal = Number.parseInt(capacity, 10);
    } else if (method === "POST") {
      setResult({ tone: "error", text: "Enter how many units are available per date." });
      return;
    }
    if (form.get("basePrice") === "on") {
      body.priceOverrideMinor = null;
    } else if (text("price") !== "") {
      const minor = majorInputToMinor(text("price"), listing.currencyExponent);
      if (minor === null) {
        setResult({
          tone: "error",
          text: "Price must be an amount in rupees, e.g. 4200 or 4200.50.",
        });
        return;
      }
      body.priceOverrideMinor = minor;
    }
    const status = text("status");
    if (status) body.status = status;
    if (method === "PATCH" && Object.keys(body).length === 2) {
      setResult({ tone: "error", text: "Change at least one of units, price or open/closed." });
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const res = await request<{ data: SlotsWriteResult }>(`/listings/${listing.id}/slots`, {
        method,
        body,
      });
      const r = res.data;
      const text =
        method === "POST"
          ? `Added ${r.created ?? 0} date${r.created === 1 ? "" : "s"}${r.unchanged ? ` (${r.unchanged} already identical)` : ""}.`
          : `Updated ${r.updated ?? 0} date${r.updated === 1 ? "" : "s"}${
              r.missingDates && r.missingDates.length > 0
                ? `; ${r.missingDates.length} date${r.missingDates.length === 1 ? " has" : "s have"} no availability yet (add them first)`
                : ""
            }.`;
      setResult({ tone: "success", text });
      setRange({ startDate: String(body.startDate), endDate: String(body.endDate) });
      setData({ data: r });
    } catch (err) {
      setResult({ tone: "error", text: describePartnerError(err) });
    } finally {
      setBusy(false);
    }
  }

  const rangeFields = (
    <>
      <label className={labelClass}>
        From
        <input
          name="startDate"
          type="date"
          required
          defaultValue={range.startDate}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Up to (not including)
        <input
          name="endDate"
          type="date"
          required
          defaultValue={range.endDate}
          className={inputClass}
        />
      </label>
    </>
  );

  return (
    <Panel title="Availability and prices">
      <form
        onSubmit={onRange}
        className="mb-4 grid items-end gap-3 sm:grid-cols-3"
        key={`${range.startDate}-${range.endDate}`}
      >
        {rangeFields}
        <button type="submit" className={buttonSecondary}>
          Show dates
        </button>
      </form>

      {result ? (
        <div
          className="mb-4"
          data-testid={result.tone === "error" ? "inventory-error" : "inventory-result"}
        >
          <Alert tone={result.tone}>{result.text}</Alert>
        </div>
      ) : null}

      {error ? <PartnerError view={error} /> : null}
      {data ? (
        data.data.slots.length === 0 ? (
          <p className="mb-4 text-sm text-slate-600">No availability in these dates yet.</p>
        ) : (
          <div className="mb-4 overflow-x-auto">
            <table className={tableClass} data-testid="inventory-table">
              <thead>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Open</th>
                  <th className={thClass}>Units</th>
                  <th className={thClass}>Booked</th>
                  <th className={thClass}>Free</th>
                  <th className={thClass}>Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-mist">
                {data.data.slots.map((slot) => (
                  <tr key={slot.id} data-date={slot.date}>
                    <td className={tdClass}>{formatServiceDate(slot.date)}</td>
                    <td className={tdClass}>
                      <StatusPill
                        label={slot.status === "OPEN" ? "Open" : "Closed"}
                        tone={slot.status === "OPEN" ? "good" : "neutral"}
                      />
                    </td>
                    <td className={tdClass}>{slot.capacityTotal}</td>
                    <td className={tdClass}>{slot.capacityBooked}</td>
                    <td className={tdClass}>{slot.available}</td>
                    <td className={tdClass}>
                      {money(slot.effectivePriceMinor)}
                      {slot.priceOverrideMinor !== null ? (
                        <span className="block text-xs text-slate-600">date price</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : !error ? (
        <p className="mb-4 text-sm text-slate-600">Loading dates…</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <form
          onSubmit={(e) => void write(e, "POST")}
          className="space-y-3 rounded-lg border border-mist p-3"
          aria-labelledby="add-dates"
        >
          <h3 id="add-dates" className="font-semibold text-navy">
            Add dates
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {rangeFields}
            <label className={labelClass}>
              Units per date
              <input
                name="capacityTotal"
                required
                inputMode="numeric"
                pattern="\d*"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Date price (Rs, optional)
              <input
                name="price"
                inputMode="decimal"
                placeholder={`Base: ${money(listing.basePriceMinor)}`}
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Open for booking
              <select name="status" defaultValue="OPEN" className={inputClass}>
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
              </select>
            </label>
          </div>
          <button type="submit" className={buttonPrimary} disabled={busy}>
            Add dates
          </button>
        </form>

        <form
          onSubmit={(e) => void write(e, "PATCH")}
          className="space-y-3 rounded-lg border border-mist p-3"
          aria-labelledby="update-dates"
        >
          <h3 id="update-dates" className="font-semibold text-navy">
            Update dates
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {rangeFields}
            <label className={labelClass}>
              Units per date (leave empty to keep)
              <input
                name="capacityTotal"
                inputMode="numeric"
                pattern="\d*"
                className={inputClass}
              />
            </label>
            <label className={labelClass}>
              Date price (Rs, leave empty to keep)
              <input name="price" inputMode="decimal" className={inputClass} />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="basePrice" className="h-4 w-4 accent-navy" />
              Use the base price again
            </label>
            <label className={labelClass}>
              Open for booking
              <select name="status" defaultValue="" className={inputClass}>
                <option value="">Keep</option>
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
              </select>
            </label>
          </div>
          <button type="submit" className={buttonPrimary} disabled={busy}>
            Update dates
          </button>
        </form>
      </div>
    </Panel>
  );
}
