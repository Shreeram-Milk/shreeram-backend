-- Lets the admin delete a master value that nothing uses (the server checks usage first).
-- Foreign keys still stop a delete if anything refers to the row.
GRANT DELETE ON categories, trial_plans, subscription_rules, delivery_slots, cutoff_rules, service_areas, fulfilment_profiles TO shreeram_app;
