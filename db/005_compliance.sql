-- Vendor compliance, payment approvals, notifications, email outbox, Notices to Owner.
CREATE TABLE IF NOT EXISTS payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sub_invoice_id uuid NOT NULL REFERENCES sub_invoices(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  note text,
  status text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested','Approved','Rejected','Paid')),
  requested_by uuid NOT NULL REFERENCES app_users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES app_users(id),
  decided_at timestamptz,
  reject_reason text,
  paid_date date,
  reference text,
  sub_payment_id uuid REFERENCES sub_payments(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS payment_requests_status ON payment_requests(status);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued','Sent','Failed')),
  kind text,
  related_id uuid,
  dedupe_key text UNIQUE,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

-- One Notice to Owner record per project. 'year' is the year the work started; open projects roll into later years.
CREATE TABLE IF NOT EXISTS project_ntos (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  year int NOT NULL,
  status text NOT NULL DEFAULT 'Needed' CHECK (status IN ('Needed','Sent','Not Required')),
  first_furnished date,
  sent_date date,
  method text,
  recipient text,
  document_url text CHECK (document_url IS NULL OR document_url ~ '^https://'),
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO project_ntos(project_id, year) SELECT id, COALESCE(EXTRACT(YEAR FROM start_date), EXTRACT(YEAR FROM created_at))::int FROM projects ON CONFLICT DO NOTHING;
