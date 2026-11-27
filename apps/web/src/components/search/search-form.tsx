import type { ReactNode } from "react";
import type { ListingType } from "@/lib/api-types";
import { resolveCategories, type CategoryId } from "@/lib/categories";
import type { SearchFilters } from "@/lib/search";
import { selectableListingTypes } from "@/lib/search";
import {
  IconBed,
  IconBus,
  IconCalendar,
  IconGuide,
  IconMountain,
  IconPin,
  IconSearch,
  IconUsers,
} from "../ui/icons";
import { buttonPrimary, buttonSecondary } from "../ui/primitives";

const TAB_ICONS: Record<CategoryId, ReactNode> = {
  stays: <IconBed className="size-4" />,
  buses: <IconBus className="size-4" />,
  guides: <IconGuide className="size-4" />,
  experiences: <IconMountain className="size-4" />,
};

const fieldInput =
  "block w-full border-0 bg-transparent p-0 pt-0.5 text-sm text-ink placeholder:text-slate-500 focus:outline-none focus-visible:outline-none";
const fieldBox =
  "flex min-h-14 items-center gap-3 rounded-control border border-line bg-white px-3 py-2 focus-within:border-primary focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent-strong";
const fieldLabel = "block text-xs font-medium text-muted";

/** The search filters kept as hidden fields when another form changes the rest. */
function Hidden({
  filters,
  keys,
}: {
  filters: SearchFilters;
  keys: readonly (keyof SearchFilters)[];
}) {
  return (
    <>
      {keys.map((key) =>
        filters[key] ? <input key={key} type="hidden" name={key} value={filters[key]} /> : null,
      )}
    </>
  );
}

/**
 * The search card (Phase 13 design): category tabs, destination, dates, guests. A plain GET
 * form to /search, so it works without JavaScript and stays light on mobile data. The tabs are
 * radio buttons for listing types; only active, bookable types are offered (never flights).
 */
export function SearchForm({
  types,
  filters = {},
}: {
  types: ListingType[];
  filters?: SearchFilters;
  /** Kept for callers from Phase 7; the card is the same everywhere now. */
  compact?: boolean;
}) {
  // Tabs by category (grouped by unit). A tab submits the type already chosen in it, else the
  // category's first type, so a search never changes type silently.
  const tabs = resolveCategories(types).map((category) => {
    const current = category.types.find((t) => t.code === filters.type);
    return { ...category, value: (current ?? category.types[0]!).code, checked: Boolean(current) };
  });
  // A type in no category (none today) keeps its own tab when chosen.
  const other =
    filters.type && !tabs.some((t) => t.checked)
      ? selectableListingTypes(types).find((t) => t.code === filters.type)
      : undefined;
  return (
    <form
      action="/search"
      method="get"
      role="search"
      aria-label="Search listings"
      className="rounded-card bg-white p-3 shadow-float sm:p-4"
    >
      <fieldset className="min-w-0">
        <legend className="sr-only">What are you looking for?</legend>
        <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto border-b border-line px-1">
          {tabs.map((tab) => (
            <label
              key={tab.id}
              className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent px-3 text-sm font-semibold text-muted hover:text-primary has-checked:border-primary has-checked:text-primary has-focus-visible:outline-2 has-focus-visible:outline-accent-strong"
            >
              <input
                type="radio"
                name="type"
                value={tab.value}
                defaultChecked={tab.checked}
                className="sr-only"
              />
              {TAB_ICONS[tab.id]}
              {tab.label}
            </label>
          ))}
          {other ? (
            <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent px-3 text-sm font-semibold text-muted has-checked:border-primary has-checked:text-primary">
              <input
                type="radio"
                name="type"
                value={other.code}
                defaultChecked
                className="sr-only"
              />
              {other.name}
            </label>
          ) : null}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_0.9fr_auto]">
        <label className={fieldBox}>
          <IconPin className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className={fieldLabel}>Destination</span>
            <input
              name="location"
              defaultValue={filters.location ?? ""}
              placeholder="e.g. pokhara, kaski"
              autoCapitalize="none"
              className={fieldInput}
            />
          </span>
        </label>
        <label className={fieldBox}>
          <IconCalendar className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className={fieldLabel}>From</span>
            <input
              name="startDate"
              type="date"
              defaultValue={filters.startDate ?? ""}
              className={fieldInput}
            />
          </span>
        </label>
        <label className={fieldBox}>
          <IconCalendar className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className={fieldLabel}>Until (stays, guides)</span>
            <input
              name="endDate"
              type="date"
              defaultValue={filters.endDate ?? ""}
              className={fieldInput}
            />
          </span>
        </label>
        <label className={fieldBox}>
          <IconUsers className="size-5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            <span className={fieldLabel}>Guests / units</span>
            <input
              name="quantity"
              type="number"
              min={1}
              max={999}
              inputMode="numeric"
              placeholder="1"
              defaultValue={filters.quantity ?? ""}
              className={fieldInput}
            />
          </span>
        </label>
        <button
          type="submit"
          className={`${buttonPrimary} min-h-14 px-6 sm:col-span-2 lg:col-span-1`}
        >
          <IconSearch className="size-5" />
          Search
        </button>
      </div>
      <input type="hidden" name="currency" value={filters.currency ?? "NPR"} />
      <Hidden filters={filters} keys={["minPrice", "maxPrice", "sort"]} />
    </form>
  );
}

/**
 * Price range and order for the results (sidebar). Applies on top of the search card's choices,
 * which it carries as hidden fields. Only filters the API supports (owner decision: no
 * amenity or rating filters until the data exists).
 */
export function ResultFilters({ filters }: { filters: SearchFilters }) {
  const input =
    "mt-1 block min-h-11 w-full rounded-control border border-line bg-white px-3 py-2 text-sm text-ink focus:border-primary";
  return (
    <form action="/search" method="get" aria-label="Filter results" className="space-y-4">
      <fieldset>
        <legend className="text-sm font-semibold text-primary">Price per unit (Rs.)</legend>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-xs font-medium text-muted">
            Min
            <input
              name="minPrice"
              inputMode="decimal"
              defaultValue={filters.minPrice ?? ""}
              className={input}
            />
          </label>
          <label className="text-xs font-medium text-muted">
            Max
            <input
              name="maxPrice"
              inputMode="decimal"
              defaultValue={filters.maxPrice ?? ""}
              className={input}
            />
          </label>
        </div>
      </fieldset>
      <label className="block text-sm font-semibold text-primary">
        Sort by
        <select name="sort" defaultValue={filters.sort ?? ""} className={input}>
          <option value="">Best match</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
          <option value="title">Name</option>
        </select>
      </label>
      <Hidden
        filters={filters}
        keys={["type", "location", "startDate", "endDate", "quantity", "currency"]}
      />
      <button type="submit" className={`${buttonSecondary} w-full`}>
        Apply filters
      </button>
    </form>
  );
}
