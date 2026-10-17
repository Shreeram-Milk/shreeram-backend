-- 0014: delivery setup moves onto the product. The separate "fulfilment profile" step is no longer used.
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything changes or nothing does. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
-- A product now carries its own delivery method, delivery area, cut-off rule and production-planning choice.
-- Any product that already pointed at a profile gets that profile's values copied in first.
-- Nothing is deleted: the old fulfilment_profiles table and products.fulfilment_profile_id stay in place, unused, and can be
-- removed in a later cleanup once you have confirmed everything works.

BEGIN;

ALTER TABLE products
  ADD COLUMN delivery_method text CHECK (delivery_method IN ('local_delivery', 'shipping')),
  ADD COLUMN service_area_id uuid REFERENCES service_areas (id),
  ADD COLUMN cutoff_rule_id uuid REFERENCES cutoff_rules (id),
  ADD COLUMN include_in_production_planning boolean NOT NULL DEFAULT false;

UPDATE products p
   SET delivery_method = f.delivery_method,
       service_area_id = f.service_area_id,
       cutoff_rule_id = f.cutoff_rule_id,
       include_in_production_planning = f.include_in_production_planning
  FROM fulfilment_profiles f
 WHERE f.id = p.fulfilment_profile_id;

-- The old rule "a live product must have a profile" would now block every product, so remove just that rule.
DO $$
DECLARE
  old_rule text;
BEGIN
  FOR old_rule IN
    SELECT c.conname FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'products'::regclass AND c.contype = 'c' AND a.attname = 'fulfilment_profile_id'
  LOOP
    EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', old_rule);
  END LOOP;
END;
$$;

-- A live (or switched-off) product must be fully set up; a draft may be half-finished.
ALTER TABLE products ADD CONSTRAINT products_delivery_complete_check
  CHECK (status = 'draft' OR (delivery_method IS NOT NULL AND service_area_id IS NOT NULL));
-- Shipping has no cut-off rule and is not part of the daily production plan.
ALTER TABLE products ADD CONSTRAINT products_shipping_simple_check
  CHECK (delivery_method IS DISTINCT FROM 'shipping' OR (cutoff_rule_id IS NULL AND NOT include_in_production_planning));
-- A cut-off rule only makes sense with an area to deliver to.
ALTER TABLE products ADD CONSTRAINT products_cutoff_needs_area_check
  CHECK (cutoff_rule_id IS NULL OR service_area_id IS NOT NULL);

CREATE INDEX products_service_area_idx ON products (service_area_id);
CREATE INDEX products_cutoff_rule_idx ON products (cutoff_rule_id);

-- Same cross-table rule as before, now on the product: local delivery needs a PIN-code area; shipping needs a state or all-India area.
CREATE FUNCTION products_check_area() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  area_coverage text;
BEGIN
  IF NEW.service_area_id IS NULL THEN RETURN NEW; END IF;
  SELECT coverage_type INTO area_coverage FROM service_areas WHERE id = NEW.service_area_id;
  IF NEW.delivery_method = 'local_delivery' AND area_coverage <> 'pin_code' THEN
    RAISE EXCEPTION 'Local delivery needs a PIN-code delivery area.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.delivery_method = 'shipping' AND area_coverage = 'pin_code' THEN
    RAISE EXCEPTION 'Shipping needs a whole-state or all-India delivery area.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_check_area_trigger BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_check_area();

-- And the reverse: an area's coverage type cannot be changed to something its products cannot use.
CREATE OR REPLACE FUNCTION service_areas_check_coverage_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coverage_type <> OLD.coverage_type AND EXISTS (
    SELECT 1 FROM products p
    WHERE p.service_area_id = NEW.id
      AND ((p.delivery_method = 'local_delivery' AND NEW.coverage_type <> 'pin_code')
        OR (p.delivery_method = 'shipping' AND NEW.coverage_type = 'pin_code'))
  ) THEN
    RAISE EXCEPTION 'This area is used by products that need its current coverage type.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
