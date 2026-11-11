-- Every uploaded file is fingerprinted so the same file is never kept twice.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE opportunity_files ADD COLUMN IF NOT EXISTS sha256 text;
CREATE INDEX IF NOT EXISTS documents_sha256 ON documents(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS opportunity_files_sha256 ON opportunity_files(sha256) WHERE sha256 IS NOT NULL;
