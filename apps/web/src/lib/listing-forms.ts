import { majorInputToMinor } from "./money";
import { percentInputToBps } from "./partner-display";

/**
 * Partner listing forms (Phase 7 Track B, ADR 0011).
 *
 * Which listing types exist comes from the API (GET /listing-types, active ones only). The
 * type-specific "details" fields below mirror the API's detail tables (listing-details.ts on the
 * API side). A type with no entry here (e.g. `activity`, or a new vertical without a detail table)
 * simply has no detail fields; nothing else changes. The API validates everything again: these
 * descriptors only build a helpful form.
 *
 * Money typed in rupees becomes a minor-unit string (majorInputToMinor, string operations only);
 * percentages become basis points. Nothing here does float arithmetic on money.
 */

export type FieldKind = "integer" | "text" | "time" | "select" | "list" | "location";

export interface DetailField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /** The API accepts null to clear this optional field. */
  nullable?: boolean;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  hint?: string;
}

const ACCOMMODATION_KINDS = [
  { value: "HOTEL", label: "Hotel" },
  { value: "GUESTHOUSE", label: "Guesthouse" },
  { value: "HOMESTAY", label: "Homestay" },
  { value: "RESORT", label: "Resort" },
  { value: "TEAHOUSE", label: "Teahouse" },
  { value: "LODGE", label: "Lodge" },
] as const;

const DIFFICULTIES = [
  { value: "EASY", label: "Easy" },
  { value: "MODERATE", label: "Moderate" },
  { value: "CHALLENGING", label: "Challenging" },
  { value: "STRENUOUS", label: "Strenuous" },
] as const;

export const DETAIL_FIELDS: Readonly<Record<string, readonly DetailField[]>> = {
  hotel: [
    {
      name: "accommodationKind",
      label: "Kind of stay",
      kind: "select",
      required: true,
      options: ACCOMMODATION_KINDS,
    },
    {
      name: "starRating",
      label: "Star rating",
      kind: "integer",
      required: false,
      nullable: true,
      min: 1,
      max: 5,
    },
    { name: "checkInTime", label: "Check-in from", kind: "time", required: true },
    { name: "checkOutTime", label: "Check-out by", kind: "time", required: true },
  ],
  hotel_room: [
    { name: "maxAdults", label: "Adults (max)", kind: "integer", required: true, min: 1, max: 50 },
    {
      name: "maxChildren",
      label: "Children (max)",
      kind: "integer",
      required: false,
      min: 0,
      max: 50,
    },
    {
      name: "bedType",
      label: "Bed type",
      kind: "text",
      required: false,
      nullable: true,
      hint: "e.g. double, twin",
    },
    { name: "bedCount", label: "Beds", kind: "integer", required: false, min: 1, max: 50 },
    {
      name: "sizeSqm",
      label: "Size (m²)",
      kind: "integer",
      required: false,
      nullable: true,
      min: 1,
      max: 10_000,
    },
  ],
  bus_ticket: [
    { name: "originLocationId", label: "From", kind: "location", required: true },
    { name: "destinationLocationId", label: "To", kind: "location", required: true },
    { name: "departureTime", label: "Departure time", kind: "time", required: true },
    {
      name: "durationMinutes",
      label: "Journey time (minutes)",
      kind: "integer",
      required: true,
      min: 1,
      max: 10_000,
    },
    {
      name: "busType",
      label: "Bus type",
      kind: "text",
      required: true,
      hint: "e.g. Deluxe, Tourist",
    },
    {
      name: "seatCapacity",
      label: "Seats on the bus",
      kind: "integer",
      required: true,
      min: 1,
      max: 200,
    },
    {
      name: "boardingPoint",
      label: "Boarding point",
      kind: "text",
      required: false,
      nullable: true,
    },
  ],
  guide_service: [
    {
      name: "languages",
      label: "Languages",
      kind: "list",
      required: true,
      hint: "Comma-separated, e.g. en, ne",
    },
    { name: "regions", label: "Regions", kind: "list", required: false, hint: "Comma-separated" },
    {
      name: "licenseNumber",
      label: "Licence number",
      kind: "text",
      required: false,
      nullable: true,
    },
    {
      name: "maxGroupSize",
      label: "Group size (max)",
      kind: "integer",
      required: true,
      min: 1,
      max: 100,
    },
  ],
  tour: [
    {
      name: "durationDays",
      label: "Duration (days)",
      kind: "integer",
      required: true,
      min: 1,
      max: 60,
    },
    {
      name: "difficulty",
      label: "Difficulty",
      kind: "select",
      required: true,
      options: DIFFICULTIES,
    },
    {
      name: "startLocationId",
      label: "Starts at",
      kind: "location",
      required: false,
      nullable: true,
    },
    {
      name: "maxAltitudeMeters",
      label: "Highest point (m)",
      kind: "integer",
      required: false,
      nullable: true,
      min: 1,
      max: 9000,
    },
    {
      name: "maxGroupSize",
      label: "Group size (max)",
      kind: "integer",
      required: true,
      min: 1,
      max: 200,
    },
  ],
};

