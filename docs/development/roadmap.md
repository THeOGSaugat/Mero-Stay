# Development Roadmap

Each phase is developed, tested, documented, committed and pushed, then **reviewed and approved by
the owner before the next phase begins**. Scope may be adjusted at review time.

MeroStay is a multi-vertical travel marketplace (see [requirements](../product/requirements.md)).
Phases from 3 onward cover **all MVP verticals** (hotels, buses, guides, tours, activities) on the
generic data model, not hotels only.

| # | Phase | Main deliverables | Status |
|---|---|---|---|
| 0 | Repository setup & documentation | Git checks, `.gitignore`, CLAUDE.md, docs structure | ✅ Done |
| 1 | Project foundation & dev environment | npm workspaces, Next.js + Tailwind, Express + TS API, Neon PostgreSQL (ADR 0003), Prisma, ESLint/Prettier, Vitest + Playwright, health checks, CI | ✅ Done (v0.1.0) |
| 2 | Multi-vertical data model | Generic provider / listing / trip / booking-item schema with detail tables, inventory, per-item commission, payment and cancellation; shapes for payments, payouts, invoices, reviews, notifications; DB integrity constraints; sample seed; separate test database; schema tests (ADR 0004) | ✅ Done (merged) |
| 3 | Search & booking API | Vertical-agnostic `/api/v1` search (listing types, listings, details + availability) and trip API (create, add/update/remove items with inventory holds, quote dry-run, confirm); money as minor-unit strings; DB-constraint error mapping; temporary unauthenticated access, off in production (ADR 0005, [api.md](../architecture/api.md)) | ✅ Done (v0.3.0) |
| 4 | Authentication & ownership | Customer registration/login/logout/me with Argon2id passwords and server-side sessions in httpOnly cookies, CSRF tokens, rate limits; trips always authenticated and owner-only (404 for others); customer view hides commission/payout; unauthenticated flag removed (ADR 0006) | ✅ Done (v0.4.0) |
| 5 | Payments, invoices & hold-release job | Provider-agnostic payment intents (one open per trip) and idempotent confirmation with a simulated gateway; per-item allocation with partial payments; admin pay-at-property settlement; commission invoices for pay-at-property items; scheduled hold-release worker; database guards for every payment/invoice formula (ADR 0007) | ✅ Done (v0.5.0) |
| 6 | Partner & admin backend | Partner onboarding, profile, masked payout account, verification documents (metadata), listings and per-date inventory per vertical, bookings (customer masked), invoices, read-only payout summary, idempotent partner settle-at-property; admin provider list and verification decisions, invoices, payouts, audit log; role guards and provider scoping (ADR 0008) | ✅ Done (v0.6.0) |
| 7 | Web frontend | Customer site (Track A, ADR 0010), partner dashboard (Track B, ADR 0011), admin console (Track C, ADR 0012); gaps 18–19 closed (ADR 0009) | ✅ Done (v0.7.0) |
| 8 | Listing rules & admin lists | Owner-narrowed scope: data-driven provider-type → listing-type rule with DB guard, partner form limited to allowed types, read-only admin rules page (gap 22, ADR 0013); admin search, stable ordering, paging past 100, audit actor names (gap 25) | ✅ Done (v0.8.0) |
| 9 | Rate limits behind the proxy & E2E in CI | Owner-narrowed scope: per-client login/registration limits behind the web proxy (web server appends the client address; explicit trusted-proxy chain, never `true`; spoofing tests), gap 5, ADR 0014; Playwright journeys in CI on a disposable database, gap 21 | ✅ Done (v0.9.0) |
| 10 | Cancellation policies & verification documents | Owner-narrowed scope: partner-authored cancellation policies (refund tiers or non-refundable), provider default and listing override, frozen per booking item, shown on listings and bookings (gap 23, ADR 0015); real, private verification document uploads with a storage abstraction (local disk, S3-compatible), type checked from the bytes, metadata stripped, owner/admin-only downloads, deletion (gap 14, ADR 0016) | ✅ Done (v0.10.0) |
| — | Frontend polish (not yet scheduled) | Listing photos (public images on the Phase 10 storage abstraction: upload, resizing, re-encoding, display) and bulk pricing tools for partners (moved here from the old Phase 10 row, owner decision after Phase 10). The owner sets the phase | Not scheduled |
| 11 | Live payment gateways | eSewa ePay v2 + Khalti ePayment v2 behind one gateway interface (amounts normalised to paisa in the adapters), server-to-server verification (eSewa signature + status API, Khalti lookup), no-session callback endpoint, idempotent repeats, late success recorded for reconciliation (gaps 7 and 8), refund request shape and gateway refund capability (not executed), production refuses to start without gateway config, local fake gateways for tests, opt-in UAT/sandbox check (ADR 0017) | ✅ Done (v0.11.0) |
| 12 | Payouts & admin moderation | Owner's Phase 12 brief merged Commission & payouts with Admin moderation: payout batches by recorded manual bank transfer, monthly per provider after the service (gap 16); admin accounts with one-time setup links, last-admin protection (gap 9); listing review with the listing-type rule re-checked (gap 15); voids and settlement corrections with refund requests and invoice adjustments (gap 13); admin queues for late payments and refunds (gap 34); scheduled re-checks of closed gateway payments (gap 33) (ADR 0018) | ✅ Done (v0.12.0) |
| 13 | UI design system & restyle | Owner's Phase 13 brief: design tokens (forest green, warm orange), shared components (Button, Card, Badge, inputs, header, footer, listing card, search card), homepage, search, listing detail, trip and checkout restyled to the owner's mockups (set 2), dashboards on the same system; only real data, illustrative images, `Rs.` prices; no backend change (ADR 0019, [frontend.md](../architecture/frontend.md)) | ✅ Done (pending review) |
| 14 | Search UX & locations | Province → town picker (or type-ahead) in customer search over the `GET /locations` endpoint added in Phase 7, richer filters per vertical (gap 20) | Planned |
| 15 | Cancellations & refunds | Item cancellation using the frozen policy snapshot, refund EXECUTION per item on the Phase 11 refund-request shape (`REFUND` payments, Khalti refund API, eSewa by merchant portal), clawback of paid-out bookings (gap 39); decide whether a listing must have a cancellation policy (gap 30) and the clock reference for "hours before the start": midnight Nepal time of the service date or the check-in/departure time (ADR 0015, ADR 0017) | Planned |
| 16 | Reviews & ratings | Verified (completed-item) reviews, ratings on listings, partner replies, moderation | Planned |
| 17 | Notifications | `NotificationService` with Sparrow SMS + Amazon SES; email verification and password reset; admin setup links by email (gap 37) | Planned |
| 18 | Hardening & launch prep | Security review, 2FA (admins/partners), shared rate-limit store (gap 4), document malware scanning (gap 26), production document storage (gap 27, on the launch checklist), document backup and retention after the owner's decision (gap 28), PDF metadata and image re-encoding (gap 29), Content-Security-Policy (must allow eSewa in `form-action`), daily gateway statement comparison (gap 33), performance, accessibility, deployment plan | Planned |

