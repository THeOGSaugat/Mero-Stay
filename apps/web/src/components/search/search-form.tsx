import type { ListingType } from "@/lib/api-types";
import type { SearchFilters } from "@/lib/search";
import { selectableListingTypes } from "@/lib/search";
import { buttonPrimary, inputClass, labelClass } from "../ui/primitives";

/**
 * The search form: a plain GET form to /search (works without JavaScript, light on mobile
 * data). Prices are typed in rupees; the search page converts them to minor units for the API.
 * Only active, bookable listing types are offered (no flights, no hotel containers).
 */
export function SearchForm({
  types,
  filters = {},
  compact = false,
}: {
  types: ListingType[];
  filters?: SearchFilters;
  compact?: boolean;
}) {
  const options = selectableListingTypes(types);
  return (
    <form
      action="/search"
      method="get"
      role="search"
      aria-label="Search listings"
      className="grid grid-cols-1 gap-4 rounded-card border border-line bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4"
    >
      <div>
        <label htmlFor="search-type" className={labelClass}>
          What
        </label>
        <select
          id="search-type"
          name="type"
          defaultValue={filters.type ?? ""}
          className={inputClass}
        >
          <option value="">Anything</option>
          {options.map((type) => (
            <option key={type.code} value={type.code}>
              {type.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="search-location" className={labelClass}>
          Where
        </label>
        <input
          id="search-location"
          name="location"
          defaultValue={filters.location ?? ""}
          placeholder="e.g. pokhara, kaski"
          autoCapitalize="none"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="search-start" className={labelClass}>
          From
        </label>
        <input
          id="search-start"
          name="startDate"
          type="date"
          defaultValue={filters.startDate ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="search-end" className={labelClass}>
          Until <span className="font-normal text-slate-500">(stays, guides)</span>
        </label>
        <input
          id="search-end"
          name="endDate"
          type="date"
          defaultValue={filters.endDate ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="search-quantity" className={labelClass}>
          Guests / units
        </label>
        <input
          id="search-quantity"
          name="quantity"
          type="number"
          min={1}
          max={999}
          inputMode="numeric"
          defaultValue={filters.quantity ?? ""}
          className={inputClass}
        />
      </div>
      {compact ? null : (
        <>
          <div>
            <label htmlFor="search-min" className={labelClass}>
              Min price (Rs)
            </label>
            <input
              id="search-min"
              name="minPrice"
              inputMode="decimal"
              defaultValue={filters.minPrice ?? ""}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="search-max" className={labelClass}>
              Max price (Rs)
            </label>
            <input
              id="search-max"
              name="maxPrice"
              inputMode="decimal"
              defaultValue={filters.maxPrice ?? ""}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="search-sort" className={labelClass}>
              Sort
            </label>
            <select
              id="search-sort"
              name="sort"
              defaultValue={filters.sort ?? ""}
              className={inputClass}
            >
              <option value="">Best match</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="title">Name</option>
            </select>
          </div>
        </>
      )}
      <input type="hidden" name="currency" value={filters.currency ?? "NPR"} />
      <div className="flex items-end sm:col-span-2 lg:col-span-4">
        <button type="submit" className={`${buttonPrimary} w-full sm:w-auto`}>
          Search
        </button>
      </div>
    </form>
  );
}
