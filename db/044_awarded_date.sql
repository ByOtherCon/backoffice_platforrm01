-- The day a lead was awarded, for the "Awarded this month" figure. Existing awards take the day their project was created (Eastern time).
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS awarded_date date;
UPDATE opportunities o SET awarded_date = (p.created_at AT TIME ZONE 'America/New_York')::date FROM projects p WHERE p.id = o.project_id AND o.status = 'Awarded' AND o.awarded_date IS NULL;
