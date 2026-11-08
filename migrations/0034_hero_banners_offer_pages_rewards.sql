-- 0034: curved top (hero) banners, offer pages, scratch-card rewards and the soft "update available" strip.
-- Run as the migration user (shreeram_migrate), once, in a NEW pgAdmin query tab. Wrapped in BEGIN/COMMIT: everything or nothing.
-- It only adds columns, rules and one table. No existing banner, offer, order or customer is changed.

BEGIN;

-- 1) Banners -----------------------------------------------------------------------------------------------------
-- "Show text on banner": off shows the picture alone (for pictures that already carry their own words).
ALTER TABLE banners ADD COLUMN IF NOT EXISTS show_text boolean NOT NULL DEFAULT true;

-- A banner can open more pages. product / category / offer need the chosen item; the others open a fixed page.
DO $$
DECLARE rule record;
BEGIN
  FOR rule IN SELECT conname FROM pg_constraint WHERE conrelid = 'banners'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%cta_t%' LOOP
    EXECUTE format('ALTER TABLE banners DROP CONSTRAINT %I', rule.conname);
  END LOOP;
END $$;
ALTER TABLE banners
  ADD CONSTRAINT banners_cta_type_check CHECK (cta_type IN ('none', 'product', 'category', 'offers', 'offer', 'subscriptions', 'trials', 'orders', 'rewards')),
  ADD CONSTRAINT banners_cta_target_check CHECK ((cta_type IN ('product', 'category', 'offer')) = (cta_target <> ''));

-- 2) Offers ------------------------------------------------------------------------------------------------------
-- Offer pictures use the same picture storage as banners and products.
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_purpose_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_purpose_check CHECK (purpose IN ('banner', 'banner_icon', 'onboarding', 'product', 'offer'));

ALTER TABLE offers
  -- The picture at the top of the offer page. Removing the picture never deletes the offer.
  ADD COLUMN IF NOT EXISTS image_asset_id uuid REFERENCES media_assets (id) ON DELETE SET NULL,
  -- "Show text on the picture", the same switch as banners.
  ADD COLUMN IF NOT EXISTS show_text boolean NOT NULL DEFAULT true,
  -- The bullet points under the code: [{"en": "Valid above Rs 300", "gu": "..."}], at most 8.
  ADD COLUMN IF NOT EXISTS points jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Rewards: this offer can come out of a scratch card.
  ADD COLUMN IF NOT EXISTS in_reward_pool boolean NOT NULL DEFAULT false,
  -- Rewards: the code works only for a customer who scratched a card for it (stops codes being shared on WhatsApp).
  ADD COLUMN IF NOT EXISTS reward_only boolean NOT NULL DEFAULT false;
ALTER TABLE offers ADD CONSTRAINT offers_points_check CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) <= 8);
-- A reward-only offer must have a code to reveal.
ALTER TABLE offers ADD CONSTRAINT offers_reward_only_code_check CHECK (NOT reward_only OR code IS NOT NULL);

-- 3) Reward settings and the "update available" strip ------------------------------------------------------------
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS rewards_enabled boolean NOT NULL DEFAULT false,
  -- A delivered order of at least this amount earns one scratch card. 0 = every delivered order.
  ADD COLUMN IF NOT EXISTS rewards_min_order_paise bigint NOT NULL DEFAULT 0 CHECK (rewards_min_order_paise >= 0),
  ADD COLUMN IF NOT EXISTS rewards_expiry_days integer NOT NULL DEFAULT 30 CHECK (rewards_expiry_days BETWEEN 1 AND 365),
  -- Newest app on the Play Store. Older apps show a small "Update available" strip and keep working.
  -- minimum_app_version stays as the emergency switch: apps older than it are stopped until updated.
  ADD COLUMN IF NOT EXISTS latest_app_version text NOT NULL DEFAULT '1.0.0' CHECK (latest_app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

-- 4) Scratch cards -----------------------------------------------------------------------------------------------
-- One card per delivered order. Every card holds a real offer (never "better luck next time") and is free.
CREATE TABLE IF NOT EXISTS reward_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  order_id uuid NOT NULL REFERENCES orders (id),
  offer_id uuid NOT NULL REFERENCES offers (id),
  scratched_at timestamptz,
  -- Set when the code is used on an order, so one card gives one use.
  used_at timestamptz,
  used_order_id uuid REFERENCES orders (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reward_cards_order_unique UNIQUE (order_id),
  CONSTRAINT reward_cards_use_check CHECK ((used_at IS NULL) = (used_order_id IS NULL)),
  CONSTRAINT reward_cards_scratch_before_use_check CHECK (used_at IS NULL OR scratched_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS reward_cards_customer_idx ON reward_cards (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reward_cards_offer_idx ON reward_cards (offer_id, customer_id);

-- 5) Notifications -----------------------------------------------------------------------------------------------
-- A one-off message can open a chosen page, such as one offer (/offer?offerId=...).
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS link text CHECK (link IS NULL OR length(link) <= 200);

-- New automatic message: "You won a scratch card".
DO $$
DECLARE found record;
BEGIN
  FOR found IN
    SELECT t.relname AS table_name, c.conname AS constraint_name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname IN ('notification_templates', 'notifications') AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%event_key%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', found.table_name, found.constraint_name);
  END LOOP;
END $$;
ALTER TABLE notification_templates ADD CONSTRAINT notification_templates_event_key_check
  CHECK (event_key IN ('order_placed', 'order_cancelled', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'rider_arriving', 'reward_won'));
ALTER TABLE notifications ADD CONSTRAINT notifications_event_key_check
  CHECK (event_key IN ('order_placed', 'order_cancelled', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'rider_arriving', 'reward_won', 'broadcast'));

INSERT INTO notification_templates (event_key, title, title_gu, body, body_gu) VALUES
  ('reward_won', 'You won a scratch card!', 'તમે સ્ક્રેચ કાર્ડ જીત્યું!',
   'Thank you for your order {{order}}. Open the app and scratch your card to see your reward.',
   'તમારા ઓર્ડર {{order}} માટે આભાર. તમારું ઇનામ જોવા માટે એપ ખોલો અને કાર્ડ સ્ક્રેચ કરો.')
ON CONFLICT (event_key) DO NOTHING;

-- 6) Permissions for the backend's database user -----------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON reward_cards TO shreeram_app;

COMMIT;
