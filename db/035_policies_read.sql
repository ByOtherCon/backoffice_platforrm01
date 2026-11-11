-- What was read off an insurance certificate: each coverage and when it expires.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS read_policies jsonb;
