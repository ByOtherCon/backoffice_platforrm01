-- Time clock upgrades: a one-off "Other" jobsite, trades chosen at day's end (any trade, project or not), default PINs, and change requests
-- for older days. Hours for a project stay for as long as the project exists.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_default boolean NOT NULL DEFAULT false;   -- the PIN is still the automatic one (last 4 of the phone, else 0000)

ALTER TABLE time_entries ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS other_name text, ADD COLUMN IF NOT EXISTS other_address text, ADD COLUMN IF NOT EXISTS gps_out jsonb;
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_site;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_site CHECK (project_id IS NOT NULL OR other_name IS NOT NULL);
ALTER TABLE time_entry_lines ADD COLUMN IF NOT EXISTS trade_id uuid REFERENCES trades(id);
UPDATE time_entry_lines l SET trade_id = pt.trade_id FROM project_trades pt WHERE pt.id = l.project_trade_id AND l.trade_id IS NULL;

ALTER TABLE labor_entries ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS other_name text, ADD COLUMN IF NOT EXISTS trade_id uuid REFERENCES trades(id);
UPDATE labor_entries l SET trade_id = pt.trade_id FROM project_trades pt WHERE pt.id = l.project_trade_id AND l.trade_id IS NULL;

-- An employee asks the office to change a day older than yesterday; the office applies or declines it.
CREATE TABLE IF NOT EXISTS time_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  message text NOT NULL,
  proposal jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Applied','Declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES app_users(id),
  decided_at timestamptz,
  decision_note text
);
CREATE INDEX IF NOT EXISTS time_corrections_status ON time_corrections(status, created_at DESC);
