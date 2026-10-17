-- 0004: optional label on banners, SVG icons, and the first-run introduction slides.
-- Run as the migration user (shreeram_migrate). Run it BEFORE restarting the backend with the matching code.

-- 1) Pictures: allow small SVG icons (for Maintenance and Information banners) and onboarding pictures.
--    Promotion banners keep using JPEG, PNG or WebP photos.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_purpose_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check CHECK (purpose IN ('banner', 'banner_icon', 'onboarding'));
ALTER TABLE media_assets DROP CONSTRAINT media_assets_content_type_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_content_type_check CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'));

-- 2) Banners: an optional short label shown on the card (for example "SEASONAL OFFER"). Empty means no label is shown.
ALTER TABLE banners ADD COLUMN label_en text NOT NULL DEFAULT '' CHECK (length(label_en) <= 24);
ALTER TABLE banners ADD COLUMN label_gu text NOT NULL DEFAULT '' CHECK (length(label_gu) <= 24);

-- 3) The customer app's first-run introduction: one row per screen, each with its own picture, headline and text.
CREATE TABLE onboarding_slides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_asset_id uuid NOT NULL REFERENCES media_assets (id),
  title_en text NOT NULL CHECK (length(trim(title_en)) BETWEEN 1 AND 80),
  title_gu text NOT NULL DEFAULT '' CHECK (length(title_gu) <= 80),
  description_en text NOT NULL CHECK (length(trim(description_en)) BETWEEN 1 AND 200),
  description_gu text NOT NULL DEFAULT '' CHECK (length(description_gu) <= 200),
  sort_order integer NOT NULL CHECK (sort_order >= 1),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_slides_order_idx ON onboarding_slides (status, sort_order);

-- 4) The backend's database user needs permission on the new table (the lesson from 0003).
GRANT SELECT, INSERT, UPDATE ON onboarding_slides TO shreeram_app;
