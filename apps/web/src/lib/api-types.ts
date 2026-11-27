import type { PolicyTerms } from "./cancellation-policy";
/**
 * Shapes of the MeroStay API responses the web app uses (docs/architecture/api.md).
 * Every `*Minor` field is a digit STRING; never convert it to a number (see money.ts).
 */

export interface CurrencyInfo {
  currency: string;
  currencyExponent: number;
}

export interface PublicUser {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  role: "CUSTOMER" | "PARTNER" | "ADMIN";
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
}

export interface SessionPayload {
  user: PublicUser;
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface ListingType {
  code: string;
  name: string;
  unitLabel: string;
  isBookable: boolean;
  isActive: boolean;
}

export interface ListingSummary extends CurrencyInfo {
  id: string;
  title: string;
  slug: string;
  listingType: { code: string; name: string; unitLabel: string };
  provider: { id: string; name: string };
  location: { id: string; name: string; slug: string } | null;
  parent: { id: string; title: string; slug: string } | null;
  basePriceMinor: string;
  serviceChargeRateBps: number;
  taxRateBps: number;
  availability?: {
    startDate: string;
    endDate: string | null;
    quantity: number;
    dates: number;
    minAvailable: number;
    estimatedSubtotalMinor: string;
  } | null;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CalendarSlot {
  date: string;
  status: "OPEN" | "CLOSED";
  available: number;
  unitPriceMinor: string;
}

export interface ListingDetail extends CurrencyInfo {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  listingType: { code: string; name: string; unitLabel: string; isBookable: boolean };
  provider: { id: string; name: string; providerType?: string };
  location: { id: string; name: string; slug: string } | null;
  parent: { id: string; title: string; slug: string } | null;
  basePriceMinor: string;
  serviceChargeRateBps: number;
  taxRateBps: number;
  details: Record<string, unknown> | null;
  attributes: Record<string, unknown> | null;
  /** The policy that applies now (listing → provider default), or null = none (ADR 0015). */
  cancellationPolicy: PolicyTerms | null;
  children: (CurrencyInfo & {
    id: string;
    title: string;
    slug: string;
    listingType: string;
    basePriceMinor: string;
  })[];
  calendar: (CurrencyInfo & { from: string; to: string; slots: CalendarSlot[] }) | null;
}

export type PaymentMethod = "online" | "pay_at_property";

export interface MoneyBreakdown {
  subtotalMinor: string;
  serviceChargeRateBps: number;
  serviceChargeMinor: string;
  taxRateBps: number;
  taxMinor: string;
  totalMinor: string;
}

export interface TripItem extends CurrencyInfo {
  id: string;
  status: string;
  listing: {
    id: string;
    title: string;
    slug: string;
    listingType: string;
    provider: { id: string; name: string };
  };
  startDate: string;
  endDate: string | null;
  travellerCount: number;
  quantity: number;
  paymentMethod: PaymentMethod;
  paymentStatus: string;
  lines: { date: string; units: number; unitPriceMinor: string; amountMinor: string }[];
  money: MoneyBreakdown & { paidMinor: string; refundedMinor: string };
  /** Frozen when booked (ADR 0015); null = none was attached. */
  cancellationPolicy: PolicyTerms | null;
  /** When the service starts (the refund clock, ADR 0020); Nepal time "YYYY-MM-DDTHH:MM". */
  serviceStartsAt: string;
  serviceStartsAtNepal: string;
  serviceStartSource: "LISTING_TIME" | "DEFAULT_MIDNIGHT";
  /** Set when the customer cancelled: the tier that applied and what goes back. */
  cancellation: { cancelledAt: string | null; refundBps: number; refundMinor: string } | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface TripTotals {
  subtotalMinor: string;
  serviceChargeMinor: string;
  taxMinor: string;
  totalMinor: string;
  payOnlineMinor: string;
  payAtPropertyMinor: string;
}

export interface Trip extends CurrencyInfo {
  id: string;
  reference: string;
  status: string;
  contact: { name: string | null; phone: string | null; email: string | null };
  totals: TripTotals;
  onlinePayment: { paidMinor: string; dueMinor: string };
  items: TripItem[];
  expiresAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TripListEntry extends CurrencyInfo {
  id: string;
  reference: string;
  status: string;
  totals: {
    subtotalMinor: string;
    serviceChargeMinor: string;
    taxMinor: string;
    totalMinor: string;
  };
  items: {
    id: string;
    status: string;
    title: string;
    listingType: string;
    startDate: string;
    endDate: string | null;
  }[];
  expiresAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface QuoteLine {
  itemId: string | null;
  candidateIndex: number | null;
  listing: { id: string; title: string; listingType: string };
  paymentMethod: PaymentMethod;
  startDate: string;
  endDate: string | null;
  quantity: number;
  available: boolean;
  unavailableDates: string[];
  priceChanged: boolean;
  lines: { date: string; units: number; unitPriceMinor: string; amountMinor: string }[];
  money: MoneyBreakdown;
  heldMoney: MoneyBreakdown | null;
}

export interface Quote extends CurrencyInfo {
  tripId: string;
  dryRun: true;
  lines: QuoteLine[];
  totals: TripTotals;
  allAvailable: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
