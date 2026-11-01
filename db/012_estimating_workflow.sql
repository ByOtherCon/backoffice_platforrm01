-- Estimating workflow rework: one status line from New to Awarded, one form, an audit trail in Notes,
-- proposal PDFs kept per opportunity, and one follow-up case per submitted bid version.

-- ---- statuses
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_status_check;
UPDATE opportunities SET status = CASE
  WHEN status = 'Bidding' THEN CASE WHEN EXISTS (SELECT 1 FROM submissions s WHERE s.opportunity_id = opportunities.id) THEN 'Submitted' ELSE 'Accepted' END
  WHEN status = 'No Bid' THEN CASE WHEN accepted_date IS NULL THEN 'Declined' ELSE 'Decided Not To Submit' END
  WHEN status = 'Lost' THEN 'Not Awarded'
  ELSE status END;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_status_check CHECK (status IN
  ('New','Reviewing','Accepted','Started','Submitted','Declined','Decided Not To Submit','Awarded','Not Awarded','No Communication'));

-- ---- the one opportunity form
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS client_name text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gc_id uuid REFERENCES gcs(id) ON DELETE SET NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gc_street text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gc_city text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gc_state text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gc_zip text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gc_address_verified boolean NOT NULL DEFAULT false;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS zip text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS source_type text CHECK (source_type IS NULL OR source_type IN ('Building Connected','PlanHub','Website','In-Person'));
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES app_users(id);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS planned_start date;
UPDATE opportunities SET source_type = 'Building Connected' WHERE source_type IS NULL AND (source LIKE 'BuildingConnected%' OR invitation_link LIKE '%buildingconnected.com%');
UPDATE opportunities SET client_name = gc_name WHERE client_name IS NULL;

CREATE TABLE IF NOT EXISTS opportunity_considered_trades (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  trade_id uuid NOT NULL REFERENCES trades(id),
  PRIMARY KEY (opportunity_id, trade_id)
);

-- ---- Notes: system entries (audit) and typed notes share one timeline
CREATE TABLE IF NOT EXISTS opportunity_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id),
  kind text NOT NULL CHECK (kind IN ('System','User')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_notes_opp ON opportunity_notes(opportunity_id, created_at);
INSERT INTO opportunity_notes(opportunity_id, user_id, kind, body, created_at)
  SELECT opportunity_id, user_id, 'System', action || COALESCE(': ' || detail, ''), created_at FROM opportunity_events;
INSERT INTO opportunity_notes(opportunity_id, kind, body, created_at)
  SELECT id, 'User', notes, created_at FROM opportunities WHERE notes IS NOT NULL AND notes <> '';
ALTER TABLE opportunities DROP COLUMN IF EXISTS notes;
DROP TABLE IF EXISTS opportunity_events;

-- ---- proposal PDFs and the submittal folder
CREATE TABLE IF NOT EXISTS opportunity_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'Submittal' CHECK (kind IN ('Proposal','Submittal','Other')),
  name text NOT NULL,
  storage_key text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  parsed jsonb,
  submission_id uuid,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunity_files_opp ON opportunity_files(opportunity_id, created_at);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES opportunity_files(id) ON DELETE SET NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS trades jsonb NOT NULL DEFAULT '[]';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS voided_at timestamptz;

-- ---- follow-up: one case per submitted version
ALTER TABLE communications DROP CONSTRAINT IF EXISTS communications_kind_check;
UPDATE communications SET kind = 'Call 1' WHERE kind = 'Call / Message';
ALTER TABLE communications ADD CONSTRAINT communications_kind_check CHECK (kind IN ('First Email Sent','Call 1','Call 2','Final Email Sent','Reply Received','Note'));
ALTER TABLE communications ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IS NULL OR outcome IN ('Answered','No Answer','Voicemail Left','No Voicemail Available'));

CREATE TABLE IF NOT EXISTS followup_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Paused','Awaiting GC Award','Replied / Action Needed','Selected / Awaiting Contract',
    'Not Selected / Not Won','Closed / No Response','Closed / Awarded','Needs Schedule Review','Superseded')),
  next_check date,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followup_cases_opp ON followup_cases(opportunity_id);
INSERT INTO followup_cases(opportunity_id, submission_id, status)
  SELECT DISTINCT ON (s.opportunity_id) s.opportunity_id, s.id,
         CASE WHEN o.status = 'Awarded' THEN 'Closed / Awarded' WHEN o.status = 'Not Awarded' THEN 'Not Selected / Not Won' ELSE 'Active' END
  FROM submissions s JOIN opportunities o ON o.id = s.opportunity_id ORDER BY s.opportunity_id, s.version DESC
  ON CONFLICT DO NOTHING;

-- ---- projects remember where they came from
ALTER TABLE projects ADD COLUMN IF NOT EXISTS opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL;

-- ---- rules the office can change
UPDATE app_settings SET value = value || '{"declineNewDays":2,"declineReviewingDays":2}'::jsonb WHERE key = 'estimating';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone text;
