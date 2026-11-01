-- Vocabulary: a SUBCONTRACTOR provides labor and must be vetted (W-9 and COI or exempt). A VENDOR sells materials, lodging, equipment or a one-off purchase (food, Amazon) and is not vetted.
-- Labor is the 1099 crew paid from the time clock. The tables keep their old names (subcontractors, suppliers); only the wording and vendor types change.
ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_provider_type_check;
UPDATE suppliers SET provider_type = CASE provider_type WHEN 'Supplier' THEN 'Materials' WHEN 'Equipment Provider' THEN 'Equipment' ELSE 'Other purchase' END;
ALTER TABLE suppliers ALTER COLUMN provider_type SET DEFAULT 'Materials';
ALTER TABLE suppliers ADD CONSTRAINT suppliers_provider_type_check CHECK (provider_type IN ('Materials','Hotel / Lodging','Equipment','Other purchase'));
ALTER TABLE overhead_items ADD COLUMN IF NOT EXISTS policy_date date;   -- the policy's start / renewal date; its cost is spread over the contracts logged in that policy year
