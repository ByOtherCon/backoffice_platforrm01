-- A file the app copied into the SharePoint library and that was later deleted there by hand is not put back.
-- sp_item_id: the library's own id of the copy (it survives a rename or a move), so the app can tell "renamed" and "moved" from "deleted".
-- sp_removed_at: the copy was deleted in the library; the file is no longer listed on the lead and is never copied again.
ALTER TABLE opportunity_files ADD COLUMN IF NOT EXISTS sp_item_id text;
ALTER TABLE opportunity_files ADD COLUMN IF NOT EXISTS sp_removed_at timestamptz;
-- A bundled job: the plans already copied into this GC's folder (by the library's id), so one deleted there is not copied again.
ALTER TABLE opportunity_folders ADD COLUMN IF NOT EXISTS plans_copied jsonb NOT NULL DEFAULT '[]'::jsonb;