export function detailFieldsFor(listingTypeCode: string): readonly DetailField[] {
  return DETAIL_FIELDS[listingTypeCode] ?? [];
}

/** The form field name of a detail field (kept apart from the common fields). */
export const detailInputName = (name: string): string => `detail.${name}`;

export interface BuildResult<T> {
  value: T | null;
  problems: string[];
}

/**
 * The `details` object for a listing type from the form's text values. Empty optional fields are
 * left out on create, and sent as null on edit when the API accepts null (so they can be cleared).
 */
export function buildDetails(
  listingTypeCode: string,
  values: Readonly<Record<string, string>>,
  mode: "create" | "edit",
): BuildResult<Record<string, unknown> | undefined> {
  const fields = detailFieldsFor(listingTypeCode);
  if (fields.length === 0) return { value: undefined, problems: [] };
  const details: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const field of fields) {
    const raw = (values[field.name] ?? "").trim();
    if (raw === "") {
      if (field.required) problems.push(`${field.label} is required.`);
      else if (mode === "edit" && field.nullable) details[field.name] = null;
      continue;
    }
    switch (field.kind) {
      case "integer": {
        if (!/^\d{1,6}$/.test(raw)) {
          problems.push(`${field.label} must be a whole number.`);
          break;
        }
        const n = Number.parseInt(raw, 10);
        if (
          (field.min !== undefined && n < field.min) ||
          (field.max !== undefined && n > field.max)
        ) {
          problems.push(`${field.label} must be between ${field.min ?? 0} and ${field.max ?? n}.`);
          break;
        }
        details[field.name] = n;
        break;
      }
      case "time":
        if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(raw))
          problems.push(`${field.label} must be HH:MM.`);
        else details[field.name] = raw;
        break;
      case "list": {
        const items = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (field.required && items.length === 0) problems.push(`${field.label} is required.`);
        else details[field.name] = items;
        break;
      }
      case "select":
        if (field.options && !field.options.some((o) => o.value === raw)) {
          problems.push(`Choose a ${field.label.toLowerCase()}.`);
        } else details[field.name] = raw;
        break;
      default:
        details[field.name] = raw;
    }
  }
  return problems.length > 0 ? { value: null, problems } : { value: details, problems };
}

/** Text values for an edit form from the API's `details` (arrays joined, numbers as text). */
export function detailValuesFrom(details: Record<string, unknown> | null): Record<string, string> {
  const values: Record<string, string> = {};
  if (!details) return values;
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) values[key] = "";
    else if (Array.isArray(value)) values[key] = value.map(String).join(", ");
    else if (typeof value === "object") continue;
    else values[key] = String(value);
  }
  return values;
}

export interface ListingFormValues {
  title: string;
  description: string;
  price: string;
  serviceChargePercent: string;
  taxPercent: string;
  addressLine: string;
  locationId: string;
  parentId: string;
}

/** The common fields of a create/update body. The currency is NPR (one currency in the MVP). */
export function buildListingFields(
  values: ListingFormValues,
  currencyExponent = 2,
): BuildResult<Record<string, unknown>> {
  const problems: string[] = [];
  const title = values.title.trim();
  if (title.length < 3) problems.push("Title needs at least 3 characters.");
  const basePriceMinor = majorInputToMinor(values.price, currencyExponent);
  if (basePriceMinor === null)
    problems.push("Price must be an amount in rupees, e.g. 3500 or 3500.50.");
  const serviceChargeRateBps = percentInputToBps(values.serviceChargePercent);
  if (serviceChargeRateBps === null)
    problems.push("Service charge must be a percentage from 0 to 100.");
  const taxRateBps = percentInputToBps(values.taxPercent);
  if (taxRateBps === null) problems.push("VAT must be a percentage from 0 to 100.");
  if (problems.length > 0) return { value: null, problems };
  return {
    value: {
      title,
      description: values.description.trim() || null,
      basePriceMinor,
      serviceChargeRateBps,
      taxRateBps,
      addressLine: values.addressLine.trim() || null,
      locationId: values.locationId || null,
    },
    problems,
  };
}
