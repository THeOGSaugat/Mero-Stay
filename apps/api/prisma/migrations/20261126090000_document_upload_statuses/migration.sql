-- Gap 14 (ADR 0016): verification documents get a real upload step.
--
--   AWAITING_UPLOAD → UPLOADED → PENDING (submitted for review) → APPROVED | REJECTED
--
-- The new enum values live in their own migration: PostgreSQL cannot use an enum value in the
-- same transaction that adds it, and the next migration's constraints use them.
ALTER TYPE "document_status" ADD VALUE IF NOT EXISTS 'AWAITING_UPLOAD' BEFORE 'PENDING';
ALTER TYPE "document_status" ADD VALUE IF NOT EXISTS 'UPLOADED' BEFORE 'PENDING';
