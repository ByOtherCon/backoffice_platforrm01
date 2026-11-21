-- Estimate With AI: a preview of each proposal before the final files are made, files attached to the conversation (PlanSwift takeoffs,
-- photos, documents, a proposal to check), and the company-wide list of items the estimating sheet does not cover yet.
CREATE TABLE IF NOT EXISTS estimate_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES estimate_chats(id) ON DELETE CASCADE,
  message_id uuid REFERENCES estimate_messages(id) ON DELETE SET NULL,
  seq int NOT NULL,                              -- Preview 1, 2, 3… within the lead
  input jsonb NOT NULL,                          -- the whole proposal as the AI handed it over
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  final_version int,                             -- set when the estimator made the final files from it
  final_files jsonb,
  final_at timestamptz,
  final_by uuid REFERENCES app_users(id),
  final_told boolean NOT NULL DEFAULT false      -- the AI has been told the final was made
);
CREATE INDEX IF NOT EXISTS estimate_drafts_chat ON estimate_drafts(chat_id, created_at);
CREATE INDEX IF NOT EXISTS estimate_drafts_opp ON estimate_drafts(opportunity_id, seq);

CREATE TABLE IF NOT EXISTS estimate_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  message_id uuid REFERENCES estimate_messages(id) ON DELETE SET NULL,   -- the message it was sent with (none until sent)
  purpose text NOT NULL CHECK (purpose IN ('takeoff','reference','proposal')),
  name text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  ai_file_id text,                               -- PDFs and pictures: the copy at the AI service
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS estimate_attachments_opp ON estimate_attachments(opportunity_id, created_at);

CREATE TABLE IF NOT EXISTS estimator_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade text NOT NULL DEFAULT '',
  item text NOT NULL,
  note text NOT NULL DEFAULT '',
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  draft_id uuid REFERENCES estimate_drafts(id) ON DELETE SET NULL,
  seen int NOT NULL DEFAULT 1,                   -- how many previews have needed it
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  done_by uuid REFERENCES app_users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS estimator_updates_open ON estimator_updates(lower(trade), lower(item)) WHERE done_at IS NULL;
