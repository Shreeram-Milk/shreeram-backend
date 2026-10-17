-- 0024: offers: percent off, flat off, and free gifts (with a one-time purchase, a trial or a subscription).
-- Run as the migration user (shreeram_migrate), once, in a NEW pgAdmin query tab. Wrapped in BEGIN/COMMIT: everything or nothing.
-- It only adds tables and columns (and lets a banner open the Offers page); no existing data is changed.

BEGIN;

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  title_gu text NOT NULL DEFAULT '' CHECK (length(title_gu) <= 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  description_gu text NOT NULL DEFAULT '' CHECK (length(description_gu) <= 300),
  -- percent: % off; flat: rupees off; free_gift: a free product with a purchase, trial or subscription.
  kind text NOT NULL CHECK (kind IN ('percent', 'flat', 'free_gift')),
  percent integer CHECK (percent IS NULL OR percent BETWEEN 1 AND 100),
  flat_paise bigint CHECK (flat_paise IS NULL OR flat_paise > 0),
  -- "20% off, up to Rs 100": the most this offer ever takes off one checkout.
  max_discount_paise bigint CHECK (max_discount_paise IS NULL OR max_discount_paise > 0),
  min_order_paise bigint NOT NULL DEFAULT 0 CHECK (min_order_paise >= 0),
  -- order: the whole cart counts; products: only the chosen products (offer_products) count.
  scope text NOT NULL DEFAULT 'order' CHECK (scope IN ('order', 'products')),
  applies_one_time boolean NOT NULL DEFAULT true,
  applies_trial boolean NOT NULL DEFAULT false,
  applies_subscription boolean NOT NULL DEFAULT false,
  -- A subscription offer such as "30-day plan": the plan must be at least this many days. Null = any length.
  min_plan_days integer CHECK (min_plan_days IS NULL OR min_plan_days > 0),
  -- The free product of a free_gift offer. It is free only inside this offer.
  gift_variant_id uuid REFERENCES product_variants (id),
  gift_quantity integer NOT NULL DEFAULT 1 CHECK (gift_quantity BETWEEN 1 AND 20),
  code text CHECK (code IS NULL OR code ~ '^[A-Z0-9]{3,20}$'),
  starts_on date,
  ends_on date,
  total_limit integer CHECK (total_limit IS NULL OR total_limit > 0),
  per_customer_limit integer CHECK (per_customer_limit IS NULL OR per_customer_limit > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offers_value_check CHECK (
    (kind = 'percent' AND percent IS NOT NULL AND flat_paise IS NULL AND gift_variant_id IS NULL)
    OR (kind = 'flat' AND flat_paise IS NOT NULL AND percent IS NULL AND gift_variant_id IS NULL)
    OR (kind = 'free_gift' AND gift_variant_id IS NOT NULL AND percent IS NULL AND flat_paise IS NULL)
  ),
  CONSTRAINT offers_dates_check CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT offers_applies_check CHECK (applies_one_time OR applies_trial OR applies_subscription)
);

CREATE UNIQUE INDEX offers_code_unique_idx ON offers (code) WHERE code IS NOT NULL;
CREATE INDEX offers_status_idx ON offers (status);

-- The products an offer is limited to (scope = products), or the products that earn a gift.
CREATE TABLE offer_products (
  offer_id uuid NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id),
  PRIMARY KEY (offer_id, product_id)
);
CREATE INDEX offer_products_product_idx ON offer_products (product_id);

-- One row each time an offer is used on an order. checkout_key groups the orders of one checkout, so a checkout counts once.
CREATE TABLE offer_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers (id),
  customer_id uuid NOT NULL REFERENCES customers (id),
  checkout_key text NOT NULL,
  order_id uuid REFERENCES orders (id),
  subscription_id uuid REFERENCES subscriptions (id),
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offer_redemptions_target_check CHECK (order_id IS NOT NULL OR subscription_id IS NOT NULL)
);
CREATE UNIQUE INDEX offer_redemptions_order_unique_idx ON offer_redemptions (offer_id, order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX offer_redemptions_subscription_unique_idx ON offer_redemptions (offer_id, subscription_id) WHERE subscription_id IS NOT NULL;
CREATE INDEX offer_redemptions_offer_idx ON offer_redemptions (offer_id, customer_id);

-- What each order remembers about the offer it used, even if the offer is later changed or switched off.
ALTER TABLE orders
  ADD COLUMN offer_id uuid REFERENCES offers (id),
  ADD COLUMN offer_title text NOT NULL DEFAULT '',
  ADD COLUMN offer_title_gu text NOT NULL DEFAULT '';

-- A free gift line costs nothing and is cancelled together with the purchase that earned it.
ALTER TABLE order_items ADD COLUMN is_gift boolean NOT NULL DEFAULT false;

-- A subscription or trial remembers the offer it started with: the money taken off (spread over its deliveries) and the free gift (sent with the first delivery).
ALTER TABLE subscriptions
  ADD COLUMN offer_id uuid REFERENCES offers (id),
  ADD COLUMN offer_title text NOT NULL DEFAULT '',
  ADD COLUMN offer_title_gu text NOT NULL DEFAULT '',
  ADD COLUMN discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  ADD COLUMN gift jsonb;

-- A banner can now open the Offers page. The old rules allowed only "no link", a product or a category, so they are replaced.
DO $$
DECLARE rule record;
BEGIN
  FOR rule IN SELECT conname FROM pg_constraint WHERE conrelid = 'banners'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%cta_type%' LOOP
    EXECUTE format('ALTER TABLE banners DROP CONSTRAINT %I', rule.conname);
  END LOOP;
END $$;
ALTER TABLE banners
  ADD CONSTRAINT banners_cta_type_check CHECK (cta_type IN ('none', 'product', 'category', 'offers')),
  ADD CONSTRAINT banners_cta_target_check CHECK ((cta_type IN ('none', 'offers')) = (cta_target = ''));

GRANT SELECT, INSERT, UPDATE ON offers TO shreeram_app;
GRANT SELECT, INSERT, DELETE ON offer_products TO shreeram_app;
GRANT SELECT, INSERT ON offer_redemptions TO shreeram_app;

COMMIT;
