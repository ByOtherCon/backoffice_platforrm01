-- Leads that were accepted after their bid date had passed were moved to Decided Not To Submit by the clean-up the very same day
-- (the 5-days-past-due rule did not look at when they were accepted). They are put back to Accepted and the clean-up leaves them alone.
WITH hit AS (
  UPDATE opportunities SET status='Accepted', result='Pending', declined_reason=NULL, auto_declined=false, keep_past_due=true
   WHERE merged_into IS NULL AND status='Decided Not To Submit' AND auto_declined AND declined_reason='No action taken (lead expired)'
     AND accepted_date IS NOT NULL AND declined_at IS NOT NULL AND accepted_date = (declined_at AT TIME ZONE 'America/New_York')::date
  RETURNING id)
INSERT INTO opportunity_notes(opportunity_id, kind, body)
SELECT id, 'System', 'Put back to Accepted by the system. It was accepted after its bid date had passed, and the automatic clean-up moved it to Decided Not To Submit the same day. That was a fault in the clean-up, now fixed: work taken on after its bid date is left alone.' FROM hit;
