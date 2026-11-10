-- A GC keeps its own address and contact, so picking that GC again fills the form in.
ALTER TABLE gcs ADD COLUMN IF NOT EXISTS address text, ADD COLUMN IF NOT EXISTS city text, ADD COLUMN IF NOT EXISTS state text, ADD COLUMN IF NOT EXISTS zip text,
  ADD COLUMN IF NOT EXISTS address_verified boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS contact_name text, ADD COLUMN IF NOT EXISTS email text, ADD COLUMN IF NOT EXISTS phone text;
-- start each GC from the most complete lead already entered for it
UPDATE gcs g SET address=l.gc_street, city=l.gc_city, state=l.gc_state, zip=l.gc_zip, address_verified=COALESCE(l.gc_address_verified,false),
  contact_name=l.contact_name, email=l.contact_email, phone=l.contact_phone
FROM (SELECT DISTINCT ON (lower(gc_name)) gc_name, gc_street, gc_city, gc_state, gc_zip, gc_address_verified, contact_name, contact_email, contact_phone
      FROM opportunities WHERE gc_name <> '' ORDER BY lower(gc_name), (gc_street IS NOT NULL) DESC, (contact_email IS NOT NULL) DESC, created_at DESC) l
WHERE lower(g.name)=lower(l.gc_name) AND g.address IS NULL;
