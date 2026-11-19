/**
 * Service dates are calendar dates ("YYYY-MM-DD"), stored as PostgreSQL DATE (UTC midnight in JS).
 * Ranges are start-inclusive, end-exclusive: a stay from 20th to 22nd uses the nights of 20th and 21st.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Most service dates one booking item may cover (e.g. 30 nights, 30 guide days). */
export const MAX_SERVICE_DATES = 30;

export class InvalidDateRangeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDateRangeError";
  }
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** "2026-12-20" → Date at 2026-12-20T00:00:00Z (how Prisma represents a DATE column). */
export function toDbDate(value: string): Date {
  if (!isIsoDate(value)) throw new InvalidDateRangeError(`Not a valid date: ${value}`);
  return new Date(`${value}T00:00:00.000Z`);
}

export function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  const date = toDbDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return fromDbDate(date);
}

/**
 * Every service date an item covers: each date in [start, end), or just [start] when end is absent.
 * The client chooses the shape, so no vertical is hard-coded here: a hotel stay or multi-day guide
 * sends an end date; a bus seat, tour departure or activity sends only a start date.
 */
export function enumerateServiceDates(start: string, end?: string | null): string[] {
  toDbDate(start);
  if (end === undefined || end === null) return [start];
  toDbDate(end);
  if (end <= start) throw new InvalidDateRangeError("endDate must be after startDate");

  const dates: string[] = [];
  for (let current = start; current < end; current = addDays(current, 1)) {
    dates.push(current);
    if (dates.length > MAX_SERVICE_DATES) {
      throw new InvalidDateRangeError(
        `A booking item can cover at most ${MAX_SERVICE_DATES} dates`,
      );
    }
  }
  return dates;
}

/** Today's calendar date in Nepal (UTC+05:45), "YYYY-MM-DD". */
export function todayInKathmandu(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
