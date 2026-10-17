-- 0023: customers sign in with a code sent to their EMAIL (no SMS or WhatsApp).
--
--   * Sign-in codes can now belong to an email address, and can be sent by email.
--   * A customer can be known by email alone. Email must be unique (upper and lower case count as the same).
--   * A phone number is now only a contact number for the delivery person (it is no longer how someone signs in), so two
--     customers may share one and it may be empty.
--
-- Existing customers keep working: they have a phone and no email, and can add an email in the admin (Customers) or simply
-- sign up again with an email. Nothing is deleted. If two customers already share the same email, this stops with a clear
-- message and changes nothing: fix that in the admin, then run it again.
-- Safe to run once in pgAdmin as postgres.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE email <> '' AND status <> 'deleted' GROUP BY lower(email) HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Two customers share the same email address. Open Customers in the admin, give each a different email (or clear one), then run this file again.';
  END IF;
END $$;

-- Codes for an email address.
ALTER TABLE customer_sign_in_codes ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE customer_sign_in_codes ADD COLUMN email text CHECK (email IS NULL OR length(email) <= 200);
ALTER TABLE customer_sign_in_codes ADD CONSTRAINT customer_sign_in_codes_target_check CHECK (phone IS NOT NULL OR email IS NOT NULL);
CREATE INDEX customer_sign_in_codes_email_idx ON customer_sign_in_codes (email, created_at DESC) WHERE email IS NOT NULL;

DO $$
DECLARE channel_check text;
BEGIN
  SELECT conname INTO channel_check FROM pg_constraint
   WHERE conrelid = 'customer_sign_in_codes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%whatsapp%';
  IF channel_check IS NOT NULL THEN EXECUTE format('ALTER TABLE customer_sign_in_codes DROP CONSTRAINT %I', channel_check); END IF;
END $$;
ALTER TABLE customer_sign_in_codes ADD CONSTRAINT customer_sign_in_codes_channel_check CHECK (channel IN ('console', 'whatsapp', 'sms', 'email'));

-- A customer needs a phone, a Google id OR an email to exist.
DO $$
DECLARE identity_check text;
BEGIN
  SELECT conname INTO identity_check FROM pg_constraint
   WHERE conrelid = 'customers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%google_subject IS NOT NULL%';
  IF identity_check IS NOT NULL THEN EXECUTE format('ALTER TABLE customers DROP CONSTRAINT %I', identity_check); END IF;
END $$;
ALTER TABLE customers ADD CONSTRAINT customers_identity_check CHECK (status = 'deleted' OR phone IS NOT NULL OR google_subject IS NOT NULL OR email <> '');

CREATE UNIQUE INDEX customers_email_unique_idx ON customers (lower(email)) WHERE email <> '' AND status <> 'deleted';

-- The phone is a contact number now, not the sign-in identity.
DROP INDEX IF EXISTS customers_phone_unique_idx;

COMMIT;
