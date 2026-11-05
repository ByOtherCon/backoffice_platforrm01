-- A subcontractor is verified (and can be paid) when its address is checked, its W-9 and insurance (or exemption) are on file,
-- and the address matches what the documents say. The documents also live in the subcontractor's own SharePoint folder.
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS sp_item_id text, ADD COLUMN IF NOT EXISTS sp_path text, ADD COLUMN IF NOT EXISTS folder_url text;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS address_confirmed_key text, ADD COLUMN IF NOT EXISTS address_confirmed_by uuid REFERENCES app_users(id), ADD COLUMN IF NOT EXISTS address_confirmed_at timestamptz;
-- what the AI read off a vendor document (the name and address printed on it; never the tax number)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS read_name text, ADD COLUMN IF NOT EXISTS read_address jsonb;
