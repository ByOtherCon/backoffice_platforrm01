-- Leads that came in without a bid due date: when the AI last looked for it, and where it was found.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS due_checked_at timestamptz;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS due_found_by text;
