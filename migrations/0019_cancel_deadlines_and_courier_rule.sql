-- 0019: cancel deadlines, and courier products are bought once only.
--
-- 1. A cut-off rule can say, per delivery slot, until when customers may cancel an order or skip a subscription day. Left
--    empty it is the order cut-off itself (how it worked before). It is never later than the cut-off, so production
--    planning's "Final" still means nothing can change any more.
-- 2. Every order keeps its own cancel deadline from the moment it is placed, so changing a rule later never changes an
--    order that already exists. Older orders have none and keep using their order-by time.
-- 3. Courier (shipping) products cannot offer a trial or a subscription: those need a delivery window every day. Any
--    existing courier product that offers them is set back to "buy once".
--
-- Only additions and that one data correction. Run it once, in pgAdmin, as postgres.

BEGIN;

ALTER TABLE cutoff_conditions
  ADD COLUMN cancel_day_relation text CHECK (cancel_day_relation IN ('same_day', 'previous_day')),
  ADD COLUMN cancel_time time,
  ADD CONSTRAINT cutoff_conditions_cancel_pair CHECK ((cancel_day_relation IS NULL) = (cancel_time IS NULL));

ALTER TABLE orders ADD COLUMN cancel_by timestamptz;

-- Courier products: buy once only. Their trial and subscription choices are removed too.
DELETE FROM product_trial_plans WHERE product_id IN (SELECT id FROM products WHERE delivery_method = 'shipping');
DELETE FROM product_subscription_rules WHERE product_id IN (SELECT id FROM products WHERE delivery_method = 'shipping');
UPDATE products SET purchase_methods = ARRAY['buy_once'], updated_at = now()
  WHERE delivery_method = 'shipping' AND purchase_methods && ARRAY['trial', 'subscription'];

COMMIT;
