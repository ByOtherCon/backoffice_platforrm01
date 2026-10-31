-- Roles: one Super Admin (the owner), Sub Admin, Exec Assistant, Estimator, Project Manager, Employee (field).
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
UPDATE app_users SET role='Super Admin' WHERE role='Admin';
UPDATE app_users SET role='Sub Admin' WHERE role='Sub-Admin';
UPDATE app_users SET role='Exec Assistant' WHERE role='Office';
ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('Super Admin','Sub Admin','Exec Assistant','Estimator','Project Manager','Employee'));
CREATE UNIQUE INDEX IF NOT EXISTS one_super_admin ON app_users ((role)) WHERE role='Super Admin';

-- Per-user saved layouts (dashboard widgets, report views, etc.)
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
