import { z } from "zod";
import {
  cancellationRuleProblems,
  MAX_HOURS_BEFORE_START,
  MAX_TIERS,
} from "../../domain/cancellation-policy.js";
import { uuidSchema } from "../../lib/validation.js";

/** One refund tier: cancel at least `minHoursBeforeStart` hours before the start → `refundBps`. */
export const cancellationTierSchema = z
  .object({
    minHoursBeforeStart: z.number().int().min(0).max(MAX_HOURS_BEFORE_START),
    refundBps: z.number().int().min(1).max(10_000),
  })
  .strict();

const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(1000);
const rules = z.array(cancellationTierSchema).max(MAX_TIERS);

/** Adds the rule's ordering problems (hours decreasing, refund never increasing) as issues. */
function checkRule(
  value: { nonRefundable: boolean; rules: z.infer<typeof rules> },
  ctx: z.RefinementCtx,
): void {
  for (const message of cancellationRuleProblems({
    nonRefundable: value.nonRefundable,
    tiers: value.rules,
  })) {
    ctx.addIssue({ code: "custom", path: ["rules"], message });
  }
}

/** POST /partner/cancellation-policies (ADR 0015). */
export const createPolicyBodySchema = z
  .object({
    name,
    description: description.default(""),
    nonRefundable: z.boolean().default(false),
    rules: rules.default([]),
  })
  .strict()
  .superRefine(checkRule);

/** PATCH /partner/cancellation-policies/:id. The merged result is checked by the service. */
export const updatePolicyBodySchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    nonRefundable: z.boolean().optional(),
    rules: rules.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { error: "send at least one field" });

/** PUT /partner/cancellation-policies/default: the provider's default, or null for none. */
export const defaultPolicyBodySchema = z.object({ policyId: uuidSchema.nullable() }).strict();
