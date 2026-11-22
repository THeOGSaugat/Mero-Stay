# Product Requirements: MeroStay

## 1. Vision

MeroStay is a **multi-vertical Nepal travel marketplace**. A traveller plans a journey and books
everything it needs in **one trip**: stays, bus seats, guides, tours and activities, from
several independent providers, with one checkout.

It also gives local providers (hotels, homestays, bus operators, guides and tour operators,
including very small ones) an easy way to reach travellers.

### 1.1 The trip concept

A **trip** is one order. It contains **booking items** of different types from different providers:

| Example journey | Booking items in one trip |
|---|---|
| Inaruwa → Shree Antu | Bus seats (bus operator) + 2 nights in a homestay (hotel provider) |
| Annapurna Base Camp trek | Flight or bus to Pokhara + licensed guide for 7 days + trek/tour or activities + teahouse rooms |

Each item keeps its own price, payment status, cancellation policy, commission and provider
payout. The trip stores totals that are the sum of its items.

### 1.2 How MeroStay earns: 15% commission per item

- MeroStay takes **15%** of each booking item's **subtotal** (price × quantity), excluding taxes
  and service charges.
- Commission is calculated **per item** (rounded half-up to the nearest paisa) and the
  **trip-level total commission is the sum** of the item commissions, stored on the trip.
- The customer pays the **listed price** (plus any VAT/service charge). Commission is
  **deducted from the provider's share**, not added on top for the customer.
- The 15% is the platform default. The rate is copied onto each item at booking time, so
  per-provider or per-listing rates can override it without changing past bookings.
- **Pay-at-property** items still owe commission: the provider collects the money and MeroStay
  **invoices** the commission. For online-paid items the commission is **deducted from the payout**.

### 1.3 Business model for the MVP: aggregator

Providers list and manage **their own inventory** on MeroStay. There are **no direct
integrations** with airline, bus or hotel systems in the MVP; the data model leaves room for
them later (integration type, external IDs, sync timestamps).

## 2. User roles

| Role | Goals |
|---|---|
| **Customer** (traveller) | Plan a journey, see real prices and availability, book several items in one trip, pay online or at the property, manage trips |
| **Partner** (provider) | Hotels, homestays, bus operators, guides, tour/activity operators: get verified, list inventory, manage prices/availability, receive bookings and payouts |
| **Admin** | Verify providers, approve listings, oversee trips, payments, commission invoices and payouts |

## 3. MVP scope

### 3.1 Verticals

| Vertical | Listing type(s) | MVP status |
|---|---|---|
| Hotels / homestays / teahouses | `hotel` (the property) + `hotel_room` (bookable) | **Built** |
| Buses | `bus_ticket` (a scheduled service; one inventory row per travel date) | **Built** |
| Guides | `guide_service` (per day) | **Built** |
| Tours / treks | `tour` (per person; one inventory row per departure date) | **Built** |
| Activities | `activity` (per person; generic attributes) | Built if trivial (included in the generic model) |
| Flights | `flight_ticket` | **Modelled, not built**: tables exist; not bookable, no integration |

### 3.2 Features and user stories

**Accounts**
- Customers register and log in (email or phone).
- Partners register, choose a provider type, and submit verification documents (§6.2 item 4).

**Provider onboarding and listings**
- Partners create listings of their type: hotel properties with room types, bus services, guide
  services, tours and activities. Listings go `DRAFT → PENDING_REVIEW → APPROVED/REJECTED`.
- Admins verify providers and approve listings. Only approved listings are public.

**Availability and pricing**
- Each bookable listing has one inventory row per service date (night, departure, guide-day)
  with capacity and an optional date-specific price.
- The system never sells more units than are available (enforced by the database).

**Search and discovery**
- Search stays by destination and dates; buses by origin, destination and date; guides and
  tours by region and date. Combined journey suggestions (e.g. bus + stay at the destination)
  come later.

**Trip booking**
- A customer adds items of different types to one trip and checks out once.
- Per item: dates, quantity, travellers, price snapshot, cancellation policy snapshot,
  payment choice (online or at property).
- Unpaid online items expire and release their inventory.

**Payments**
- Online payment via **eSewa** or **Khalti**, verified server-to-server. One payment can cover
  several items and is allocated per item. Pay-at-property is chosen per item.

**Commission and payouts**
- Commission per item (§1.2). Payouts to providers for online-paid items (net of commission);
  commission invoices for pay-at-property items.

**Dashboards**
- Customer: trips and their items. Partner: listings, availability, bookings, earnings,
  commission owed. Admin: verifications, approvals, trips, payments, invoices, payouts.

**Reviews** (§6.2 item 5) and **notifications** (§6.2 item 6).

