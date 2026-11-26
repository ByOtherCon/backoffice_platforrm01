-- A GC's own plan room / bid portal (CW Hayes and other Pantera plan rooms, etc.) as its own source, and as a way a bid is submitted.
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_source_type_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_source_type_check CHECK (source_type IS NULL OR source_type IN ('Building Connected','PlanHub','GC Bid Portal','Website','In-Person','Referral'));
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_method_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_method_check CHECK (method IN ('Email','via BuildingConnected','PlanHub','GC Bid Portal','Other'));
-- an Accept / Decline button link must never be kept: opening it would answer the invitation
UPDATE opportunities SET invitation_link = regexp_replace(invitation_link, '/?[?&]response=(accept|decline)[^#]*$', '', 'i') WHERE invitation_link ~* '[?&]response=(accept|decline)';
UPDATE opportunities SET invitations = regexp_replace(invitations::text, '/?[?&]response=(accept|decline)[^"#]*', '', 'gi')::jsonb WHERE invitations::text ~* '[?&]response=(accept|decline)';
-- leads the email feed filed as Building Connected whose invitation is really on the GC's own portal
UPDATE opportunities SET source_type = 'GC Bid Portal' WHERE source_type = 'Building Connected' AND source = 'BuildingConnected email'
  AND invitation_link ~ '^https://' AND invitation_link !~* 'buildingconnected\.com' AND invitation_link !~* 'planhub\.com';
