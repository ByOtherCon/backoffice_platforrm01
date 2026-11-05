-- One address standard everywhere: street (the existing "address" column), city, state, ZIP and a "checked" flag.
-- Projects, subcontractors and vendors held a single line such as "123 Main St, Orlando, FL 32801"; it is split here where it can be.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS city text, ADD COLUMN IF NOT EXISTS state text, ADD COLUMN IF NOT EXISTS zip text, ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false;
ALTER TABLE subcontractors ADD COLUMN IF NOT EXISTS city text, ADD COLUMN IF NOT EXISTS state text, ADD COLUMN IF NOT EXISTS zip text, ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS city text, ADD COLUMN IF NOT EXISTS state text, ADD COLUMN IF NOT EXISTS zip text, ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false;
DO $$
DECLARE t text; re text := '^(.+),\s*([^,]+),\s*([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\.?$';
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','subcontractors','suppliers'] LOOP
    EXECUTE format($f$UPDATE %I SET
        city = trim((regexp_match(address, %L))[2]), state = upper((regexp_match(address, %L))[3]), zip = NULLIF((regexp_match(address, %L))[4], ''),
        address = trim((regexp_match(address, %L))[1])
      WHERE address ~ %L AND city IS NULL$f$, t, re, re, re, re, re);
  END LOOP;
END $$;