The owner's Phase 5 brief put payments (simulated gateway) before provider onboarding; the
phases after 4 were renumbered. Phase 6 (owner's brief: partner and admin backend) covered the old
"provider onboarding" row and parts of the admin and listings rows, so rows 7 and 8 were restated;
later numbers are unchanged. Phase 7 (owner's brief: the web frontend in three tracks) absorbed
the old customer-web and dashboards rows; the rows after it were restated (admin approvals 8,
listing media 9, search UX 10, live gateways 11, cancellations 12, commission & payouts 13).
Phase 9 (owner's brief: gaps 5 and 21) was inserted, so every later row moved down by one
(listing media 10 … hardening 17).
After Phase 9 the owner assigned Admin moderation (gaps 9, 13, 15) to Phase 12; the rows from
live gateways on moved down by one (live gateways 13 … hardening 18).
Phase 10 was narrowed by the owner to gaps 23 and 14; listing photos and bulk pricing are in the
unscheduled "Frontend polish" row (no renumbering).
The owner's Phase 11 brief (live payment gateways) set the order of the rest: 11 Live payment
gateways, 12 Commission & payouts, 13 Admin moderation, 14 Search UX, 15 Cancellations & refunds,
16 Reviews, 17 Notifications, 18 Hardening. Gap targets in operational-gaps.md follow it.
The owner's Phase 12 brief merged Commission & payouts and Admin moderation into Phase 12 (owner
decision 2026-11-26: shift up by one): 13 Search UX, 14 Cancellations & refunds, 15 Reviews,
16 Notifications, 17 Hardening. Not in that brief and still open: sequential invoice numbering and
payment terms (gap 10, after the tax advisor), invoice payment tracking (gap 35), settlement
reconciliation (gap 36), provider/listing suspension tools and re-review of edited listings
(gap 38); the owner schedules them.
The owner's Phase 13 brief (UI design system and restyle) took number 13 (owner decision
2026-11-27): 14 Search UX, 15 Cancellations & refunds, 16 Reviews, 17 Notifications, 18 Hardening.
The next phase is whichever the owner approves.

Business decisions behind these phases: [requirements §6](../product/requirements.md#6-business-decisions).

## Future (post-MVP, not scheduled)

| Item | How it fits the data model |
|---|---|
| More payment gateways (Fonepay, Stripe) | One more adapter each behind the Phase 11 gateway interface; `payments.gateway` gains a value (CHECK). What each needs: ADR 0017 §Future adapters. Documented only; no code until approved |
| Flight booking | `flight_ticket` listing type and `flight_route_details` already exist; set the type active and build the flow |
| Partner API integrations (airlines, bus operators, channel managers) | `providers.integration_type`, `listings.external_id`, `last_synced_at`, `booking_items.external_booking_ref` |
| New verticals (e.g. permits, vehicle rental, packages) | New `listing_types` row (+ optional `*_details` table); see [data-model.md](../architecture/data-model.md#adding-a-new-vertical) |
| Multi-currency trips | Currency already stored per listing, item and trip |
| Mobile applications | Use the same versioned REST API |

## Definition of done (every phase)

- [ ] Scope matches the approved phase, with nothing extra
- [ ] Lint and type-check pass
- [ ] Tests written and passing (real output shown in the phase report)
- [ ] Responsive on mobile and desktop (for UI work)
- [ ] Phase report written in `docs/phases/`
- [ ] Secret checklist run; no secrets or unwanted files committed
- [ ] Committed with Conventional Commit messages and pushed to GitHub
- [ ] Owner has reviewed and approved
