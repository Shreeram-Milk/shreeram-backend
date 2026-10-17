-- Sample delivery setup for DEVELOPMENT, so you do not have to type it into the admin.
-- It adds: 2 delivery slots, 2 trial plans, 3 subscription rules, 1 cut-off rule, 3 service areas (Gandhinagar with 3 PIN codes,
-- Gujarat, Pan India) and 2 fulfilment profiles. These are the same examples the old sample screens showed.
-- Safe to run more than once: anything that already exists (same name / same PIN) is skipped, nothing is changed or deleted.
-- Run as the migration user (shreeram_migrate) in pgAdmin. Wrapped in BEGIN/COMMIT: all or nothing.
-- Do NOT run this on the real (production) database. Real settings are entered in the admin.

BEGIN;

INSERT INTO delivery_slots (name, description, start_time, end_time) VALUES
  ('Morning', 'Early-day delivery window.', '06:00', '09:00'),
  ('Evening', 'Evening delivery window.', '17:00', '20:00')
ON CONFLICT (lower(trim(name))) DO NOTHING;

INSERT INTO trial_plans (name, description, duration_days) VALUES
  ('3-Day Trial', 'A short introductory trial.', 3),
  ('7-Day Trial', 'A full week to experience the service.', 7)
ON CONFLICT (lower(trim(name))) DO NOTHING;

INSERT INTO subscription_rules (name, description, system_type) VALUES
  ('Daily', 'Delivery every day.', 'daily'),
  ('Alternate Days', 'Delivery on alternating days.', 'alternate_days'),
  ('Custom Weekdays', 'Customers choose their delivery weekdays.', 'custom_weekdays')
ON CONFLICT (lower(trim(name))) DO NOTHING;

-- Cut-off rule: Morning must be ordered by 3 PM the day before; Evening by 11 AM the same day.
INSERT INTO cutoff_rules (name, description) VALUES
  ('Standard Milk Cut-off', 'Ordering deadlines for milk deliveries.')
ON CONFLICT (lower(trim(name))) DO NOTHING;

INSERT INTO cutoff_conditions (cutoff_rule_id, delivery_slot_id, day_relation, cutoff_time)
SELECT r.id, s.id, c.day_relation, c.cutoff_time::time
FROM (VALUES ('Morning', 'previous_day', '15:00'), ('Evening', 'same_day', '11:00')) AS c(slot_name, day_relation, cutoff_time)
JOIN cutoff_rules r ON lower(trim(r.name)) = lower('Standard Milk Cut-off')
JOIN delivery_slots s ON lower(trim(s.name)) = lower(c.slot_name)
ON CONFLICT (cutoff_rule_id, delivery_slot_id) DO NOTHING;

INSERT INTO service_areas (name, description, coverage_type, state, city) VALUES
  ('Gandhinagar Local Delivery', 'Local delivery around Gandhinagar.', 'pin_code', 'Gujarat', 'Gandhinagar'),
  ('Gujarat', 'State-wide shipping coverage.', 'state', 'Gujarat', ''),
  ('Pan India', 'Nationwide shipping coverage.', 'pan_india', '', '')
ON CONFLICT (lower(trim(name))) DO NOTHING;

-- Gandhinagar PIN codes and the slots each one gets.
INSERT INTO service_area_pins (service_area_id, pin_code, locality)
SELECT a.id, p.pin_code, p.locality
FROM (VALUES ('382010', 'Sector 10'), ('382011', 'Sector 11'), ('382012', 'Sector 12')) AS p(pin_code, locality)
JOIN service_areas a ON lower(trim(a.name)) = lower('Gandhinagar Local Delivery')
ON CONFLICT (service_area_id, pin_code) DO NOTHING;

INSERT INTO service_area_pin_slots (pin_id, delivery_slot_id)
SELECT pin.id, s.id
FROM (VALUES ('382010', 'Morning'), ('382010', 'Evening'), ('382011', 'Morning'), ('382012', 'Evening')) AS g(pin_code, slot_name)
JOIN service_areas a ON lower(trim(a.name)) = lower('Gandhinagar Local Delivery')
JOIN service_area_pins pin ON pin.service_area_id = a.id AND pin.pin_code = g.pin_code
JOIN delivery_slots s ON lower(trim(s.name)) = lower(g.slot_name)
ON CONFLICT (pin_id, delivery_slot_id) DO NOTHING;

-- Fulfilment profiles ("delivery rules cards").
INSERT INTO fulfilment_profiles (name, description, delivery_method, service_area_id, cutoff_rule_id, include_in_production_planning)
SELECT 'Gandhinagar Milk Standard', 'Local milk fulfilment settings.', 'local_delivery', a.id, r.id, true
FROM service_areas a, cutoff_rules r
WHERE lower(trim(a.name)) = lower('Gandhinagar Local Delivery') AND lower(trim(r.name)) = lower('Standard Milk Cut-off')
ON CONFLICT (lower(trim(name))) DO NOTHING;

INSERT INTO fulfilment_profiles (name, description, delivery_method, service_area_id, cutoff_rule_id, include_in_production_planning)
SELECT 'Pan India Shipping', 'Nationwide shipping settings.', 'shipping', a.id, NULL, false
FROM service_areas a
WHERE lower(trim(a.name)) = lower('Pan India')
ON CONFLICT (lower(trim(name))) DO NOTHING;

COMMIT;
