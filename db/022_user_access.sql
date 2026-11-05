-- Per-person access: which areas they can use and which dashboard cards they see. Null = what their role gives.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS access jsonb;
