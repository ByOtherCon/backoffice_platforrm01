-- Whether a project suggestion is strong enough to import without a person (contract code, a remembered customer, or "GC:Job" naming).
ALTER TABLE qb_invoices ADD COLUMN IF NOT EXISTS confident boolean NOT NULL DEFAULT false;
