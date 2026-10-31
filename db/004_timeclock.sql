-- Time clock lives inside the platform: crew sign in with a PIN, pick an active project and trade, and hours post to labor cost.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pay_type text NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly','daily'));
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_failed int NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email text;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS lat numeric(9,6);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lng numeric(9,6);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geofence_required boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geofence_miles numeric(5,2) NOT NULL DEFAULT 3;

ALTER TABLE sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id) ON DELETE CASCADE;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_one_owner;
ALTER TABLE sessions ADD CONSTRAINT sessions_one_owner CHECK ((user_id IS NOT NULL) <> (employee_id IS NOT NULL));

CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  primary_trade_id uuid REFERENCES project_trades(id),   -- trade picked at clock-in
  work_date date NOT NULL,                                 -- Eastern date of clock-in
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  gross_hours numeric(6,2) NOT NULL DEFAULT 0,
  lunch_hours numeric(5,2) NOT NULL DEFAULT 0,
  total_hours numeric(6,2) NOT NULL DEFAULT 0,
  late_in boolean NOT NULL DEFAULT false,
  injured boolean NOT NULL DEFAULT false,
  injury_note text,
  notes text,
  gps_in jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','complete')),
  method text NOT NULL DEFAULT 'Clock' CHECK (method IN ('Clock','Manual')),
  modified_by uuid REFERENCES app_users(id),
  modified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'open' OR clock_out IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_entry_per_employee ON time_entries(employee_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS time_entries_emp_date ON time_entries(employee_id, work_date);
CREATE INDEX IF NOT EXISTS time_entries_project ON time_entries(project_id, work_date);
CREATE TABLE IF NOT EXISTS time_entry_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
  project_trade_id uuid REFERENCES project_trades(id),
  hours numeric(6,2) NOT NULL CHECK (hours > 0)
);
