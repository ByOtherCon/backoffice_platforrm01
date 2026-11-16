-- A job pitched to several GCs becomes one proposal per GC when it is Started. The proposals of one job share this id, so each can show the others.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS split_group uuid;
CREATE INDEX IF NOT EXISTS opportunities_split_group ON opportunities(split_group) WHERE split_group IS NOT NULL;
