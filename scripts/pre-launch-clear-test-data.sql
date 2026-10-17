-- BEFORE LAUNCH ONLY. Removes every customer and everything a customer owns, so the live app starts with no test data.
--
-- What it removes (all rows):
--   customers and their sign-in codes and phones' sessions, addresses and doorstep notes, support tickets,
--   notification inbox and phone notification addresses, orders, subscriptions and trials, online payments (PhonePe),
--   refunds, prepaid adjustments, the credit ledger, and the record of which customer used which offer.
--
-- What it keeps:
--   products, categories, prices, delivery slots / areas / cut-off rules, service-area PIN codes, the PIN directory,
--   offers (but not their usage counts), banners, help, policies, notification wording, app settings, admin users, audit log.
--
-- It cannot be undone. Take a database backup first.
-- Run it ONCE, before the first real customer signs up, never afterwards: financial history must never be deleted on a live shop.
-- Run it as the migration user (shreeram_migrate), in pgAdmin, as one script.

-- STEP 1. Type the name of THIS database between the quotes, exactly as it is (for example: shreeram_prod). The script refuses to run otherwise.
CREATE TEMP TABLE launch_guard AS SELECT 'CHANGE_ME_DATABASE_NAME'::text AS expected_database;

DO $$
DECLARE expected text := (SELECT expected_database FROM launch_guard);
BEGIN
  IF expected = 'CHANGE_ME_DATABASE_NAME' OR expected <> current_database() THEN
    RAISE EXCEPTION 'Stopped: this database is "%", but the script was told "%". Edit STEP 1 and run again.', current_database(), expected;
  END IF;
END $$;

-- STEP 2. Look first: what is about to be removed.
SELECT 'customers' AS what, count(*) FROM customers
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'subscriptions and trials', count(*) FROM subscriptions
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'credit ledger lines', count(*) FROM credit_ledger_entries
UNION ALL SELECT 'support tickets', count(*) FROM support_tickets
UNION ALL SELECT 'notifications', count(*) FROM notifications
UNION ALL SELECT 'offer uses', count(*) FROM offer_redemptions;

-- STEP 3. The wipe, all or nothing. CASCADE here means "also the tables that belong to a customer", nothing else.
BEGIN;

TRUNCATE TABLE customers CASCADE;

-- The next order is SRM-1001 again, and the next subscription SUB-1001.
ALTER SEQUENCE order_number_seq RESTART WITH 1001;
ALTER SEQUENCE subscription_number_seq RESTART WITH 1001;

COMMIT;

-- STEP 4. Check: every count should now be 0, and products and areas should still be there.
SELECT 'customers' AS what, count(*) FROM customers
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'subscriptions and trials', count(*) FROM subscriptions
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'offer uses', count(*) FROM offer_redemptions
UNION ALL SELECT 'products (kept)', count(*) FROM products
UNION ALL SELECT 'service areas (kept)', count(*) FROM service_areas
UNION ALL SELECT 'offers (kept)', count(*) FROM offers;
