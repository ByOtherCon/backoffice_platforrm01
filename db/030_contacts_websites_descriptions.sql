-- A contact person for each subcontractor, a website for vendors (an address is optional), and a description on vendor invoices.
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS description text;
