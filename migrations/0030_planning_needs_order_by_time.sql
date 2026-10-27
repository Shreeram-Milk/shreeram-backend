-- Production planning is for products we deliver ourselves that have an order-by time: the plan exists to know how much to make
-- before ordering closes. Courier products and products with no order-by time have nothing to plan.
-- This switches planning off for any product that does not qualify, together with the copy of that choice kept on its subscriptions
-- and on its coming (not yet delivered) orders, and then makes the database refuse the combination from now on.
-- Orders already delivered, cancelled or missed are left exactly as they are. Safe to run more than once.
DO $$
DECLARE
  products_off integer;
  subscriptions_off integer;
  order_lines_off integer;
BEGIN
  CREATE TEMP TABLE switched_off ON COMMIT DROP AS
    SELECT id FROM products
    WHERE include_in_production_planning AND (delivery_method IS DISTINCT FROM 'local_delivery' OR cutoff_rule_id IS NULL);
  SELECT count(*) INTO products_off FROM switched_off;

  UPDATE products SET include_in_production_planning = false, updated_at = now() WHERE id IN (SELECT id FROM switched_off);

  UPDATE subscriptions SET include_in_production_planning = false
    WHERE include_in_production_planning AND product_id IN (SELECT id FROM switched_off);
  GET DIAGNOSTICS subscriptions_off = ROW_COUNT;

  UPDATE order_items SET include_in_production_planning = false
    WHERE include_in_production_planning AND product_id IN (SELECT id FROM switched_off)
      AND order_id IN (SELECT id FROM orders WHERE status = 'placed' AND delivery_date >= CURRENT_DATE);
  GET DIAGNOSTICS order_lines_off = ROW_COUNT;

  RAISE NOTICE 'Production planning switched off: % product(s), % subscription(s), % coming order line(s).', products_off, subscriptions_off, order_lines_off;
END $$;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_planning_needs_cutoff_check;
ALTER TABLE products ADD CONSTRAINT products_planning_needs_cutoff_check
  CHECK (NOT include_in_production_planning OR (delivery_method = 'local_delivery' AND cutoff_rule_id IS NOT NULL));
