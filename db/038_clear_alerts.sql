-- Alerts can be cleared. Bell alerts keep their row (so the same alert is not created again) but are hidden; the Projects page alerts are worked out
-- from the data, so a cleared one is remembered per person and per kind of alert.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
CREATE TABLE IF NOT EXISTS dismissed_alerts (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  alert_key text NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, alert_key)
);
