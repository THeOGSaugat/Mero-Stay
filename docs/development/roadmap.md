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
| 6 | Partner & admin backend | Partner onboarding, profile, masked payout account, verification documents (metadata), listings and per-date inventory per vertical, bookings (customer masked), invoices, read-only payout summary, idempotent partner settle-at-property; admin provider list and verification decisions, invoices, payouts, audit log; role guards and provider scoping (ADR 0008) | ✅ Done (awaiting review) |
| 7 | Web frontend | Track A ✅ (awaiting review): customer auth, search, listing details, trip builder with quote/confirm, trip history; same-origin API proxy; money as strings end to end; booking E2E (ADR 0010). Gaps 18–19 closed (ADR 0009). Track B: partner dashboard. Track C: admin dashboard | 🟡 In progress |
| 8 | Admin approvals & moderation | Listing review queue (approve/reject), provider and listing suspension, admin user management (grant/revoke ADMIN), settlement corrections | Planned |
| 9 | Listing media & documents | Private object storage and uploads for listing photos and verification documents (MIME sniffing, EXIF stripping), cancellation-policy management, bulk pricing | Planned |
| 10 | Search UX & locations | Public locations endpoint and province → town picker, richer filters per vertical | Planned |
| 11 | Live payment gateways | eSewa + Khalti (sandbox, then production) behind the Phase 5 payment API: server-to-server verification, signed callbacks, late-success handling | Planned |
| 12 | Cancellations & refunds | Item cancellation using the frozen policy snapshot, refunds per item (`REFUND` payments) | Planned |
| 13 | Commission & payouts | Payout execution for online-paid items, invoice payment tracking, sequential invoice numbering and payment terms (after the tax advisor), settlement reconciliation | Planned |
| 14 | Reviews & ratings | Verified (completed-item) reviews, ratings on listings, partner replies, moderation | Planned |
| 15 | Notifications | `NotificationService` with Sparrow SMS + Amazon SES; email verification and password reset | Planned |
| 16 | Hardening & launch prep | Security review, 2FA (admins/partners), shared rate-limit store, `trust proxy`, performance, accessibility, E2E coverage of key journeys in CI, deployment plan | Planned |

The owner's Phase 5 brief put payments (simulated gateway) before provider onboarding; the
phases after 4 were renumbered. Phase 6 (owner's brief: partner and admin backend) covered the old
"provider onboarding" row and parts of the admin and listings rows, so rows 7 and 8 were restated;
later numbers are unchanged. Phase 7 (owner's brief: the web frontend in three tracks) absorbed
the old customer-web and dashboards rows; the rows after it were restated (admin approvals 8,
listing media 9, search UX 10, live gateways 11, cancellations 12, commission & payouts 13).
The next phase is whichever the owner approves.

Business decisions behind these phases: [requirements §6](../product/requirements.md#6-business-decisions).

## Future (post-MVP, not scheduled)

| Item | How it fits the data model |
|---|---|
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
