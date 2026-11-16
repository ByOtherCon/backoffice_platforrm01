-- One-time change asked for by the owner: the New Balance lead in Orlando had been declined and could not be found in the list any more.
-- It is brought back to New exactly as the Reopen step does it (the automatic clean-up will not decline it again right away), with a note.
WITH hit AS (
  UPDATE opportunities SET status='New', result='Pending', declined_reason=NULL, auto_declined=false, revived_at=now(), keep_past_due=true
   WHERE merged_into IS NULL AND status='Declined' AND name ILIKE '%new balance%' AND (city ILIKE '%orlando%' OR name ILIKE '%orlando%' OR address ILIKE '%orlando%')
  RETURNING id)
INSERT INTO opportunity_notes(opportunity_id, kind, body)
SELECT id, 'System', 'Brought back to New at the owner''s request. It had been declined and could no longer be found in the list. The automatic clean-up will not decline it again right away.' FROM hit;
