-- A lead someone adds by hand with a bid date that has already passed stays open instead of auto-declining for that date.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS keep_past_due boolean NOT NULL DEFAULT false;
