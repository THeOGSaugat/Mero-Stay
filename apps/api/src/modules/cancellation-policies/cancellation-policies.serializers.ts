import type { PolicySource } from "../../domain/cancellation-policy.js";
import { toJsonSafe } from "../../lib/money-json.js";

interface PolicyRow {
  id: string;
  providerId: string | null;
  name: string;
  description: string;
  nonRefundable: boolean;
  rules: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A policy as its owner (or an admin) sees it, with where it is used. */
export function serializePolicy(
  policy: PolicyRow,
  usage?: { listings: number; providerDefault: boolean },
) {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    nonRefundable: policy.nonRefundable,
    rules: toJsonSafe(policy.rules),
    isActive: policy.isActive,
    /** A MeroStay template (no owner); none exist yet (owner decision: partner-authored only). */
    isPlatformTemplate: policy.providerId === null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    ...(usage ? { usage } : {}),
  };
}

/** The policy that applies to a listing now, as customers see it (listing detail). */
export function serializeResolvedPolicy(
  resolved: {
    policy: {
      id: string;
      name: string;
      description: string;
      nonRefundable: boolean;
      rules: unknown;
    };
    source: PolicySource;
  } | null,
) {
  if (!resolved) return null;
  const { policy, source } = resolved;
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    nonRefundable: policy.nonRefundable,
    rules: toJsonSafe(policy.rules),
    source,
  };
}
