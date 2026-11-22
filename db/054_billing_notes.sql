-- Notes on a project's Progress Billing tab: who wrote what and when.
CREATE TABLE IF NOT EXISTS project_billing_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS project_billing_notes_project ON project_billing_notes(project_id, created_at DESC);
