-- SharePoint: where each opportunity's / project's shared folder lives, and the contract reference code (P becomes C on award).
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS sp_item_id text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS sp_path text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS sp_error text;
ALTER TABLE opportunity_files ADD COLUMN IF NOT EXISTS sp_url text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ref_code text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS folder_url text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sp_item_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sp_path text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ref_code text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sp_url text;
UPDATE projects SET ref_code = 'C' || substr(proposal_id, 2) WHERE ref_code IS NULL AND proposal_id ~ '^P[0-9]';
