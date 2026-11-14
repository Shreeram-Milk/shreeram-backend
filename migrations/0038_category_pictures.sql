-- 0038: a picture for each category (the round-topped tiles on the app's Home). Run as shreeram_migrate, in one go, in pgAdmin.
-- Wrapped in BEGIN/COMMIT: either everything is applied or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
--
-- What it changes (nothing is deleted; no existing row changes):
--   * pictures may now be uploaded for a category (a new allowed "purpose" for uploaded pictures)
--   * each category gets an optional picture. Categories without one keep working; the app shows a plain tile for them.

BEGIN;

ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_purpose_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check
  CHECK (purpose IN ('banner', 'banner_icon', 'onboarding', 'product', 'offer', 'category'));

ALTER TABLE categories ADD COLUMN IF NOT EXISTS image_asset_id uuid REFERENCES media_assets (id);

COMMIT;
