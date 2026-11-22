-- Two leads someone said are not the same job: the app does not ask about that pair again.
CREATE TABLE IF NOT EXISTS lead_not_same (
  a uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  b uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  by_user uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a, b), CHECK (a < b)
);
