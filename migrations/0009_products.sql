-- 0009: products — what you sell: the product, its sizes/prices (variants), how it can be bought, its pictures, and which
-- delivery rules card, trial plans and subscription rules it uses.
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
-- It creates new tables and changes ONE rule on the existing media table (to allow product pictures). It deletes nothing.
-- Money is stored as whole paise (Rs 125.50 = 12550) so there are never rounding errors.
-- Products and variants are never deleted: they are switched to 'inactive', so old orders keep making sense.

BEGIN;

-- Product pictures use the same picture storage as banners. Allow the new purpose.
ALTER TABLE media_assets DROP CONSTRAINT media_assets_purpose_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check CHECK (purpose IN ('banner', 'banner_icon', 'onboarding', 'product'));

-- ============================================================================================
-- Products
-- ============================================================================================
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  name_gu text NOT NULL DEFAULT '' CHECK (length(name_gu) <= 80),
  category_id uuid NOT NULL REFERENCES categories (id),
  sku text NOT NULL DEFAULT '' CHECK (length(sku) <= 40),
  short_description_en text NOT NULL DEFAULT '' CHECK (length(short_description_en) <= 200),
  short_description_gu text NOT NULL DEFAULT '' CHECK (length(short_description_gu) <= 200),
  long_description_en text NOT NULL DEFAULT '' CHECK (length(long_description_en) <= 2000),
  long_description_gu text NOT NULL DEFAULT '' CHECK (length(long_description_gu) <= 2000),
  nutrition_en text NOT NULL DEFAULT '' CHECK (length(nutrition_en) <= 1000),
  nutrition_gu text NOT NULL DEFAULT '' CHECK (length(nutrition_gu) <= 1000),
  highlights_en text[] NOT NULL DEFAULT '{}' CHECK (cardinality(highlights_en) <= 6),
  highlights_gu text[] NOT NULL DEFAULT '{}' CHECK (cardinality(highlights_gu) <= 6),
  badges text[] NOT NULL DEFAULT '{}' CHECK (badges <@ ARRAY['bestseller', 'new', 'organic', 'seasonal']),
  primary_image_asset_id uuid REFERENCES media_assets (id) ON DELETE SET NULL,
  -- How it can be bought: once, as a trial, as a subscription (any combination).
  purchase_methods text[] NOT NULL DEFAULT '{}' CHECK (purchase_methods <@ ARRAY['buy_once', 'trial', 'subscription']),
  -- The delivery rules card (where it can go, order-by time). A draft may not have one yet; a live product must.
  fulfilment_profile_id uuid REFERENCES fulfilment_profiles (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  CHECK (status = 'draft' OR fulfilment_profile_id IS NOT NULL),
  CHECK (status = 'draft' OR cardinality(purchase_methods) > 0)
);
CREATE UNIQUE INDEX products_name_unique_idx ON products (lower(trim(name)));
CREATE UNIQUE INDEX products_sku_unique_idx ON products (lower(sku)) WHERE sku <> '';
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_fulfilment_profile_idx ON products (fulfilment_profile_id);
CREATE INDEX products_status_idx ON products (status);

-- Extra pictures shown on the product page, in order. (The main picture is on the product itself.)
CREATE TABLE product_gallery_images (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  media_asset_id uuid NOT NULL REFERENCES media_assets (id),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (product_id, media_asset_id),
  UNIQUE (product_id, position)
);

-- ============================================================================================
-- Variants: the sizes you sell and their prices (for example 500 ml and 1 L).
-- ============================================================================================
CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products (id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  sku text NOT NULL DEFAULT '' CHECK (length(sku) <= 40),
  price_paise integer NOT NULL CHECK (price_paise >= 0),
  compare_at_price_paise integer CHECK (compare_at_price_paise IS NULL OR compare_at_price_paise > price_paise),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- What the customer sees ("500 ml") and what production planning counts ("0.5 Litre").
  display_unit text NOT NULL CHECK (length(trim(display_unit)) BETWEEN 1 AND 20),
  display_quantity numeric(12, 3) NOT NULL CHECK (display_quantity > 0),
  production_unit text NOT NULL DEFAULT '' CHECK (length(production_unit) <= 20),
  production_quantity numeric(12, 3) NOT NULL DEFAULT 0 CHECK (production_quantity >= 0),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_variants_name_unique_idx ON product_variants (product_id, lower(trim(name)));
CREATE UNIQUE INDEX product_variants_sku_unique_idx ON product_variants (lower(sku)) WHERE sku <> '';
CREATE INDEX product_variants_product_idx ON product_variants (product_id, sort_order);

-- ============================================================================================
-- Which trial plans and subscription rules a product offers.
-- ============================================================================================
CREATE TABLE product_trial_plans (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  trial_plan_id uuid NOT NULL REFERENCES trial_plans (id),
  PRIMARY KEY (product_id, trial_plan_id)
);
CREATE INDEX product_trial_plans_plan_idx ON product_trial_plans (trial_plan_id);

CREATE TABLE product_subscription_rules (
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  subscription_rule_id uuid NOT NULL REFERENCES subscription_rules (id),
  PRIMARY KEY (product_id, subscription_rule_id)
);
CREATE INDEX product_subscription_rules_rule_idx ON product_subscription_rules (subscription_rule_id);

-- ============================================================================================
-- Permissions for the backend's database user.
--   Products and variants: read, add, edit (never delete). The small link lists are replaced as a set, so they can also be deleted.
-- ============================================================================================
GRANT SELECT, INSERT, UPDATE ON products, product_variants TO shreeram_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_gallery_images, product_trial_plans, product_subscription_rules TO shreeram_app;

COMMIT;
