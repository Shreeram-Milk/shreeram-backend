-- 0041: a subscription rule's "ready-made lengths" (quick buttons like 15 or 30 deliveries) become optional.
-- Run as the migration user (shreeram_migrate), in one go, in pgAdmin. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
--
-- Before: every rule needed 1 to 6 ready-made lengths. After: 0 to 6. With none, customers simply pick their last day on the
-- calendar, between the rule's shortest and longest days (for example 5 to 180). Nothing is deleted; no existing rule changes.

BEGIN;

DO $$
DECLARE
  found record;
BEGIN
  FOR found IN
    SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'subscription_rules' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%length_options%'
  LOOP
    EXECUTE format('ALTER TABLE subscription_rules DROP CONSTRAINT %I', found.conname);
  END LOOP;
END $$;

ALTER TABLE subscription_rules ADD CONSTRAINT subscription_rules_length_options_check
  CHECK (cardinality(length_options) <= 6 AND 1 <= ALL (length_options) AND 365 >= ALL (length_options));

COMMIT;
