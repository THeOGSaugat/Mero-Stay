/**
 * Required verification documents (ADR 0009, requirements §6.2).
 *
 * The requirements are DATA (`provider_type_required_documents`): rows with the same `requirement`
 * form a group, and any ONE document of a listed type satisfies the group. A document counts while
 * it is PENDING (uploaded and submitted, awaiting review) or APPROVED. A REJECTED document never
 * counts, nor one whose file is not uploaded and confirmed yet (AWAITING_UPLOAD, UPLOADED;
 * ADR 0016), nor a deleted one (callers pass only live documents).
 */

export interface RequirementRow {
  requirement: string;
  documentType: string;
}

export interface DocumentLike {
  documentType: string;
  status: "AWAITING_UPLOAD" | "UPLOADED" | "PENDING" | "APPROVED" | "REJECTED";
}

export interface RequirementGroup {
  requirement: string;
  acceptedDocumentTypes: string[];
}

/** Rows → groups, sorted by requirement, document types sorted within each group. */
export function requirementGroups(rows: readonly RequirementRow[]): RequirementGroup[] {
  const groups = new Map<string, Set<string>>();
  for (const row of rows) {
    const types = groups.get(row.requirement) ?? new Set<string>();
    types.add(row.documentType);
    groups.set(row.requirement, types);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([requirement, types]) => ({ requirement, acceptedDocumentTypes: [...types].sort() }));
}

/** The groups not satisfied by any PENDING or APPROVED document. Empty = complete. */
export function missingRequirements(
  rows: readonly RequirementRow[],
  documents: readonly DocumentLike[],
): RequirementGroup[] {
  const have = new Set(
    documents
      .filter((d) => d.status === "PENDING" || d.status === "APPROVED")
      .map((d) => d.documentType),
  );
  return requirementGroups(rows).filter(
    (group) => !group.acceptedDocumentTypes.some((type) => have.has(type)),
  );
}
