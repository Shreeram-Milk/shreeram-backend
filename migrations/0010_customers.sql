-- 0010: customers — who buys: the customer, the one-time sign-in codes sent to their phone, and the phone's signed-in sessions.
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
-- It only creates new tables. It changes and deletes nothing that exists.
-- Customers are never physically deleted: a customer who asks for account deletion is switched to 'deleted' and their personal details are blanked,
-- so old orders and payments keep making sense (store rule + financial history).
-- Sign-in codes and session tokens are stored only as hashes: even someone who reads the database cannot sign in as a customer.

BEGIN;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- International format, for example +919284695568. Blank after account deletion.
  phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 100),
  email text NOT NULL DEFAULT '' CHECK (length(email) <= 200),
  -- Google's own id for the person, when they signed in with Google (Android).
  google_subject text,
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'gu')),
  -- Prepaid pays before delivery; credit pays later against a limit (set up in the Credit Accounts bundle).
  customer_type text NOT NULL DEFAULT 'prepaid' CHECK (customer_type IN ('prepaid', 'credit')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'deleted')),
  -- Admin-only note, never shown to the customer.
  admin_note text NOT NULL DEFAULT '' CHECK (length(admin_note) <= 500),
  last_sign_in_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'deleted' OR phone IS NOT NULL OR google_subject IS NOT NULL)
);
CREATE UNIQUE INDEX customers_phone_unique_idx ON customers (phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX customers_google_subject_unique_idx ON customers (google_subject) WHERE google_subject IS NOT NULL;
CREATE INDEX customers_status_idx ON customers (status);
CREATE INDEX customers_created_idx ON customers (created_at DESC);

-- One-time codes. A code works once, for a few minutes, with a limited number of wrong tries.
CREATE TABLE customer_sign_in_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text NOT NULL,
  -- How it was sent: 'console' (development: printed in the backend window), 'whatsapp' or 'sms'.
  channel text NOT NULL CHECK (channel IN ('console', 'whatsapp', 'sms')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- Used to limit how many codes one phone or one network address can ask for.
  request_ip text NOT NULL DEFAULT '' CHECK (length(request_ip) <= 64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_sign_in_codes_phone_idx ON customer_sign_in_codes (phone, created_at DESC);
CREATE INDEX customer_sign_in_codes_ip_idx ON customer_sign_in_codes (request_ip, created_at DESC);

-- One row per signed-in phone. Signing out, blocking or deleting the customer revokes it.
CREATE TABLE customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  token_hash text NOT NULL UNIQUE,
  device_label text NOT NULL DEFAULT '' CHECK (length(device_label) <= 100),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id);

GRANT SELECT, INSERT, UPDATE ON customers, customer_sessions TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON customer_sign_in_codes TO shreeram_app;

COMMIT;
