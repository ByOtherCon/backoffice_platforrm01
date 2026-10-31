-- Messaging between office users, to-do lists, and links from either to any record.
CREATE TABLE IF NOT EXISTS threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  last_read_at timestamptz,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES app_users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  notes text,
  start_date date,
  due_date date,
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Done')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  assigned_to uuid REFERENCES app_users(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  done_by uuid REFERENCES app_users(id),
  CHECK (start_date IS NULL OR due_date IS NULL OR due_date >= start_date)
);
CREATE INDEX IF NOT EXISTS todos_assignee ON todos(assigned_to, status, due_date);
-- one table links messages, to-dos and threads to records (projects, documents, vendors, receipts, approvals, opportunities...)
CREATE TABLE IF NOT EXISTS record_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL CHECK (owner_kind IN ('message','todo')),
  owner_id uuid NOT NULL,
  kind text NOT NULL,
  record_id uuid NOT NULL,
  label text NOT NULL,
  UNIQUE (owner_kind, owner_id, kind, record_id)
);
CREATE INDEX IF NOT EXISTS record_links_record ON record_links(kind, record_id);
