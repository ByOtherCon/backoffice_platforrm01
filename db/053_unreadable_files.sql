-- A file the AI service could not read ("Could not process PDF"): it is left out of every later request and named to the estimator.
ALTER TABLE ai_files ADD COLUMN IF NOT EXISTS unreadable text;
