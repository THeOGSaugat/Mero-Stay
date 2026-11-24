/**
 * Which listing types a provider may create (ADR 0013, operational gap 22). Pure rules: the
 * mapping and the active flags come from the database (`provider_type_listing_types`,
 * `provider_types.is_active`, `listing_types.is_active`); no type name appears in code.
 *
 * A listing type is allowed for a provider when ALL of these hold:
 * 1. the listing type exists and is active (otherwise the existing LISTING_TYPE_NOT_OFFERED);
 * 2. the provider's type is active (gap 19's flag);
 * 3. the pair is in the provider type's mapping.
 */

export interface TypeFlag {
  code: string;
  isActive: boolean;
}

export interface ProviderTypeRules extends TypeFlag {
  /** The mapped listing types, with their own active flags. */
  allowedListingTypes: readonly TypeFlag[];
}

export type ListingTypeDecision =
  | { ok: true }
  | {
      ok: false;
      code: "LISTING_TYPE_NOT_OFFERED" | "LISTING_TYPE_NOT_ALLOWED";
      reason: "listing_type_not_offered" | "provider_type_not_offered" | "not_mapped";
      /** The listing types the provider may use right now (error details, UI hint). */
      usable: string[];
    };

/** The listing types a provider of this type may create now: mapped AND both types active. */
export function usableListingTypes(providerType: ProviderTypeRules): string[] {
  if (!providerType.isActive) return [];
  return providerType.allowedListingTypes
    .filter((t) => t.isActive)
    .map((t) => t.code)
    .sort();
}

export function decideListingType(
  providerType: ProviderTypeRules,
  listingType: TypeFlag | null,
): ListingTypeDecision {
  const usable = usableListingTypes(providerType);
  if (!listingType || !listingType.isActive) {
    return {
      ok: false,
      code: "LISTING_TYPE_NOT_OFFERED",
      reason: "listing_type_not_offered",
      usable,
    };
  }
  if (usable.includes(listingType.code)) return { ok: true };
  return {
    ok: false,
    code: "LISTING_TYPE_NOT_ALLOWED",
    reason: providerType.isActive ? "not_mapped" : "provider_type_not_offered",
    usable,
  };
}
