-- Remembers how each phone signed in ("email_code" or "google"), so the business can see how many customers use each way.
-- Existing sessions are all email codes. Safe to run more than once.
ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS sign_in_method text NOT NULL DEFAULT 'email_code' CHECK (sign_in_method IN ('email_code', 'google'));
