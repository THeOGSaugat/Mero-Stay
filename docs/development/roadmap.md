# Development Roadmap

Each phase is developed, tested, documented, committed and pushed, then **reviewed and approved by
the owner before the next phase begins**. Scope may be adjusted at review time.

| # | Phase | Main deliverables | Status |
|---|---|---|---|
| 0 | Repository setup & documentation | Git checks, `.gitignore`, CLAUDE.md, docs structure | ✅ Done |
| 1 | Project foundation & dev environment | npm workspaces, Next.js + Tailwind app, Express + TS API, Docker PostgreSQL, Prisma (no models), ESLint/Prettier, Vitest + Playwright, health checks end to end, GitHub Actions CI | ✅ Done (awaiting review) |
| 2 | Data model | Prisma schema for users, partners, properties, rooms, rates/inventory, bookings (incl. payment method + commission snapshot), payments; migrations; seed data; separate test database; repository tests | ⏳ Awaiting approval |
| 3 | Authentication & roles | Customer + partner registration, login/logout, password hashing, sessions/tokens, role & ownership guards, auth pages; introduce `packages/shared` for Zod contracts | Planned |
| 4 | Property submission | Partner creates/edits property drafts, photos upload, per-property cancellation policy, verification documents, submit for review | Planned |
| 5 | Admin approval & admin basics | Admin login, pending queue, approve/reject with reason, property/user lists | Planned |
| 6 | Rooms, pricing & availability | Room types CRUD, base price, date overrides, inventory calendar, overbooking protection | Planned |
| 7 | Listings, search & filters | Public listing pages, search by destination/dates/guests, filters, sorting, pagination | Planned |
| 8 | Property details | SSR details page, gallery, amenities, policies, room availability for chosen dates | Planned |
| 9 | Booking flow & management | Create booking (transactional), price + commission snapshot, pay online or at property, cancellation per property policy, booking state machine, expiry of unpaid online bookings | Planned |
| 10 | Payments | eSewa + Khalti integration (sandbox), server verification, idempotent callbacks, payment records | Planned |
| 11 | Dashboards | Customer, partner and admin dashboards completed with real data (incl. commission reporting) | Planned |
| 12 | Reviews & ratings | Verified-stay reviews, ratings on listings, partner replies, admin moderation | Planned |
| 13 | Notifications | `NotificationService` with Sparrow SMS + Amazon SES (booking confirmations, OTP if needed) | Planned |
| 14 | Hardening & launch prep | Security review, performance, accessibility, E2E coverage of key journeys in CI, deployment plan | Planned |

Business decisions behind these phases: [requirements §6](../product/requirements.md#6-business-decisions).

## Future (post-MVP, not scheduled)

- Tour guides
- Bus tickets
- Flight tickets
- Mobile applications

## Definition of done (every phase)

- [ ] Scope matches the approved phase, with nothing extra
- [ ] Lint and type-check pass
- [ ] Tests written and passing (real output shown in the phase report)
- [ ] Responsive on mobile and desktop (for UI work)
- [ ] Phase report written in `docs/phases/`
- [ ] Secret checklist run; no secrets or unwanted files committed
- [ ] Committed with Conventional Commit messages and pushed to GitHub
- [ ] Owner has reviewed and approved
