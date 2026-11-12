-- Awarded jobs are Tier 0 (best); a lead brought back on purpose is remembered; the reason for a tier is kept; bundled jobs point at the lead they were merged into.
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_tier_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_tier_check CHECK (tier BETWEEN 0 AND 4);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS revived_at timestamptz, ADD COLUMN IF NOT EXISTS tier_note text,
  ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES opportunities(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS folder_per_gc boolean NOT NULL DEFAULT false;
UPDATE opportunities SET tier=0, tier_note='Awarded: Tier 0 (best)' WHERE status='Awarded';
CREATE INDEX IF NOT EXISTS opportunities_merged ON opportunities(merged_into) WHERE merged_into IS NOT NULL;
-- one row per GC folder when a bundled job gets a folder under each GC
CREATE TABLE IF NOT EXISTS opportunity_folders (
  opportunity_id uuid NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  gc_name text NOT NULL, sp_item_id text, sp_path text, folder_url text,
  PRIMARY KEY (opportunity_id, gc_name)
);
