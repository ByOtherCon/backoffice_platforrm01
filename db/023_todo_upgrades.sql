-- To-do upgrades: priority levels, "new to the assignee" tracking, and a notes log / comments from different people.
ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low','Normal','High','Urgent'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS seen_at timestamptz;   -- when the person it is assigned to first saw it; null = new to them
UPDATE todos SET seen_at = created_at WHERE seen_at IS NULL;      -- everything that exists today is not "new"
CREATE TABLE IF NOT EXISTS todo_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  todo_id uuid NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'Comment' CHECK (kind IN ('Comment','System')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS todo_comments_todo ON todo_comments(todo_id, created_at);
