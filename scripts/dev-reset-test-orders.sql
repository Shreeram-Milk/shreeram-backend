-- DEVELOPMENT ONLY. Wipes every order, subscription and trial, and all money records, so testing can start fresh.
--
-- What it removes (ALL rows, not only recent ones):
--   orders, order items, order status history, every subscription and trial (with their windows, pauses, skips and history),
--   online payments (PhonePe), payment history and webhook records, payment requests, refunds, prepaid adjustments,
--   and the whole credit ledger (what every credit customer owes goes back to ₹0).
--
-- What it keeps:
--   customers (and their credit limit and type), addresses, products, categories, delivery slots/areas/cut-off rules,
--   admin users, content, support tickets. Nothing about the shop setup is touched.
--
-- (It also clears the record of which offers were used, which points at orders and subscriptions.)
-- It cannot be undone. It refuses to run unless the database is named shreeram_dev.
-- Run it as the migration user (the one you use for migrations), in pgAdmin, as one script.
--
-- NEVER run this on a live database: financial history must never be deleted there.

-- STEP 1. Look first: what is about to be removed.
SELECT 'orders' AS what, count(*) FROM orders
UNION ALL SELECT 'subscriptions and trials', count(*) FROM subscriptions
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'credit ledger lines', count(*) FROM credit_ledger_entries
UNION ALL SELECT 'payment requests', count(*) FROM payment_requests
UNION ALL SELECT 'refunds', count(*) FROM refunds
UNION ALL SELECT 'prepaid adjustments', count(*) FROM prepaid_adjustments;

-- STEP 2. The wipe, all or nothing.
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'shreeram_dev' THEN
    RAISE EXCEPTION 'Refusing to wipe orders: this is database "%", not shreeram_dev.', current_database();
  END IF;
END $$;

-- One statement, so tables that point at each other are emptied together. If any OTHER table still points at one of
-- these, PostgreSQL stops with an error and nothing is deleted.
TRUNCATE TABLE
  offer_redemptions,
  subscription_skips,
  subscription_pauses,
  subscription_activity,
  subscription_lines,
  subscriptions,
  order_items,
  order_status_history,
  refunds,
  prepaid_adjustments,
  credit_ledger_entries,
  payment_requests,
  payment_activity,
  payment_events,
  payments,
  orders;

-- The next order is SRM-1001 again, and the next subscription SUB-1001.
ALTER SEQUENCE order_number_seq RESTART WITH 1001;
ALTER SEQUENCE subscription_number_seq RESTART WITH 1001;

COMMIT;

-- STEP 3. Check: every count should now be 0.
SELECT 'orders' AS what, count(*) FROM orders
UNION ALL SELECT 'subscriptions and trials', count(*) FROM subscriptions
UNION ALL SELECT 'payments', count(*) FROM payments
UNION ALL SELECT 'credit ledger lines', count(*) FROM credit_ledger_entries
UNION ALL SELECT 'payment requests', count(*) FROM payment_requests
UNION ALL SELECT 'refunds', count(*) FROM refunds
UNION ALL SELECT 'prepaid adjustments', count(*) FROM prepaid_adjustments;
