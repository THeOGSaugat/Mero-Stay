# Product Requirements: MeroStay MVP

## 1. Vision

Make it simple and trustworthy to find and book hotels and homestays anywhere in Nepal, and
give local property owners, including small homestays, an easy way to reach travellers.

## 2. User roles

| Role | Goals |
|---|---|
| **Customer** | Find a suitable stay quickly, see real prices and availability, book and pay with familiar Nepali payment methods, manage bookings |
| **Hotel partner** | Get listed, manage rooms, prices and availability, receive and manage bookings |
| **Admin** | Keep listing quality high, approve or reject properties, resolve booking and payment issues |

## 3. MVP features and user stories

### 3.1 Customer registration and login
- As a customer, I can register with name, email, phone and password.
- As a customer, I can log in and log out securely.
- As a customer, I can reset a forgotten password. *(scope confirmed during auth phase)*

### 3.2 Hotel partner registration
- As a partner, I can register a partner account with business/contact details.
- As a partner, my account is linked to the properties I submit.

### 3.3 Property submission and approval
- As a partner, I can create a property (hotel, guesthouse, homestay, resort) with name, type, description,
  location (province/district/city/address), amenities, policies (check-in/out times, cancellation) and photos.
- As a partner, I can save a draft and submit it for review.
- As an admin, I can review pending properties and approve or reject them with a reason.
- Only approved properties appear publicly.

### 3.4 Hotel and homestay listings
- As a customer, I can browse approved properties with photo, name, location, type, starting price and rating.

### 3.5 Room management
- As a partner, I can add, edit and deactivate room types (name, capacity, bed type, amenities, photos, number of units).

### 3.6 Pricing and availability
- As a partner, I can set a base nightly price per room type.
- As a partner, I can override price and available units for specific dates and block dates.
- The system never sells more units than are available for any night.

### 3.7 Search and filters
- As a customer, I can search by destination, check-in/check-out dates and number of guests.
- As a customer, I can filter by price range, property type, amenities and rating, and sort by price or relevance.

### 3.8 Property details
- As a customer, I can view photos, description, amenities, policies, location, available rooms and prices for my dates.

### 3.9 Booking management
- As a customer, I can book one or more rooms for my dates and receive a confirmation.
- As a customer, I can view and cancel bookings according to the property's policy.
- As a partner, I can view incoming bookings and update their status (e.g. checked-in, completed, no-show).

### 3.10 Customer dashboard
- Upcoming and past bookings, booking details, profile management.

### 3.11 Hotel partner dashboard
- My properties and their approval status, rooms, pricing and availability calendar, bookings, basic earnings summary.

### 3.12 Admin dashboard
- Pending property approvals, property and user management, all bookings, payment overview, basic platform stats.

### 3.13 Payment integration
- Customers pay online through **eSewa** or **Khalti** (initial providers), **or choose to pay at the property** (§6.1).
- Online payment is verified server-to-server before a booking is confirmed.
- Unpaid online bookings expire after a time limit and release their inventory.
- MeroStay earns a commission on every booking (§6.1).

### 3.14 Reviews and ratings
- Customers with a completed stay can rate (1–5) and review it; partners can reply; admins moderate (§6.2).

## 4. Non-functional requirements

- **Responsive:** mobile-first; usable from 360px width.
- **Performance:** fast on Nepali mobile networks; public pages server-rendered and SEO-friendly.
- **Security:** see [security guidelines](../security/security-guidelines.md).
- **Reliability:** no double bookings; consistent money handling (integer paisa).
- **Accessibility:** WCAG 2.1 AA as the target.
- **Localization-ready:** English first; Nepali later.

## 5. Out of scope for MVP (future)

- Tour guides
- Bus tickets
- Flight tickets
- Native mobile applications

*(Reviews and ratings were moved into the MVP; see §6.2.)*

## 6. Business decisions

Recorded 2026-11-18. **Nothing here is implemented yet.** Each decision is built in the phase
listed, and the details marked *to confirm* are raised with the owner at the start of that phase.

### 6.1 Decided by the owner

| # | Question | Decision | Affects |
|---|---|---|---|
| 1 | Does MeroStay take a commission on each booking? | **Yes**, a commission on every booking | Data model (Phase 2), bookings (9), payments (10), partner + admin dashboards (11) |
| 2 | Can customers pay at the property? | **Yes.** Customers can pay **online or at the property** | Data model, booking flow, payments |
| 3 | Cancellation policy: per property or platform-wide? | **Each property sets its own** cancellation policy | Property submission (4), bookings (9) |

*To confirm in the relevant phase (not decided, do not assume):*
- Commission rate: one platform-wide percentage, or adjustable per property by admins?
- How commission is collected on **pay-at-property** bookings (e.g. monthly invoice to the partner).
- Whether pay-at-property is optional per property (a partner may want to accept online only).
- Cancellation policy format: free-text, or structured presets (e.g. "free cancellation until
  N days before check-in, then X% charge") so refunds can be calculated automatically.
  Recommendation: structured presets.

### 6.2 Delegated to the tech lead: recommendations (owner may override)

The owner asked the tech lead to choose for items 4–6. These are **recommendations
adopted as the working plan**, not final policy; the owner can change them at any time.

**4. Partner verification documents**

| Document | Hotels / guesthouses | Homestays | Why |
|---|---|---|---|
| Owner or authorised representative's ID (citizenship certificate or passport) | Required | Required | Identity of the person responsible |
| Business registration certificate (company/firm registration) | Required | Homestay registration with the local government (municipality/ward) instead | Proves the business legally exists |
| PAN certificate (VAT certificate if VAT-registered) | Required | Required if they have one | Needed for commission invoicing and tax records |
| Tourism operating licence (Department of Tourism or local authority) | Required where applicable | Optional | Confirms the property may operate as accommodation |
| Proof of right to operate the property (ownership document or lease agreement) | Requested by admin when needed | Requested by admin when needed | Reduces fraudulent listings without slowing honest partners |
| Bank account details (account name, bank, cheque copy or bank letter) | Required for online payouts | Required for online payouts | Paying partners for online bookings |

Implementation notes: uploads are private (admin-only), size/type-checked, and never shown
publicly. *Legal requirements should be confirmed with a Nepali legal/tax advisor before launch.*

**5. Reviews and ratings: include in the MVP, limited to verified stays**
- Only customers with a **completed** booking can review that stay (prevents fake reviews).
- 1–5 star rating plus optional text; one review per booking.
- Partners can post one public reply; admins can hide abusive content.
- Listings show the average rating and review count (requirement 3.4 already expects this).
- Built after bookings exist (added to the roadmap as its own phase).

**6. Notification services**
- **SMS: Sparrow SMS** (Nepali provider, delivers to NTC and Ncell numbers; widely used for OTPs
  and alerts). Aakash SMS as a fallback option.
- **Email: Amazon SES** (low cost at scale, reliable deliverability; a nearby Asia region keeps latency low).
- Both sit behind a `NotificationService` interface so providers can be swapped without
  touching business logic. In development, messages are logged or captured locally, never
  sent to real phones or inboxes.
- Credentials are stored only as environment secrets.
