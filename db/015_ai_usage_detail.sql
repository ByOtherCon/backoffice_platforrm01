-- What each AI call was for and which model ran it, so spending can be read by person, task and day.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS label text;
CREATE INDEX IF NOT EXISTS ai_usage_created ON ai_usage(created_at);