## 4. Non-functional requirements

- **Responsive:** mobile-first; usable from 360px width.
- **Performance:** fast on Nepali mobile networks; public pages server-rendered and SEO-friendly.
- **Security:** see [security guidelines](../security/security-guidelines.md).
- **Reliability:** no double bookings; money stored as 64-bit integers in minor units with a currency
  code; consistency enforced by database constraints.
- **Accessibility:** WCAG 2.1 AA as the target.
- **Localization-ready:** English first; Nepali later.
- **Extensible:** new verticals must not require changes to core tables (see
  [ADR 0004](../architecture/decisions/0004-multi-vertical-data-model.md)).

## 5. Out of scope for the MVP (future)

- Flight booking and airline integrations (flights are modelled only)
- Direct API integrations with bus operators, hotels or channel managers
- Bus seat maps and seat selection (seat numbers can be stored per item; no seat-map UI)
- Packages sold as one product (a trip already combines items)
- Multi-currency trips and currency conversion
- Native mobile applications

## 6. Business decisions

Recorded 2026-11-18, updated 2026-11-19 for the multi-vertical model. The data model (Phase 2)
stores these decisions; the flows that use them are built in later phases.

### 6.1 Decided by the owner

| # | Question | Decision |
|---|---|---|
| 1 | Does MeroStay take a commission? | **Yes: 15% of each booking item's subtotal**, calculated per item, trip total stored. Configurable default; per-provider/per-listing overrides allowed |
| 2 | Can customers pay at the property? | **Yes.** Each item is paid **online or at the property** (payment status is per item) |
| 3 | Cancellation policy | **Per item.** Providers/listings define policies; the policy is **snapshotted onto each booking item** so later edits never change existing bookings |

Phase 2 design decisions confirmed by the owner (2026-11-19):

| Topic | Decision |
|---|---|
| Commission base | Item subtotal only; VAT and service charge excluded |
| Who pays commission | Deducted from the provider's share; the customer pays the listed price |
| Calculation | Per item, rate stored in basis points (1500 = 15%), rounded half-up to the paisa; trip total = sum of item commissions |
| Type-specific data | Hybrid: detail tables for verticals that search must query, plus a JSON `attributes` field |
| Currency | ISO currency code on listings, items and trips (`NPR` default); amounts in minor units; one currency per trip in the MVP |
| Users | Minimal `User` model now; credentials and sessions in the auth phase |
| MVP scope | Hotels, buses, guides/tours (activities if trivial); flights modelled, not built |
| Test database | A separate Neon branch, wiped and rebuilt on every integration test run |

*Invoicing decisions* (numbering, payment terms, cadence, payout schedule) are recorded in one
place: [operational-gaps.md → Owner decisions on invoicing](../development/operational-gaps.md#owner-decisions-on-invoicing-recorded-2026-11-21-after-phase-5).

*Still to confirm in the phase that needs them (do not assume):*
- Whether each provider may disable pay-at-property for their listings.
- Cancellation policy presets to offer partners (the seed contains *sample* templates only).
- VAT/service-charge handling per vertical (hotels: 10% service charge then 13% VAT is
  implemented as the default formula) — confirm with a Nepali tax advisor before launch.

### 6.2 Delegated to the tech lead: recommendations (owner approved)

**4. Partner verification documents** (stored in `provider_documents`, private, admin-only)

| Document | Hotels / guesthouses | Homestays | Bus operators | Guides | Tour / activity operators |
|---|---|---|---|---|---|
| Owner or authorised representative's ID (citizenship or passport) | Required | Required | Required | Required | Required |
| Business registration (company/firm) | Required | Local-government homestay registration instead | Required | If operating as a business | Required |
| PAN certificate (VAT certificate if registered) | Required | If they have one | Required | If they have one | Required |
| Tourism / operating licence | Where applicable | Optional | Route permit (`VEHICLE_ROUTE_PERMIT`) | Guide licence (`GUIDE_LICENSE`) | Where applicable |
| Proof of right to operate (ownership or lease) | On request | On request | n/a | n/a | n/a |
| Bank account details | For online payouts | For online payouts | For online payouts | For online payouts | For online payouts |

*Legal requirements should be confirmed with a Nepali legal/tax advisor before launch.*

**5. Reviews and ratings: in the MVP, verified only**
- Only a customer with a **completed** booking item can review it; one review per booking item.
- 1–5 stars plus optional text; providers can reply once; admins can hide reviews.

**6. Notification services**
- **SMS: Sparrow SMS** (Aakash SMS as fallback). **Email: Amazon SES.**
- Behind a `NotificationService` interface; every message is recorded in `notifications`.
  In development, messages are never sent to real phones or inboxes.
