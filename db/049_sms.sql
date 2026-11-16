-- Every text message the platform sends, or tries to: who, what kind of alert, and whether it went.
-- alert_day is the Eastern day an automatic alert belongs to, so nobody gets the same alert twice in one day.
CREATE TABLE IF NOT EXISTS sms_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_number text NOT NULL, body text NOT NULL, kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('Sent','Failed','Skipped')), error text, provider_id text,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  alert_day date, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_log_recent ON sms_log(created_at DESC);
CREATE INDEX IF NOT EXISTS sms_log_alert ON sms_log(kind, alert_day);
