-- A subcontractor is verified when its W-9 and unexpired insurance (or exemption) are on file. The Super Admin can also verify one by hand (an override).
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS verified_override boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS verified_override_by uuid REFERENCES app_users(id), ADD COLUMN IF NOT EXISTS verified_override_at timestamptz;
