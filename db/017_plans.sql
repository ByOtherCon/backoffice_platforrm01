-- Plans (a ZIP or PDF downloaded from the invitation) are filed with the opportunity and copied to the job's 01. DL folder.
-- Once SharePoint holds the copy, the app's own copy is removed to save disk, so the file may exist only in SharePoint.
ALTER TABLE opportunity_files DROP CONSTRAINT IF EXISTS opportunity_files_kind_check;
ALTER TABLE opportunity_files ADD CONSTRAINT opportunity_files_kind_check CHECK (kind IN ('Proposal','Submittal','Plans','Other'));
ALTER TABLE opportunity_files ALTER COLUMN storage_key DROP NOT NULL;
