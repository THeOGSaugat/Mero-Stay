-- Widen every money column from INTEGER (32-bit, max 2,147,483,647 paisa = about Rs 2.1 crore)
-- to BIGINT (64-bit, about 9.2e18 paisa). Amounts stay integers in minor units.
--
-- Safe to apply to a database that already has data: INTEGER -> BIGINT never loses values.
-- The CHECK constraints from the previous migration reference these columns and are kept;
-- PostgreSQL re-validates them during the change. Rates (*_rate_bps), quantities and
-- sizes stay INTEGER.

-- AlterTable
ALTER TABLE "booking_item_slots" ALTER COLUMN "unit_price_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "amount_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "booking_items" ALTER COLUMN "subtotal_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "service_charge_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "tax_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "total_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "commission_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "provider_payout_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "refunded_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "inventory_slots" ALTER COLUMN "price_override_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "listings" ALTER COLUMN "base_price_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "payment_allocations" ALTER COLUMN "amount_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "amount_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "payouts" ALTER COLUMN "amount_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "provider_invoices" ALTER COLUMN "amount_minor" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "trips" ALTER COLUMN "subtotal_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "service_charge_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "tax_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "total_minor" SET DATA TYPE BIGINT,
ALTER COLUMN "commission_total_minor" SET DATA TYPE BIGINT;

