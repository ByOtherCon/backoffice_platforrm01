-- AI-assisted plan takeoff. Nothing reaches a proposal until a person verifies it.
CREATE TABLE IF NOT EXISTS takeoff_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'Needs review' CHECK (status IN ('Needs review','Verified','Applied')),
  matrix_found boolean NOT NULL DEFAULT false,
  warnings jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS takeoff_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES takeoff_runs(id) ON DELETE CASCADE,
  section text NOT NULL CHECK (section IN ('Demolition keynote','Wall type','Paint','Carpentry','Other')),
  code text,
  description text NOT NULL,
  sheet text,
  quantity numeric(14,3),
  unit text,
  responsibility text CHECK (responsibility IS NULL OR responsibility IN ('Contractor','By others','Unclear')),
  trade_id uuid REFERENCES trades(id),
  unit_price numeric(14,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  include boolean NOT NULL DEFAULT true,
  verified boolean NOT NULL DEFAULT false,
  notes text,
  seq bigserial
);
CREATE INDEX IF NOT EXISTS takeoff_items_run ON takeoff_items(run_id, seq);
