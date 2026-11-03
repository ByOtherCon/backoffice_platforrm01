-- Emailed password-reset links. Only a hash of the link's token is stored; each link works once and expires.
CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at DESC);
