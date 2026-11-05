-- QuickBooks costs (bills, checks, expenses, card charges) land here first. A person confirms the project / trade / overhead each belongs to,
-- and only then does it become a vendor invoice in Job Costing. Non-project vendors (IRS, insurance...) can be hidden, and the choice is remembered.
ALTER TABLE supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_source_check;
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_source_check CHECK (source IN ('Manual','AI','QuickBooks'));

CREATE TABLE IF NOT EXISTS qb_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qb_type text NOT NULL CHECK (qb_type IN ('Bill','Purchase')),
  qb_id text NOT NULL,
  kind text NOT NULL,                                -- Bill, Check, Expense, Credit Card
  doc_number text,
  txn_date date,
  total numeric(14,2) NOT NULL,
  balance numeric(14,2),
  vendor_key text NOT NULL,
  vendor_id text,
  vendor_name text,
  account text,
  memo text,
  lines jsonb NOT NULL DEFAULT '[]',
  qb_updated timestamptz,
  status text NOT NULL DEFAULT 'New' CHECK (status IN ('New','Imported','Ignored','Hidden','Changed')),
  suggested_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  suggested_overhead text,
  suggested_by text,
  rule_id uuid,
  supplier_invoice_id uuid REFERENCES supplier_invoices(id) ON DELETE SET NULL,
  message text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  imported_at timestamptz,
  imported_total numeric(14,2),
  UNIQUE (qb_type, qb_id)
);
CREATE INDEX IF NOT EXISTS qb_costs_status ON qb_costs(status, txn_date DESC);
CREATE INDEX IF NOT EXISTS qb_costs_vendor ON qb_costs(vendor_key);
-- one row per bill payment per bill it paid
CREATE TABLE IF NOT EXISTS qb_cost_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qb_id text NOT NULL,
  bill_qb_id text NOT NULL,
  paid_date date NOT NULL,
  amount numeric(14,2) NOT NULL,
  imported boolean NOT NULL DEFAULT false,
  UNIQUE (qb_id, bill_qb_id)
);
-- What was learned about a QuickBooks vendor: hide it (not a project cost), or where its costs usually go.
CREATE TABLE IF NOT EXISTS qb_vendor_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_key text NOT NULL UNIQUE,
  vendor_name text,
  hide boolean NOT NULL DEFAULT false,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  overhead_category text,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
