-- Each person's private key for their calendar feed (bid due dates in Outlook or Google Calendar).
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS calendar_token text UNIQUE;
