-- Takeoff Studio: the measured takeoff on a lead (sheets, scale, walls, rooms, finishes, report choices, chat), the rules Claude follows
-- when it drafts, and the company list of wall types and finish codes new takeoffs start from (app_settings key 'takeoff_library').
CREATE TABLE IF NOT EXISTS takeoff_studio (
  opportunity_id uuid PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  data jsonb NOT NULL,                           -- the whole takeoff as the page keeps it (byother.takeoff working copy)
  version int NOT NULL DEFAULT 1,                -- goes up on every save; a save from an older copy is refused
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- What the estimator taught Claude: for every takeoff (scope 'global') or for one lead (scope 'project').
CREATE TABLE IF NOT EXISTS takeoff_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'project')),
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'claude')),
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS takeoff_rules_opp ON takeoff_rules(opportunity_id);
-- A takeoff sent from Takeoff Studio waits on the estimating chat's next message like a PlanSwift file, as its own kind.
ALTER TABLE estimate_attachments DROP CONSTRAINT IF EXISTS estimate_attachments_purpose_check;
ALTER TABLE estimate_attachments ADD CONSTRAINT estimate_attachments_purpose_check CHECK (purpose IN ('takeoff', 'reference', 'proposal', 'studio'));
