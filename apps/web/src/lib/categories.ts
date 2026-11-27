import type { ListingType } from "./api-types";
import { selectableListingTypes } from "./search";

/**
 * Customer-facing categories (Phase 13 design): "Stays, Buses, Guides, Experiences" are
 * presentation over the API's listing types, grouped by the UNIT a type is sold in (night, seat,
 * day, person). No listing-type code appears here: the types come from GET /listing-types at
 * runtime (ADR 0013: type rules are data-driven), and only active, bookable types are offered, so
 * flights (sold per seat, but inactive) never appear.
 *
 * Images are ILLUSTRATIVE (owner decision, ADR 0019): listings have no photos yet, so cards show a
 * photo of the kind of thing booked, labelled as illustrative, never as the property's own.
 */

export type CategoryId = "stays" | "buses" | "guides" | "experiences";

export interface Category {
  id: CategoryId;
  label: string;
  /** listing_types.unit_label of the types in this category. */
  unitLabel: string;
  /** Illustrative photo for cards and page headers (public/images). */
  image: string;
  imageAlt: string;
}

export const CATEGORIES: readonly Category[] = [
  {
    id: "stays",
    label: "Stays",
    unitLabel: "night",
    image: "/images/lakeside-resort-pool.jpg",
    imageAlt: "Illustrative photo: a lakeside resort in Nepal",
  },
  {
    id: "buses",
    label: "Buses",
    unitLabel: "seat",
    image: "/images/tourist-bus.jpg",
    imageAlt: "Illustrative photo: a tourist bus on a Nepali hill road",
  },
  {
    id: "guides",
    label: "Guides",
    unitLabel: "day",
    image: "/images/himalayan-trekker.jpg",
    imageAlt: "Illustrative photo: a trekker in the Himalaya",
  },
  {
    id: "experiences",
    label: "Experiences",
    unitLabel: "person",
    image: "/images/pokhara-paragliding.jpg",
    imageAlt: "Illustrative photo: paragliding over Pokhara",
  },
];

export interface ResolvedCategory extends Category {
  /** The offered (active, bookable) listing types in this category, in API order. */
  types: ListingType[];
}

/** The categories that have at least one offered listing type right now. */
export function resolveCategories(types: readonly ListingType[]): ResolvedCategory[] {
  const offered = selectableListingTypes(types);
  return CATEGORIES.map((category) => ({
    ...category,
    types: offered.filter((t) => t.unitLabel === category.unitLabel),
  })).filter((category) => category.types.length > 0);
}

export function categoryById(id: string | undefined): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** The category a listing type belongs to (by its unit), if any. */
export function categoryOfType(type: { unitLabel: string } | undefined): Category | undefined {
  return type ? CATEGORIES.find((c) => c.unitLabel === type.unitLabel) : undefined;
}

/** Header, footer and homepage links: the search page resolves the category to a type. */
export function categoryHref(id: CategoryId): string {
  return `/search?category=${id}`;
}

/** The illustrative photo for a listing type (properties: a resort; otherwise its category). */
export function illustrationFor(type: { unitLabel: string }): { image: string; imageAlt: string } {
  const category = categoryOfType(type);
  if (category) return { image: category.image, imageAlt: category.imageAlt };
  if (type.unitLabel === "property") {
    return {
      image: "/images/lakeside-resort-pool.jpg",
      imageAlt: "Illustrative photo: a lakeside resort in Nepal",
    };
  }
  return {
    image: "/images/himalayan-sunset.jpg",
    imageAlt: "Illustrative photo: the Himalaya at sunset",
  };
}

/** "lakeside-pokhara" → "Lakeside Pokhara" (a location slug typed in search, for headings only). */
export function placeName(slug: string | undefined): string {
  if (!slug) return "";
  return slug
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** The search page's heading: "Stays in Pokhara", "Buses", "Explore Nepal". */
export function searchTitle(
  type: { unitLabel: string } | undefined,
  location: string | undefined,
): string {
  const category = categoryOfType(type);
  const what = category ? category.label : "Explore Nepal";
  const where = placeName(location);
  if (!where) return what;
  return category ? `${what} in ${where}` : `Explore ${where}`;
}

/** Popular destinations on the home page: each searches its location slug. */
export const DESTINATIONS: readonly { slug: string; name: string; image: string }[] = [
  { slug: "pokhara", name: "Pokhara", image: "/images/destination-pokhara.jpg" },
  { slug: "kathmandu", name: "Kathmandu", image: "/images/destination-kathmandu.jpg" },
  { slug: "chitwan", name: "Chitwan", image: "/images/destination-chitwan.jpg" },
  { slug: "lumbini", name: "Lumbini", image: "/images/destination-lumbini.jpg" },
  { slug: "mustang", name: "Mustang", image: "/images/destination-mustang.jpg" },
  { slug: "ilam", name: "Ilam", image: "/images/destination-ilam.jpg" },
];
