-- Login: email + password (scrypt), DB-backed sessions, lockout after repeated failures.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash text;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_attempts (
  email text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_email ON login_attempts(email, attempted_at DESC);
