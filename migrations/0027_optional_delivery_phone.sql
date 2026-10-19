-- Contact numbers are optional for onboarding, saved addresses and subscription snapshots.
-- Keep the existing string contract: an empty string means no contact number.
-- Existing rows are preserved. Supplied numbers must still satisfy their existing checks.
BEGIN;

ALTER TABLE customer_addresses
  DROP CONSTRAINT customer_addresses_recipient_phone_check,
  ADD CONSTRAINT customer_addresses_recipient_phone_check
    CHECK (recipient_phone = '' OR recipient_phone ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE subscriptions
  DROP CONSTRAINT subscriptions_recipient_phone_check,
  ADD CONSTRAINT subscriptions_recipient_phone_check
    CHECK (recipient_phone = '' OR length(recipient_phone) BETWEEN 6 AND 20);

COMMIT;
