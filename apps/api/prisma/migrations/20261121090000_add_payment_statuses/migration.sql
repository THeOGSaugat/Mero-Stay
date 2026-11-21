-- Phase 5 (ADR 0007): per-item payment states needed by the payments flow.
--
-- Kept in its own migration on purpose: PostgreSQL does not allow a newly added enum value to be
-- used in the same transaction that adds it, and the next migration's CHECK constraints and
-- triggers refer to these values.

-- Online item with part of its total allocated from succeeded payments.
ALTER TYPE "payment_status" ADD VALUE 'PARTIALLY_PAID' AFTER 'UNPAID';

-- Pay-at-property item that the provider confirmed was paid on arrival.
ALTER TYPE "payment_status" ADD VALUE 'PAID_AT_PROPERTY' AFTER 'PAY_AT_PROPERTY';
