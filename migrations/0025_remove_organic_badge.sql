-- 0025: the "Organic" product badge is removed (the business does not make that claim).
-- Run as the migration user (shreeram_migrate), once, in a NEW pgAdmin query tab. Wrapped in BEGIN/COMMIT: everything or nothing.
-- Any product that had the badge simply loses it; nothing else changes.

BEGIN;

UPDATE products SET badges = array_remove(badges, 'organic') WHERE 'organic' = ANY (badges);

DO $$
DECLARE rule record;
BEGIN
  FOR rule IN SELECT conname FROM pg_constraint WHERE conrelid = 'products'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%organic%' LOOP
    EXECUTE format('ALTER TABLE products DROP CONSTRAINT %I', rule.conname);
  END LOOP;
END $$;

ALTER TABLE products ADD CONSTRAINT products_badges_check CHECK (badges <@ ARRAY['bestseller', 'new', 'seasonal']);

COMMIT;
