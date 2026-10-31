-- Team titles, documents (uploads), receipts/expenses on supplier invoices, company overhead.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS title text;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_category_check;
ALTER TABLE documents ADD CONSTRAINT documents_category_check CHECK (category IN ('Contract','Proposal','COI','W-9','Exemption','Approved CO','Invoice','Client Invoice','Vendor Invoice','Receipt','Plans','Notice to Owner','Supplier Statement','Employee ID','Other'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS size int;
CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id, category);

-- Receipts and supplier invoices can be split to projects/trades, or to company overhead (tools, insurance, etc.).
ALTER TABLE supplier_allocations ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE supplier_allocations ADD COLUMN IF NOT EXISTS overhead_category text;
ALTER TABLE supplier_allocations ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE supplier_allocations ADD COLUMN IF NOT EXISTS item_kind text CHECK (item_kind IS NULL OR item_kind IN ('Materials','Tools','Equipment','Other'));
ALTER TABLE supplier_allocations DROP CONSTRAINT IF EXISTS allocation_target;
ALTER TABLE supplier_allocations ADD CONSTRAINT allocation_target CHECK ((project_id IS NOT NULL) <> (overhead_category IS NOT NULL));
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS tax numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'Manual' CHECK (source IN ('Manual','AI'));

-- Company overhead, spread across projects. 'percent_of_revenue' or a fixed amount per year.
CREATE TABLE IF NOT EXISTS overhead_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent_of_revenue','fixed_annual')),
  value numeric(14,4) NOT NULL CHECK (value >= 0),
  active boolean NOT NULL DEFAULT true,
  notes text
);
INSERT INTO app_settings(key, value) VALUES ('overhead', '{"basis":"contract"}') ON CONFLICT DO NOTHING;
INSERT INTO app_settings(key, value) VALUES ('ai', '{"monthlyTokenCap":2000000}') ON CONFLICT DO NOTHING;
