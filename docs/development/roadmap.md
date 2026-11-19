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
| 3 | Search & booking API | Vertical-agnostic `/api/v1` search (listing types, listings, details + availability) and trip API (create, add/update/remove items with inventory holds, quote dry-run, confirm); money as minor-unit strings; DB-constraint error mapping; temporary unauthenticated access, off in production (ADR 0005, [api.md](../architecture/api.md)) | ✅ Done (awaiting review) |
| 4 | Authentication & roles | Customer + partner registration/login (email or phone), password hashing, sessions, role & ownership guards; replace the temporary `userId` on trip endpoints; hide commission/payout from customers; introduce `packages/shared` | Planned |
| 5 | Provider onboarding & verification | Partner chooses provider type, profile, verification documents (private uploads), payout account | Planned |
| 6 | Admin verification & approvals | Admin queues for providers and listings, approve/reject with reason, user/provider lists | Planned |
| 7 | Listings & inventory management | Partners manage listings per vertical, cancellation policies, per-date inventory and prices | Planned |
| 8 | Customer web: search & trip builder | Search pages per vertical, listing detail pages, multi-item trip builder UI on the Phase 3 API | Planned |
| 9 | Payments | eSewa + Khalti (sandbox), server verification, idempotent callbacks, per-item allocation; scheduled hold-expiry job | Planned |
| 10 | Cancellations & refunds | Item cancellation using the frozen policy snapshot, refunds per item | Planned |
| 11 | Commission & payouts | Commission invoices for pay-at-property items, payouts for online-paid items, admin finance views | Planned |
| 12 | Dashboards | Customer, partner and admin dashboards with real data | Planned |
| 13 | Reviews & ratings | Verified (completed-item) reviews, ratings on listings, partner replies, moderation | Planned |
| 14 | Notifications | `NotificationService` with Sparrow SMS + Amazon SES | Planned |
| 15 | Hardening & launch prep | Security review, performance, accessibility, E2E coverage of key journeys in CI, deployment plan | Planned |

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
