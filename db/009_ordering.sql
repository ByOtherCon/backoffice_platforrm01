-- Keep the order lines were entered in (ids are random, so they cannot be used to sort).
ALTER TABLE supplier_allocations ADD COLUMN IF NOT EXISTS seq bigserial;
ALTER TABLE time_entry_lines ADD COLUMN IF NOT EXISTS seq bigserial;
