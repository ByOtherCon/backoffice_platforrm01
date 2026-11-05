-- QuickBooks invoices land here first. A person confirms which project (and trades) each belongs to, and only then does it become
-- billing in Job Costing. One QuickBooks invoice can span several trades, so the QuickBooks ids are unique per trade row, not alone.
ALTER TABLE client_invoices DROP CONSTRAINT IF EXISTS client_invoices_qb_invoice_id_key;
ALTER TABLE client_payments DROP CONSTRAINT IF EXISTS client_payments_qb_payment_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS client_invoices_qb ON client_invoices(qb_invoice_id, project_trade_id) WHERE qb_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS client_payments_qb ON client_payments(qb_payment_id, client_invoice_id) WHERE qb_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS qb_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qb_id text NOT NULL UNIQUE,
  doc_number text,
  txn_date date,
  due_date date,
  total numeric(14,2) NOT NULL,
  balance numeric(14,2),
  customer_id text,
  customer_name text,
  memo text,
  lines jsonb NOT NULL DEFAULT '[]',
  qb_updated timestamptz,
  status text NOT NULL DEFAULT 'New' CHECK (status IN ('New','Imported','Ignored','Changed')),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  suggested_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  suggested_by text,
  message text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  imported_at timestamptz,
  imported_total numeric(14,2)
);
CREATE INDEX IF NOT EXISTS qb_invoices_status ON qb_invoices(status, txn_date DESC);
-- one row per payment per invoice it paid
CREATE TABLE IF NOT EXISTS qb_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qb_id text NOT NULL,
  invoice_qb_id text NOT NULL,
  paid_date date NOT NULL,
  amount numeric(14,2) NOT NULL,
  imported boolean NOT NULL DEFAULT false,
  UNIQUE (qb_id, invoice_qb_id)
);
-- "this QuickBooks customer (job) is always that project", remembered from the first confirmed match
CREATE TABLE IF NOT EXISTS qb_customer_map (
  qb_customer_id text PRIMARY KEY,
  customer_name text,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
);
