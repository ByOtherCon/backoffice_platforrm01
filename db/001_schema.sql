-- By Other TC-JC System: core schema (PostgreSQL). Single company, 1-5 users.
-- Money is stored as NUMERIC(14,2). Trades are shared names; project_trades holds per-project amounts.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  role text NOT NULL CHECK (role IN ('Admin','Sub-Admin','Office','Project Manager','Estimator','Employee')),
  employee_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Admin-owned master records ------------------------------------------------
CREATE TABLE trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  sort int NOT NULL DEFAULT 0,
  archived boolean NOT NULL DEFAULT false
);
CREATE TABLE gcs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  archived boolean NOT NULL DEFAULT false
);
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('Contract','Proposal','COI','W-9','Exemption','Approved CO','Invoice','Supplier Statement','Employee ID','Other')),
  name text NOT NULL,
  storage_key text,
  url text CHECK (url IS NULL OR url ~ '^https://'),
  expires_on date,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (storage_key IS NOT NULL OR url IS NOT NULL)
);
CREATE TABLE subcontractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  email text, phone text, address text,
  coi_document_id uuid REFERENCES documents(id),
  w9_document_id uuid REFERENCES documents(id),
  exemption_document_id uuid REFERENCES documents(id),
  qb_vendor_id text,
  archived boolean NOT NULL DEFAULT false
);
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  provider_type text NOT NULL DEFAULT 'Supplier' CHECK (provider_type IN ('Supplier','Equipment Provider','Vendor')),
  credit_limit numeric(14,2) NOT NULL DEFAULT 0,
  email text, phone text, address text,
  coi_document_id uuid REFERENCES documents(id),
  w9_document_id uuid REFERENCES documents(id),
  qb_vendor_id text,
  archived boolean NOT NULL DEFAULT false
);
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  position text CHECK (position IN ('Skilled Labor','Carpenter','Carpenter Helper','Foreman','Supervisor')),
  hourly_rate numeric(10,2) NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE app_users ADD FOREIGN KEY (employee_id) REFERENCES employees(id);

-- Projects, contracts, trades ---------------------------------------------------
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  gc_id uuid NOT NULL REFERENCES gcs(id),
  client text NOT NULL,
  address text NOT NULL,
  proposal_id text,                       -- e.g. P1028-1, links back to estimating
  contract_document_id uuid REFERENCES documents(id),
  retainage_pct numeric(5,2) NOT NULL DEFAULT 10 CHECK (retainage_pct BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  logged_date date, start_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_members (            -- who may see which project
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE project_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trade_id uuid NOT NULL REFERENCES trades(id),
  original_amount numeric(14,2) NOT NULL CHECK (original_amount >= 0),
  UNIQUE (project_id, trade_id)
);
CREATE TABLE change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_trade_id uuid NOT NULL REFERENCES project_trades(id),
  number text NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  approved_date date,
  amount numeric(14,2) NOT NULL,           -- revenue change, may be negative
  document_id uuid REFERENCES documents(id),
  UNIQUE (project_id, number),
  CHECK (status <> 'Approved' OR approved_date IS NOT NULL)
);

-- Customer side: progress billing -------------------------------------------------
CREATE TABLE sov_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_trade_id uuid NOT NULL REFERENCES project_trades(id) ON DELETE CASCADE,
  description text NOT NULL,
  scheduled_value numeric(14,2) NOT NULL CHECK (scheduled_value >= 0)
);
CREATE TABLE client_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_trade_id uuid REFERENCES project_trades(id),   -- null = project-level
  number text NOT NULL,
  invoice_date date NOT NULL,
  due_date date,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  retainage_held numeric(14,2) NOT NULL DEFAULT 0 CHECK (retainage_held >= 0),
  document_id uuid REFERENCES documents(id),
  qb_invoice_id text UNIQUE,
  UNIQUE (project_id, number, project_trade_id),
  CHECK (retainage_held <= amount),
  CHECK (due_date IS NULL OR due_date >= invoice_date)
);
CREATE TABLE client_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_invoice_id uuid NOT NULL REFERENCES client_invoices(id) ON DELETE CASCADE,
  paid_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  kind text NOT NULL DEFAULT 'Payment' CHECK (kind IN ('Payment','Retainage Release')),
  qb_payment_id text UNIQUE
);

-- Vendor side: subcontractors ------------------------------------------------------
CREATE TABLE sub_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_trade_id uuid REFERENCES project_trades(id),
  subcontractor_id uuid NOT NULL REFERENCES subcontractors(id),
  contract_amount numeric(14,2) NOT NULL CHECK (contract_amount >= 0),
  hold_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (hold_amount >= 0),   -- fixed final-payment hold
  hold_reason text,
  hold_released boolean NOT NULL DEFAULT false,
  materials_included boolean NOT NULL DEFAULT false
);
CREATE TABLE sub_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES sub_commitments(id) ON DELETE CASCADE,
  number text NOT NULL,
  invoice_date date,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  document_id uuid REFERENCES documents(id),
  qb_bill_id text UNIQUE,
  UNIQUE (commitment_id, number)
);
CREATE TABLE sub_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_invoice_id uuid NOT NULL REFERENCES sub_invoices(id) ON DELETE CASCADE,
  paid_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  qb_payment_id text UNIQUE
);

-- Vendor side: suppliers (invoice split across projects/trades) ---------------------
CREATE TABLE supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  reference text NOT NULL,
  invoice_date date,
  total numeric(14,2) NOT NULL CHECK (total >= 0),
  document_id uuid REFERENCES documents(id),
  qb_bill_id text UNIQUE,
  UNIQUE (supplier_id, reference)
);
CREATE TABLE supplier_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id),
  project_trade_id uuid REFERENCES project_trades(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0)
);
CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  paid_date date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  qb_payment_id text UNIQUE
);

-- Labor (from time clock) ----------------------------------------------------------
CREATE TABLE labor_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_trade_id uuid REFERENCES project_trades(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  work_date date NOT NULL,
  hours numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  rate numeric(10,2) NOT NULL CHECK (rate >= 0),
  pay numeric(14,2),                      -- explicit pay overrides hours*rate (e.g. overtime)
  source text NOT NULL DEFAULT 'Manual' CHECK (source IN ('Manual','Time clock')),
  import_key text UNIQUE                  -- blocks double import of the same punch
);

-- AI usage and review -------------------------------------------------------------
CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_users(id),
  kind text NOT NULL,
  input_tokens int, output_tokens int,
  credits numeric(10,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_users(id),
  action text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON project_trades(project_id);
CREATE INDEX ON sub_commitments(project_id);
CREATE INDEX ON supplier_allocations(project_id);
CREATE INDEX ON labor_entries(project_id, work_date);
