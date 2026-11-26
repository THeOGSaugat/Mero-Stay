# 0015. Cancellation policies partners author

- **Status:** Accepted
- **Date:** 2026-11-26
- **Phase:** 10 (closes operational gap 23)

## Context

Since Phase 2 every booking item stores a frozen copy of its cancellation policy (ADR 0004/0005),
taken from the listing's `default_cancellation_policy_id`. Partners had no way to create or choose
a policy, so partner-created listings had none and their bookings carried no terms (gap 23).

Requirements §6 lists "cancellation policy presets" as an open question to settle in the phase
that needs it. **Owner decision (2026-11-26): partner-authored policies only; no MeroStay presets
for now.** The schema keeps platform templates possible (`provider_id` NULL), but none are created.
Refunds are a later phase (Cancellations & refunds, Phase 14), so this phase stores and shows terms
and computes nothing.

## Decision

### 1. Model: the existing table, extended (not fields on providers or listings)

`cancellation_policies` (one row per policy; a provider has several and reuses them) gains
`is_active` and `non_refundable`. A policy is:

| Field | Meaning |
|---|---|
| `name`, `description` | Shown to customers; 1–120 characters, description optional |
| `rules` | Ordered tiers `[{ "minHoursBeforeStart": 72, "refundBps": 10000 }, …]`: cancel at least N hours before the start to get that share back. Hours strictly decrease, refunds never increase, 1–10 tiers, refund 0.01–100%. Cancelling later than the last tier gets nothing. A first tier at 100% is the free-cancellation window |
| `non_refundable` | No refund at any time; then `rules` is empty |
| `is_active` | Off = cannot be attached (and an attached policy cannot be switched off) |

Fields on providers or listings were rejected: the same terms are shared by many listings, and a
named, versionless row is what the booking snapshot already references.

The shape is checked by the API (Zod plus `cancellationRuleProblems`) and again by the database
(`cancellation_rules_valid()` in a CHECK constraint). Nothing is hard-coded: no policy names in
code, no presets.

### 2. Scope and resolution

| Level | Column | Set by |
|---|---|---|
| Listing (override) | `listings.default_cancellation_policy_id` | The listing's page ("Policy for this listing") |
| Provider (default) | `providers.default_cancellation_policy_id` (new) | The policies page ("Default for your listings") |

**Resolution: the listing's policy → the provider's default → none** (`resolveCancellationPolicy`,
`src/domain/cancellation-policy.ts`).

- Rooms resolve on their own listing, then the provider; the parent property is not a level.
- Resolution happens when an item is added to a trip.

### 3. Frozen at booking (the Phase 5 mechanism, reused)

`booking_items.cancellation_policy_snapshot` stores `{ policyId, name, description, nonRefundable,
rules, source: "listing" | "provider", capturedAt }`.

- Editing or switching off the policy later never changes it.
- Only the structured rule is stored: no refund amount is computed or stored.

### 4. Rules the database enforces

| Rule | How |
|---|---|
| Only an **active** policy of **the same provider** (or a platform template) can be attached to a provider or listing | Triggers on `providers` and `listings` → `cancellation_policies_attach_chk`. The trigger reads the policy `FOR SHARE`, so it is serialised with a concurrent deactivation |
| An attached policy cannot be switched off | Trigger on `cancellation_policies` → `cancellation_policies_in_use_chk`. The API answers first, with where it is used: `409 CANCELLATION_POLICY_IN_USE`, `details: { listings, providerDefault }` |
| A policy never moves to another provider | Same trigger (`cancellation_policies_owner_fixed_chk`) |
| The rule's shape | `cancellation_policies_rules_valid_chk` |

So resolution never meets an inactive policy; the `isActive` checks in code are a second line of
defence.

### 5. Endpoints

| Method and path | Who | What |
|---|---|---|
| `GET /partner/cancellation-policies` | Partner | Own policies with usage `{ listings, providerDefault }`, and `defaultPolicyId` |
| `POST /partner/cancellation-policies` | Partner | Create (`Idempotency-Key` optional) |
| `GET`/`PATCH /partner/cancellation-policies/:id` | Partner | Read or edit name, description, rule, `isActive`. Another provider's policy is a 404 |
| `PUT /partner/cancellation-policies/default` | Partner | `{ policyId \| null }` |
| `POST`/`PATCH /partner/listings…` | Partner | `defaultCancellationPolicyId`: own and active, else `422 UNKNOWN_CANCELLATION_POLICY` / `CANCELLATION_POLICY_INACTIVE` |
| `GET /admin/providers/:id/cancellation-policies` | Admin | The same list, read-only |
| `GET /listings/:id` | Public | `cancellationPolicy`: the policy that applies now with its `source`, or `null` |

Every partner write is audited (`cancellation_policy.create`, `cancellation_policy.update`,
`provider.cancellation_policy.default`).

### 6. No policy is explicit, not blocked

Policies stay optional, as the owner's brief recommended:

- the partner's listing page warns "No cancellation policy set";
- the policies page notes when there is no default;
- customers see "No cancellation policy is set for this listing…" on the listing and "No
  cancellation policy was attached to this booking" on such items;
- booking is not blocked.

This is recorded as gap 30, to decide in Cancellations & refunds (Phase 14).

## Consequences

- **Web:** one `CancellationTerms` component shows a policy everywhere: current terms with their
  source on listings, the "fixed when booked" copy on trips and partner bookings.
- **Partners' tier editor** checks the same rules before sending.
- **Older snapshots** (before this phase) lack `nonRefundable` and `source`; the display tolerates
  that.
- **Refunds** (Phase 14) will read the snapshot's tiers. **Deciding the clock reference** (start
  date at 00:00 Nepal time, or a check-in time) belongs to that phase; this phase stores and shows
  "hours before the start".
