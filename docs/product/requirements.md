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
- Customers pay through **eSewa** or **Khalti** (initial providers).
- Payment is verified server-to-server before a booking is confirmed.
- Unpaid bookings expire after a time limit and release their inventory.

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
- Reviews and ratings *(may be pulled into MVP if the owner decides; ratings shown in listings depend on it)*

## 6. Open questions for the owner

1. Commission model: does MeroStay take a percentage per booking, and should the partner dashboard show it?
2. Pay-at-property: should customers be able to book without paying online?
3. Cancellation/refund policy: per-property policies, or a platform-wide default?
4. Partner verification: which documents (e.g. PAN/VAT registration) must partners upload?
5. Reviews/ratings: in MVP or later?
6. Email/SMS notifications: which provider (e.g. Sparrow SMS, Aakash SMS for Nepal)?
