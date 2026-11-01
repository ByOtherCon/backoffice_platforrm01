-- Bid inbox: leads read from the BuildingConnected emails in Gmail, kept for 30 days, with run history.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS gmail_thread_id text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS invitations jsonb NOT NULL DEFAULT '[]';   -- one entry per GC that invited us to the same job
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS auto_declined boolean NOT NULL DEFAULT false;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS declined_at timestamptz;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS email_link text CHECK (email_link IS NULL OR email_link ~ '^https://');
CREATE INDEX IF NOT EXISTS opportunities_seen ON opportunities(last_seen_at);

-- Region tiers used for ranking. City names are matched ignoring case; any city not listed is Tier 3. Edit these in Admin.
CREATE TABLE IF NOT EXISTS region_tiers (city text PRIMARY KEY, tier int NOT NULL CHECK (tier BETWEEN 1 AND 4));

-- Connections to outside accounts. Secrets inside are encrypted by the app before they are stored.
CREATE TABLE IF NOT EXISTS integrations (name text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());

-- Email threads already read (so the 8am / 1pm refresh only pays for new mail).
CREATE TABLE IF NOT EXISTS bid_threads (thread_id text PRIMARY KEY, history_id text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS bid_refresh_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('Scheduled','Manual','Startup')),
  status text NOT NULL DEFAULT 'Running' CHECK (status IN ('Running','Done','Error')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  threads int NOT NULL DEFAULT 0, added int NOT NULL DEFAULT 0, updated int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0, declined int NOT NULL DEFAULT 0,
  error text,
  started_by uuid REFERENCES app_users(id)
);
INSERT INTO app_settings(key, value) VALUES ('bids', '{"label":""}') ON CONFLICT DO NOTHING;
