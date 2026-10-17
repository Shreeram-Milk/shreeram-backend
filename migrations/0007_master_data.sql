-- 0007: master data — the shared building blocks that products and orders use.
--   categories · delivery slots · cut-off rules · service areas (with PIN codes) · fulfilment profiles
--   trial plans · subscription rules
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;`
-- once and send me the error. It creates new tables only; it does not touch any existing table or data.
-- Nothing is pre-filled: these are your business settings, you enter them in the admin.
-- Records are never deleted when they are in use: they are switched to 'inactive'. Only the "child" rows that are
-- replaced as a set (cut-off conditions, PIN codes, PIN slots) can be deleted.

BEGIN;

-- ============================================================================================
-- Categories: the shelves customers browse (Milk, Curd, Ghee...).
-- ============================================================================================
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  name_gu text NOT NULL DEFAULT '' CHECK (length(name_gu) <= 40),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX categories_name_unique_idx ON categories (lower(trim(name)));

-- ============================================================================================
-- Trial plans (for example a 3-day or 7-day trial) and subscription rules (daily, alternate days, chosen weekdays).
-- ============================================================================================
CREATE TABLE trial_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  duration_days integer NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX trial_plans_name_unique_idx ON trial_plans (lower(trim(name)));

CREATE TABLE subscription_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  system_type text NOT NULL CHECK (system_type IN ('daily', 'alternate_days', 'custom_weekdays')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX subscription_rules_name_unique_idx ON subscription_rules (lower(trim(name)));

-- ============================================================================================
-- Delivery slots: the time windows (for example Morning 05:00–07:00). Times are India local times.
-- ============================================================================================
CREATE TABLE delivery_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  start_time time NOT NULL,
  end_time time NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  CHECK (end_time > start_time)
);
CREATE UNIQUE INDEX delivery_slots_name_unique_idx ON delivery_slots (lower(trim(name)));

-- ============================================================================================
-- Cut-off rules: "order before this time, on this day, for this slot". One condition per slot.
-- ============================================================================================
CREATE TABLE cutoff_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX cutoff_rules_name_unique_idx ON cutoff_rules (lower(trim(name)));

CREATE TABLE cutoff_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cutoff_rule_id uuid NOT NULL REFERENCES cutoff_rules (id) ON DELETE CASCADE,
  delivery_slot_id uuid NOT NULL REFERENCES delivery_slots (id),
  day_relation text NOT NULL CHECK (day_relation IN ('same_day', 'previous_day')),
  cutoff_time time NOT NULL,
  UNIQUE (cutoff_rule_id, delivery_slot_id)
);

-- ============================================================================================
-- Service areas: where you deliver. By PIN-code list, by whole state, or all of India.
-- Each PIN inside a PIN-code area has its own list of allowed slots.
-- ============================================================================================
CREATE TABLE service_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  coverage_type text NOT NULL CHECK (coverage_type IN ('pin_code', 'state', 'pan_india')),
  state text NOT NULL DEFAULT '' CHECK (length(state) <= 60),
  city text NOT NULL DEFAULT '' CHECK (length(city) <= 60),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  -- A whole-state area names its state; an all-India area names neither state nor city.
  CHECK (coverage_type <> 'state' OR length(trim(state)) > 0),
  CHECK (coverage_type <> 'pan_india' OR (state = '' AND city = ''))
);
CREATE UNIQUE INDEX service_areas_name_unique_idx ON service_areas (lower(trim(name)));

CREATE TABLE service_area_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid NOT NULL REFERENCES service_areas (id) ON DELETE CASCADE,
  pin_code text NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  locality text NOT NULL DEFAULT '' CHECK (length(locality) <= 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  UNIQUE (service_area_id, pin_code)
);
-- "Which areas serve this PIN?" is the question asked at checkout, so it needs to be instant.
CREATE INDEX service_area_pins_pin_code_idx ON service_area_pins (pin_code);

CREATE TABLE service_area_pin_slots (
  pin_id uuid NOT NULL REFERENCES service_area_pins (id) ON DELETE CASCADE,
  delivery_slot_id uuid NOT NULL REFERENCES delivery_slots (id),
  PRIMARY KEY (pin_id, delivery_slot_id)
);
CREATE INDEX service_area_pin_slots_slot_idx ON service_area_pin_slots (delivery_slot_id);

-- ============================================================================================
-- Fulfilment profiles: the "delivery rules card" a product carries.
--   how it travels + where it can go (one service area) + order-by time (one cut-off rule) + whether it counts in production planning.
-- ============================================================================================
CREATE TABLE fulfilment_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  delivery_method text NOT NULL CHECK (delivery_method IN ('local_delivery', 'shipping')),
  service_area_id uuid NOT NULL REFERENCES service_areas (id),
  cutoff_rule_id uuid REFERENCES cutoff_rules (id),
  include_in_production_planning boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  -- Shipping has no cut-off rule and is not part of the daily production plan.
  CHECK (delivery_method = 'local_delivery' OR (cutoff_rule_id IS NULL AND NOT include_in_production_planning))
);
CREATE UNIQUE INDEX fulfilment_profiles_name_unique_idx ON fulfilment_profiles (lower(trim(name)));
CREATE INDEX fulfilment_profiles_area_idx ON fulfilment_profiles (service_area_id);
CREATE INDEX fulfilment_profiles_cutoff_idx ON fulfilment_profiles (cutoff_rule_id);

-- Rules that span two tables, enforced by the database so no screen or bug can break them:
--   local delivery needs a PIN-code area; shipping needs a whole-state or all-India area.
CREATE FUNCTION fulfilment_profiles_check_area() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  area_coverage text;
BEGIN
  SELECT coverage_type INTO area_coverage FROM service_areas WHERE id = NEW.service_area_id;
  IF NEW.delivery_method = 'local_delivery' AND area_coverage <> 'pin_code' THEN
    RAISE EXCEPTION 'Local delivery needs a PIN-code service area.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.delivery_method = 'shipping' AND area_coverage = 'pin_code' THEN
    RAISE EXCEPTION 'Shipping needs a whole-state or all-India service area.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fulfilment_profiles_check_area_trigger BEFORE INSERT OR UPDATE ON fulfilment_profiles
  FOR EACH ROW EXECUTE FUNCTION fulfilment_profiles_check_area();

-- And the reverse: an area's coverage type cannot be changed to something its existing profiles cannot use.
CREATE FUNCTION service_areas_check_coverage_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coverage_type <> OLD.coverage_type AND EXISTS (
    SELECT 1 FROM fulfilment_profiles p
    WHERE p.service_area_id = NEW.id
      AND ((p.delivery_method = 'local_delivery' AND NEW.coverage_type <> 'pin_code')
        OR (p.delivery_method = 'shipping' AND NEW.coverage_type = 'pin_code'))
  ) THEN
    RAISE EXCEPTION 'This area is used by delivery rules cards that need its current coverage type.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER service_areas_check_coverage_change_trigger BEFORE UPDATE ON service_areas
  FOR EACH ROW EXECUTE FUNCTION service_areas_check_coverage_change();

-- ============================================================================================
-- Permissions for the backend's database user (the lesson from 0003 and 0006).
--   Main records: read, add, edit. They are switched to 'inactive', never deleted.
--   Child rows replaced as a set (cut-off conditions, PINs, PIN slots): also delete.
-- ============================================================================================
GRANT SELECT, INSERT, UPDATE ON categories, trial_plans, subscription_rules, delivery_slots, cutoff_rules, service_areas, fulfilment_profiles TO shreeram_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cutoff_conditions, service_area_pins, service_area_pin_slots TO shreeram_app;

COMMIT;
