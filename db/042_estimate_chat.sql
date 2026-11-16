-- More choices on a lead: a project type of Other, and Referral as a source.
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_project_type_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_project_type_check CHECK (project_type IN ('Retail','Restaurant','Office / Medical / Other','Other'));
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_source_type_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_source_type_check CHECK (source_type IS NULL OR source_type IN ('Building Connected','PlanHub','Website','In-Person','Referral'));

-- Estimating with AI: a conversation kept on the lead. The plans are sent to the AI service once (ai_files remembers where each file is
-- there, by fingerprint) and every proposal the conversation produces is kept as its own version.
CREATE TABLE IF NOT EXISTS ai_files (
  sha256 text PRIMARY KEY,
  file_id text NOT NULL,
  name text,
  size bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimate_chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  docs jsonb NOT NULL DEFAULT '[]',          -- the plan files already given to this conversation: [{sha256, name}]
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS estimate_chats_opp ON estimate_chats(opportunity_id, created_at);
CREATE TABLE IF NOT EXISTS estimate_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES estimate_chats(id) ON DELETE CASCADE,
  seq bigserial,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  user_id uuid REFERENCES app_users(id),
  body text NOT NULL DEFAULT '',             -- what is shown on screen
  blocks jsonb,                              -- exactly what was sent to or came back from the AI service, so the conversation can continue
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('working','done','error')),
  error text,
  files jsonb NOT NULL DEFAULT '[]',         -- files this answer produced: [{id, name, kind}]
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS estimate_messages_chat ON estimate_messages(chat_id, seq);
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_read_tokens int, ADD COLUMN IF NOT EXISTS cache_write_tokens int;
-- a proposal made by the conversation: which version it is, and which conversation made it
ALTER TABLE opportunity_files ADD COLUMN IF NOT EXISTS version int, ADD COLUMN IF NOT EXISTS chat_id uuid REFERENCES estimate_chats(id) ON DELETE SET NULL;
ALTER TABLE opportunity_files ADD COLUMN IF NOT EXISTS meta jsonb;   -- what a proposal made here says (trades and totals), so it can fill in the submission
-- which plan PDFs each plans file on a lead turned into (a zip holds several), so they are sent to the AI service only once
CREATE TABLE IF NOT EXISTS plan_sources (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  docs jsonb NOT NULL DEFAULT '[]',          -- [{sha256, name, size}]
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (opportunity_id, source_key)
);
