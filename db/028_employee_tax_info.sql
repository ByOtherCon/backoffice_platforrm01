-- 1099 information: every 1099 crew member (employee) needs a checked address and a W-9 whose name and address match, just like a subcontractor.
-- Employee W-9s hold tax numbers, so they stay private in the platform (never copied to SharePoint) and only approvers can open them.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address text, ADD COLUMN IF NOT EXISTS city text, ADD COLUMN IF NOT EXISTS state text, ADD COLUMN IF NOT EXISTS zip text, ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS w9_document_id uuid REFERENCES documents(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address_confirmed_key text, ADD COLUMN IF NOT EXISTS address_confirmed_by uuid REFERENCES app_users(id), ADD COLUMN IF NOT EXISTS address_confirmed_at timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS restricted boolean NOT NULL DEFAULT false;   -- only approvers may open it
