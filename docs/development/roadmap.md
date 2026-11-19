# Development Roadmap

Each phase is developed, tested, documented, committed and pushed, then **reviewed and approved by
the owner before the next phase begins**. Scope may be adjusted at review time.

MeroStay is a multi-vertical travel marketplace (see [requirements](../product/requirements.md)).
Phases from 4 onward cover **all MVP verticals** (hotels, buses, guides, tours, activities) on the
generic data model, not hotels only.

| # | Phase | Main deliverables | Status |
|---|---|---|---|
| 0 | Repository setup & documentation | Git checks, `.gitignore`, CLAUDE.md, docs structure | ✅ Done |
| 1 | Project foundation & dev environment | npm workspaces, Next.js + Tailwind, Express + TS API, Neon PostgreSQL (ADR 0003), Prisma, ESLint/Prettier, Vitest + Playwright, health checks, CI | ✅ Done (v0.1.0) |
| 2 | Multi-vertical data model | Generic provider / listing / trip / booking-item schema with detail tables, inventory, per-item commission, payment and cancellation; shapes for payments, payouts, invoices, reviews, notifications; DB integrity constraints; sample seed; separate test database; schema tests (ADR 0004) | ✅ Done (merged) |
| 3 | Authentication & roles | Customer + partner registration/login (email or phone), password hashing, sessions, role & ownership guards; introduce `packages/shared` for Zod contracts | Planned |
| 4 | Provider onboarding & verification | Partner chooses provider type, profile, verification documents (private uploads), payout account | Planned |
| 5 | Admin verification & approvals | Admin queues for providers and listings, approve/reject with reason, user/provider lists | Planned |
| 6 | Listings & inventory management | Partners manage listings per vertical (hotel + rooms, bus services, guide services, tours, activities), cancellation policies, per-date inventory and prices | Planned |
| 7 | Search & discovery | Stays by destination/dates, buses by route/date, guides/tours by region/date; filters, sorting, pagination | Planned |
| 8 | Listing detail pages | SSR detail pages per vertical, availability for chosen dates | Planned |
| 9 | Trip builder & booking | Multi-item trip (cart), transactional inventory holds, price/commission/policy snapshots, per-item payment choice, cancellation with refunds per policy, item state machine, expiry | Planned |
| 10 | Payments | eSewa + Khalti (sandbox), server verification, idempotent callbacks, per-item allocation, refunds | Planned |
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
