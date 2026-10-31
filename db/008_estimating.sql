-- Estimating: leads -> proposals -> submissions -> follow-ups -> award (creates the project) or loss.
CREATE TABLE IF NOT EXISTS opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  gc_name text NOT NULL,
  additional_gcs text,
  city text, state text NOT NULL DEFAULT 'FL' CHECK (state = 'FL'),
  address text,
  tier int NOT NULL DEFAULT 2 CHECK (tier BETWEEN 1 AND 4),
  mall boolean NOT NULL DEFAULT false,
  project_type text NOT NULL DEFAULT 'Retail' CHECK (project_type IN ('Retail','Restaurant','Office / Medical / Other')),
  due_date date, due_time text CHECK (due_time IS NULL OR due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  contact_name text, contact_email text, contact_phone text,
  invitation_link text CHECK (invitation_link IS NULL OR invitation_link ~ '^https://'),
  status text NOT NULL DEFAULT 'New' CHECK (status IN ('New','Reviewing','Bidding','Submitted','No Bid','Awarded','Lost')),
  progress text NOT NULL DEFAULT 'Not Started' CHECK (progress IN ('Not Started','In Progress','Needs Review','Done')),
  result text NOT NULL DEFAULT 'Pending' CHECK (result IN ('Pending','Awarded','Lost','No Bid')),
  estimator_id uuid REFERENCES app_users(id),
  proposal_id text UNIQUE,
  accepted_date date, start_date date,
  declined_reason text, lost_reason text,
  folder_url text CHECK (folder_url IS NULL OR folder_url ~ '^https://'),
  proposal_url text CHECK (proposal_url IS NULL OR proposal_url ~ '^https://'),
  notes text,
  source text NOT NULL DEFAULT 'Manual',
  source_key text UNIQUE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunities_status ON opportunities(status, due_date);
CREATE TABLE IF NOT EXISTS opportunity_trades (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  trade_id uuid NOT NULL REFERENCES trades(id),
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (opportunity_id, trade_id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  version int NOT NULL,
  submitted_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('Email','via BuildingConnected','PlanHub','Other')),
  price numeric(14,2) NOT NULL CHECK (price >= 0),
  link text CHECK (link IS NULL OR link ~ '^https://'),
  note text,
  estimator_id uuid REFERENCES app_users(id),
  UNIQUE (opportunity_id, version)
);
CREATE TABLE IF NOT EXISTS communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('First Email Sent','Call / Message','Final Email Sent','Reply Received','Note')),
  comm_date date NOT NULL,
  note text,
  user_id uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS opportunity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id),
  action text NOT NULL, detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings(key, value) VALUES ('estimating', '{"targetMargin":20}') ON CONFLICT DO NOTHING;
