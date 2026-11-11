-- A vendor can be saved for future use, or be a one-time purchase that stays out of the vendor dropdowns.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS one_time boolean NOT NULL DEFAULT false;
