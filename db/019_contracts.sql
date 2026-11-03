-- Contract / work-order uploads. The AI reads the signed document into a "run" (header, trade lines, payment terms) that a person
-- reviews. Applying it sets the project's trades and amounts and replaces the tentative invoice schedule.
CREATE TABLE IF NOT EXISTS contract_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id),
  kind text NOT NULL DEFAULT 'Contract' CHECK (kind IN ('Contract','Work order')),
  contract_number text,
  contract_date date,
  total numeric(14,2),
  retainage_pct numeric(5,2) CHECK (retainage_pct IS NULL OR retainage_pct BETWEEN 0 AND 100),
  net_days integer CHECK (net_days IS NULL OR net_days BETWEEN 0 AND 365),
  billing_basis text,
  payment_terms text,
  status text NOT NULL DEFAULT 'Needs review' CHECK (status IN ('Needs review','Applied','Superseded')),
  warnings jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS contract_runs_project ON contract_runs(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS contract_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES contract_runs(id) ON DELETE CASCADE,
  description text NOT NULL,
  amount numeric(14,2),
  trade_id uuid REFERENCES trades(id),
  include boolean NOT NULL DEFAULT true,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS contract_lines_run ON contract_lines(run_id, seq);
-- Tentative invoice schedule: what the contract says will be billed and roughly when. QuickBooks invoices are matched to it later.
CREATE TABLE IF NOT EXISTS invoice_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id uuid REFERENCES contract_runs(id) ON DELETE CASCADE,
  label text NOT NULL,
  basis text,
  percent numeric(7,3),
  amount numeric(14,2),
  expected_date date,
  status text NOT NULL DEFAULT 'Tentative' CHECK (status IN ('Tentative','Invoiced','Skipped')),
  client_invoice_id uuid REFERENCES client_invoices(id) ON DELETE SET NULL,
  note text,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS invoice_schedule_project ON invoice_schedule(project_id, seq);
