# Development Roadmap

Each phase is developed, tested, documented, committed and pushed, then **reviewed and approved by
the owner before the next phase begins**. Scope may be adjusted at review time.

| # | Phase | Main deliverables | Status |
|---|---|---|---|
| 0 | Repository setup & documentation | Git checks, `.gitignore`, CLAUDE.md, docs structure | ✅ Done (awaiting review) |
| 1 | Monorepo scaffolding & tooling | npm workspaces, Next.js + Tailwind app, Express + TS app, shared package, Docker Postgres, Prisma init, ESLint/Prettier, Vitest + Playwright set up, health-check endpoint and page, CI (GitHub Actions) | ⏳ Awaiting approval |
| 2 | Data model | Prisma schema for users, partners, properties, rooms, rates/inventory, bookings, payments; migrations; seed data; repository tests | Planned |
| 3 | Authentication & roles | Customer + partner registration, login/logout, password hashing, sessions/tokens, role & ownership guards, auth pages | Planned |
| 4 | Property submission | Partner creates/edits property drafts, photos upload, submit for review | Planned |
| 5 | Admin approval & admin basics | Admin login, pending queue, approve/reject with reason, property/user lists | Planned |
| 6 | Rooms, pricing & availability | Room types CRUD, base price, date overrides, inventory calendar, overbooking protection | Planned |
| 7 | Listings, search & filters | Public listing pages, search by destination/dates/guests, filters, sorting, pagination | Planned |
| 8 | Property details | SSR details page, gallery, amenities, policies, room availability for chosen dates | Planned |
| 9 | Booking flow & management | Create booking (transactional), price snapshot, cancellation, booking state machine, expiry of unpaid bookings | Planned |
| 10 | Payments | eSewa + Khalti integration (sandbox), server verification, idempotent callbacks, payment records | Planned |
| 11 | Dashboards | Customer, partner and admin dashboards completed with real data | Planned |
| 12 | Hardening & launch prep | Security review, performance, accessibility, E2E coverage of key journeys, deployment plan | Planned |

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
