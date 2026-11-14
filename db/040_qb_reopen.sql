-- A QuickBooks invoice that was changed after it was imported can be sent back to review. "hold" keeps it waiting for a person (it is never
-- imported again automatically), and imported_sig remembers what the invoice looked like when it was imported so a later change is noticed
-- even when the total stays the same.
ALTER TABLE qb_invoices ADD COLUMN IF NOT EXISTS hold boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS imported_sig text;
