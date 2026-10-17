`-- 0018: subscriptions, trials and deliveries (Bundle C).
--
-- How it fits together:
--   * A subscription (or a trial, which is a short daily subscription) is a promise of N deliveries per chosen slot. The
--     customer picks one or more slots, each with its own quantity, a start date and, for "custom weekdays", the weekdays.
--   * Each delivery becomes a normal order a few days ahead (created by the backend's delivery job), so production planning,
--     the Orders page, tracking and the status buttons work for subscriptions unchanged. Those orders point back here.
--   * Skips and pauses are stored separately; the schedule is worked out from them, so a skipped or paused day moves the end
--     date later and the customer always gets every delivery bought.
--   * Online-paying customers pay the whole subscription upfront (payment purpose 'subscription'); credit customers are
--     charged per delivery when its order is created (a day over the credit limit is skipped and flagged for staff).
--
-- Also here: a separate, once-only "money returned" mark on orders (a missed delivery no longer refunds anything by itself:
-- staff decide), and the courier name and tracking link for courier orders.
--
-- Only additions. Nothing existing is removed or rewritten; existing rows keep working.

BEGIN;

-- Subscription rules: the lengths (number of deliveries) a customer may choose, set by staff. Existing rules get 15 and 30.
ALTER TABLE subscription_rules
  ADD COLUMN length_options integer[] NOT NULL DEFAULT '{15,30}'
    CHECK (cardinality(length_options) BETWEEN 1 AND 6 AND 1 <= ALL (length_options) AND 365 >= ALL (length_options));

CREATE SEQUENCE subscription_number_seq START 1001;

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What customers and staff read out: SUB-1001, SUB-1002, ...
  subscription_number text NOT NULL UNIQUE DEFAULT ('SUB-' || nextval('subscription_number_seq')),
  customer_id uuid NOT NULL REFERENCES customers (id),
  kind text NOT NULL CHECK (kind IN ('subscription', 'trial')),
  -- The product and size, with the name and price frozen at the moment of subscribing (the customer pays that price).
  product_id uuid NOT NULL REFERENCES products (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  product_name text NOT NULL CHECK (length(product_name) BETWEEN 1 AND 160),
  product_name_gu text NOT NULL DEFAULT '' CHECK (length(product_name_gu) <= 160),
  variant_name text NOT NULL CHECK (length(variant_name) BETWEEN 1 AND 80),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  -- Copied onto each delivery's order, so production planning counts subscription deliveries.
  include_in_production_planning boolean NOT NULL DEFAULT false,
  production_unit text NOT NULL DEFAULT '' CHECK (length(production_unit) <= 40),
  production_quantity numeric NOT NULL DEFAULT 0 CHECK (production_quantity >= 0),
  -- The schedule. A subscription uses one of the product's subscription rules; a trial uses one of its trial plans (daily).
  subscription_rule_id uuid REFERENCES subscription_rules (id),
  trial_plan_id uuid REFERENCES trial_plans (id),
  plan_name text NOT NULL DEFAULT '' CHECK (length(plan_name) <= 80),
  schedule_type text NOT NULL CHECK (schedule_type IN ('daily', 'alternate_days', 'custom_weekdays')),
  -- For custom weekdays: 1 = Monday ... 7 = Sunday.
  weekdays smallint[] NOT NULL DEFAULT '{}' CHECK (1 <= ALL (weekdays) AND 7 >= ALL (weekdays)),
  -- How many deliveries each chosen slot gets.
  deliveries_per_line integer NOT NULL CHECK (deliveries_per_line BETWEEN 1 AND 365),
  start_date date NOT NULL,
  -- Where it goes, frozen like an order's address.
  recipient_name text NOT NULL CHECK (length(recipient_name) BETWEEN 1 AND 120),
  recipient_phone text NOT NULL CHECK (length(recipient_phone) BETWEEN 6 AND 20),
  address_line1 text NOT NULL CHECK (length(address_line1) BETWEEN 1 AND 200),
  address_line2 text NOT NULL DEFAULT '' CHECK (length(address_line2) <= 200),
  landmark text NOT NULL DEFAULT '' CHECK (length(landmark) <= 120),
  city text NOT NULL DEFAULT '' CHECK (length(city) <= 80),
  pin_code text NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  doorstep_note text NOT NULL DEFAULT '' CHECK (length(doorstep_note) <= 300),
  -- Money. Online: paid upfront through the payment below. Credit: each delivery is charged when its order is created.
  payment_method text NOT NULL CHECK (payment_method IN ('credit', 'online')),
  payment_id uuid REFERENCES payments (id),
  total_paise bigint NOT NULL CHECK (total_paise >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  cancelled_at timestamptz,
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 300),
  -- The customer's "Subscribe" press: a repeat finds the same subscription.
  idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'subscription' AND subscription_rule_id IS NOT NULL) OR (kind = 'trial' AND trial_plan_id IS NOT NULL)),
  CHECK (schedule_type <> 'custom_weekdays' OR cardinality(weekdays) >= 1),
  CHECK (payment_method = 'credit' OR payment_id IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
CREATE UNIQUE INDEX subscriptions_customer_idempotency_idx ON subscriptions (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX subscriptions_customer_idx ON subscriptions (customer_id, created_at DESC);
-- One trial per customer per product, even if two trial payments complete at the same time (the second is then refunded).
CREATE UNIQUE INDEX subscriptions_one_trial_idx ON subscriptions (customer_id, product_id) WHERE kind = 'trial';
CREATE INDEX subscriptions_active_idx ON subscriptions (status) WHERE status = 'active';

-- One line per chosen slot, with its own quantity (for example Morning 1, Evening 2).
CREATE TABLE subscription_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  delivery_slot_id uuid NOT NULL REFERENCES delivery_slots (id),
  slot_name text NOT NULL CHECK (length(slot_name) BETWEEN 1 AND 80),
  slot_start_time time NOT NULL,
  slot_end_time time NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  UNIQUE (subscription_id, delivery_slot_id)
);

-- Pauses and vacations: no deliveries from `from_date`; an open pause (no until_date) lasts until the customer resumes.
CREATE TABLE subscription_pauses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  from_date date NOT NULL,
  until_date date,
  created_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (until_date IS NULL OR until_date >= from_date)
);
CREATE INDEX subscription_pauses_idx ON subscription_pauses (subscription_id, from_date);

-- One slot on one day that will not be delivered: the customer or staff skipped it, its order was cancelled, the credit
-- limit was reached, or the product could no longer be delivered there. Each one moves that slot's end date one delivery later.
CREATE TABLE subscription_skips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  subscription_line_id uuid NOT NULL REFERENCES subscription_lines (id),
  delivery_date date NOT NULL,
  reason text NOT NULL CHECK (reason IN ('customer', 'admin', 'order_cancelled', 'credit_limit', 'not_deliverable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_line_id, delivery_date)
);
CREATE INDEX subscription_skips_subscription_idx ON subscription_skips (subscription_id, delivery_date);
CREATE INDEX subscription_skips_alert_idx ON subscription_skips (created_at) WHERE reason IN ('credit_limit', 'not_deliverable');

-- What happened to a subscription, for staff: started, paused, resumed, skipped, cancelled, credit limit reached. Append-only.
CREATE TABLE subscription_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX subscription_activity_idx ON subscription_activity (subscription_id, created_at);

-- Orders: which subscription delivery an order is; when staff returned its money; and the courier for courier orders.
ALTER TABLE orders
  ADD COLUMN subscription_id uuid REFERENCES subscriptions (id),
  ADD COLUMN subscription_line_id uuid REFERENCES subscription_lines (id),
  ADD COLUMN money_returned_at timestamptz,
  ADD COLUMN courier_name text CHECK (courier_name IS NULL OR length(courier_name) <= 80),
  ADD COLUMN tracking_url text CHECK (tracking_url IS NULL OR (length(tracking_url) <= 500 AND tracking_url ~ '^https?://'));
CREATE INDEX orders_subscription_idx ON orders (subscription_line_id, delivery_date) WHERE subscription_line_id IS NOT NULL;

-- Payments: a subscription paid upfront is a new purpose.
ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('order', 'credit_settlement', 'subscription'));

-- The backend's user.
GRANT SELECT, INSERT, UPDATE ON subscriptions, subscription_lines TO shreeram_app;
-- A pause that has not started yet is removed when the customer resumes before it.
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_pauses TO shreeram_app;
-- A customer can undo a skip they made, so skips can be removed (only the customer's own, enforced in code).
GRANT SELECT, INSERT, DELETE ON subscription_skips TO shreeram_app;
GRANT SELECT, INSERT ON subscription_activity TO shreeram_app;
GRANT USAGE, SELECT ON SEQUENCE subscription_number_seq TO shreeram_app;

COMMIT;
`