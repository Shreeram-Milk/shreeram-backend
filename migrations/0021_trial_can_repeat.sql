-- 0021: a customer may buy the same trial again once the earlier one has ended or been cancelled.
-- Before: one trial per customer per product, ever. Now: one RUNNING trial per customer per product (so two trial payments
-- completed at the same moment still start only one; the second is refunded, as before).
-- Safe to run once in pgAdmin as postgres. It changes no rows.

BEGIN;
DROP INDEX IF EXISTS subscriptions_one_trial_idx;
CREATE UNIQUE INDEX subscriptions_one_live_trial_idx ON subscriptions (customer_id, product_id) WHERE kind = 'trial' AND status = 'active';
COMMIT;
