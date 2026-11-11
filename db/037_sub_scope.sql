-- What a subcontractor is actually doing on a project, which can differ from the trade it is billed against
-- (framing is the trade, the scope is paint, stucco or drywall).
ALTER TABLE sub_commitments ADD COLUMN IF NOT EXISTS scope text;
