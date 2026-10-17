-- 0015: orders, payments and credit — what customers buy, what they pay, and what credit customers owe.
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
-- It creates new tables and adds three new columns (one on products, two on customers). It changes and deletes nothing that exists.
--
-- Rules this design keeps (so no screen or bug can break them):
--   * Money is whole paise (Rs 125.50 = 12550). Totals must add up, checked by the database.
--   * An order keeps a SNAPSHOT of the product names, prices, address, slot and production figures as they were when it was placed,
--     so editing a product later never changes an old order.
--   * Orders, payments, refunds and the credit ledger are never deleted. The ledger and the status history are append-only:
--     the application user can add rows but never change or remove them.
--   * One customer asking twice (a double tap, a retry) cannot create two orders: the same idempotency key is refused by a unique index.
--   * A payment provider's event is recorded once: a repeated webhook cannot be applied twice.
--   * Production planning counts quantities from ORDER ITEMS (grouped by delivery date and slot), using the production figures snapshotted on each item.

BEGIN;

-- ============================================================================================
-- Credit settings
-- ============================================================================================
-- A credit customer can order any product, up to this limit, except products marked "not available on credit".
ALTER TABLE customers ADD COLUMN credit_limit_paise bigint NOT NULL DEFAULT 0 CHECK (credit_limit_paise >= 0);
-- A product marked here cannot be bought on credit: it must be paid for at the time of ordering.
ALTER TABLE products ADD COLUMN excluded_from_credit boolean NOT NULL DEFAULT false;
-- Which products are marked, for the admin product list.
CREATE INDEX products_excluded_from_credit_idx ON products (excluded_from_credit) WHERE excluded_from_credit;

-- Order numbers customers and staff can read out: SRM-1001, SRM-1002, ...
CREATE SEQUENCE order_number_seq START 1001;

-- ============================================================================================
-- Payments: money coming in. Created before an order when the customer pays online (the order appears only after payment is confirmed),
-- and for money staff record by hand (cash or UPI received from a credit customer).
-- ============================================================================================
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  -- 'order' = paying for an order; 'credit_settlement' = a credit customer paying off what they owe.
  purpose text NOT NULL CHECK (purpose IN ('order', 'credit_settlement')),
  method text NOT NULL CHECK (method IN ('phonepe', 'cash', 'upi', 'bank_transfer', 'other')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
  -- The payment provider's own reference for this payment. Unique, so the same payment is never recorded twice.
  provider_reference text,
  -- What the customer was buying when they started paying online: the checked cart, address, slot and totals.
  -- The order is created from this snapshot once the provider confirms the payment.
  checkout_snapshot jsonb,
  -- Set when an order was created from this payment.
  order_id uuid,
  -- For manual payments: who recorded it and a short note (for example "cash handed over on delivery").
  recorded_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CHECK (status NOT IN ('paid', 'refunded', 'partially_refunded') OR paid_at IS NOT NULL),
  CHECK (method = 'phonepe' OR recorded_by IS NOT NULL)
);
CREATE UNIQUE INDEX payments_provider_reference_unique_idx ON payments (provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payments_customer_idx ON payments (customer_id, created_at DESC);
CREATE INDEX payments_status_idx ON payments (status, created_at DESC);

-- A payment provider's event (for example a webhook). Recorded once by the provider's own event id, so a repeat is ignored.
CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('phonepe')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL DEFAULT '' CHECK (length(event_type) <= 100),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, provider_event_id)
);

-- ============================================================================================
-- Orders. One order per delivery setup: a cart with milk (own delivery) and ghee (courier) becomes two orders.
-- ============================================================================================
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE DEFAULT ('SRM-' || nextval('order_number_seq')),
  customer_id uuid NOT NULL REFERENCES customers (id),
  -- The phone sends a fresh key for each "Place order" press. The same key twice returns the same order, never a second one.
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  status text NOT NULL DEFAULT 'placed' CHECK (status IN ('placed', 'out_for_delivery', 'delivered', 'missed', 'cancelled')),

  -- How and where it goes, as decided by the server when the order was placed.
  delivery_method text NOT NULL CHECK (delivery_method IN ('local_delivery', 'shipping')),
  service_area_id uuid NOT NULL REFERENCES service_areas (id),
  delivery_date date NOT NULL,
  -- Own delivery has a slot; courier shipping does not.
  delivery_slot_id uuid REFERENCES delivery_slots (id),
  slot_name text NOT NULL DEFAULT '' CHECK (length(slot_name) <= 80),
  slot_start_time time,
  slot_end_time time,
  -- The last moment this order could have been placed for that delivery (from the cut-off rule); null when there is no cut-off.
  order_by timestamptz,

  -- The delivery address as it was when ordering. Blank after the customer deletes their account.
  recipient_name text NOT NULL DEFAULT '' CHECK (length(recipient_name) <= 100),
  recipient_phone text NOT NULL DEFAULT '' CHECK (length(recipient_phone) <= 20),
  address_line1 text NOT NULL DEFAULT '' CHECK (length(address_line1) <= 200),
  address_line2 text NOT NULL DEFAULT '' CHECK (length(address_line2) <= 200),
  landmark text NOT NULL DEFAULT '' CHECK (length(landmark) <= 200),
  city text NOT NULL DEFAULT '' CHECK (length(city) <= 100),
  pin_code text NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  doorstep_note text NOT NULL DEFAULT '' CHECK (length(doorstep_note) <= 300),

  -- Money, all calculated by the server.
  subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise bigint NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  total_paise bigint NOT NULL CHECK (total_paise >= 0),
  -- 'credit' = added to what the customer owes; 'online' = paid through the payment provider.
  payment_method text NOT NULL CHECK (payment_method IN ('credit', 'online')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid', 'partially_refunded', 'refunded')),
  payment_id uuid REFERENCES payments (id),

  cancelled_at timestamptz,
  cancelled_by text CHECK (cancelled_by IN ('customer', 'admin')),
  cancel_reason text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 300),
  placed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CHECK (total_paise = subtotal_paise - discount_paise),
  CHECK (discount_paise <= subtotal_paise),
  -- Own delivery needs a slot; courier shipping has none.
  CHECK ((delivery_method = 'local_delivery' AND delivery_slot_id IS NOT NULL) OR (delivery_method = 'shipping' AND delivery_slot_id IS NULL)),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  -- An online order exists only after the payment was confirmed; a credit order is never marked paid by the payment provider.
  CHECK (payment_method <> 'online' OR payment_id IS NOT NULL)
);
CREATE UNIQUE INDEX orders_customer_idempotency_unique_idx ON orders (customer_id, idempotency_key);
CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_status_idx ON orders (status, placed_at DESC);
-- The delivery board and production planning ask "orders for this date and slot".
CREATE INDEX orders_delivery_idx ON orders (delivery_date, delivery_slot_id, status);

ALTER TABLE payments ADD CONSTRAINT payments_order_fk FOREIGN KEY (order_id) REFERENCES orders (id);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  product_id uuid NOT NULL REFERENCES products (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  -- Names and prices exactly as they were when ordering.
  product_name text NOT NULL CHECK (length(product_name) BETWEEN 1 AND 100),
  product_name_gu text NOT NULL DEFAULT '' CHECK (length(product_name_gu) <= 80),
  variant_name text NOT NULL CHECK (length(variant_name) BETWEEN 1 AND 60),
  purchase_method text NOT NULL DEFAULT 'buy_once' CHECK (purchase_method IN ('buy_once', 'trial', 'subscription')),
  unit_price_paise bigint NOT NULL CHECK (unit_price_paise >= 0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  line_total_paise bigint NOT NULL CHECK (line_total_paise >= 0),
  -- Production planning figures, snapshotted: does this product count, and how much of the production unit one piece needs
  -- (for example a 500 ml bottle = 0.5 Litre). Needed quantity = quantity x production_quantity.
  include_in_production_planning boolean NOT NULL DEFAULT false,
  production_unit text NOT NULL DEFAULT '' CHECK (length(production_unit) <= 20),
  production_quantity numeric(12, 3) NOT NULL DEFAULT 0 CHECK (production_quantity >= 0),
  CHECK (line_total_paise = unit_price_paise * quantity)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id, variant_id);

-- Every change of an order's status, who made it and when. Append-only.
CREATE TABLE order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id),
  from_status text CHECK (from_status IN ('placed', 'out_for_delivery', 'delivered', 'missed', 'cancelled')),
  to_status text NOT NULL CHECK (to_status IN ('placed', 'out_for_delivery', 'delivered', 'missed', 'cancelled')),
  changed_by_admin uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  changed_by_customer boolean NOT NULL DEFAULT false,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

-- ============================================================================================
-- Credit ledger: what a credit customer owes. Append-only; a mistake is fixed with a new "adjustment" row.
-- Owed = sum of debits minus sum of credits.
-- ============================================================================================
CREATE TABLE credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  entry_type text NOT NULL CHECK (entry_type IN ('order_charge', 'payment_received', 'order_refund', 'manual_adjustment', 'opening_balance')),
  -- 'debit' increases what the customer owes; 'credit' reduces it.
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  order_id uuid REFERENCES orders (id),
  payment_id uuid REFERENCES payments (id),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  created_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  -- The date this belongs to in statements (India date), which can differ from when the row was written.
  occurred_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- An order charge always points at its order; a received payment at its payment.
  CHECK (entry_type <> 'order_charge' OR (order_id IS NOT NULL AND direction = 'debit')),
  CHECK (entry_type <> 'payment_received' OR (payment_id IS NOT NULL AND direction = 'credit'))
);
CREATE INDEX credit_ledger_customer_idx ON credit_ledger_entries (customer_id, created_at);
-- An order is charged to credit once, and a payment is credited once, even if the request is repeated.
CREATE UNIQUE INDEX credit_ledger_order_charge_unique_idx ON credit_ledger_entries (order_id) WHERE entry_type = 'order_charge';
CREATE UNIQUE INDEX credit_ledger_payment_unique_idx ON credit_ledger_entries (payment_id) WHERE entry_type = 'payment_received';

-- ============================================================================================
-- Payment requests: staff ask a credit customer to pay an amount; the customer sees "Pay now" in the app until it is paid or cancelled.
-- ============================================================================================
CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled')),
  created_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  payment_id uuid REFERENCES payments (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (status = 'open' OR closed_at IS NOT NULL)
);
CREATE INDEX payment_requests_customer_idx ON payment_requests (customer_id, status);

-- ============================================================================================
-- Refunds: the admin refunds in the payment provider's dashboard and records it here. The system never sends a refund by itself.
-- ============================================================================================
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments (id),
  order_id uuid REFERENCES orders (id),
  customer_id uuid NOT NULL REFERENCES customers (id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  provider_reference text NOT NULL DEFAULT '' CHECK (length(provider_reference) <= 100),
  recorded_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);

-- ============================================================================================
-- Prepaid adjustments: what the business owes a PREPAID customer for a paid delivery that was skipped or cancelled
-- (carried forward, account credit, a refund to send, or a manual correction). The subscription and delivery ids are filled
-- in when subscriptions arrive in a later step, so they are plain ids for now.
-- ============================================================================================
CREATE TABLE prepaid_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  order_id uuid REFERENCES orders (id),
  subscription_id uuid,
  delivery_id uuid,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('carry_forward', 'account_credit', 'refund_pending', 'manual_adjustment')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled')),
  -- Money value in paise; null for a pure carry-forward of a paid delivery.
  amount_paise bigint CHECK (amount_paise IS NULL OR amount_paise > 0),
  -- A paid delivery owed, in the unit the customer bought (not production litres).
  product_id uuid REFERENCES products (id),
  variant_id uuid REFERENCES product_variants (id),
  quantity integer CHECK (quantity IS NULL OR quantity > 0),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 300),
  effective_date date NOT NULL,
  -- One adjustment per business event: a repeated event cannot create a second one.
  dedupe_key text NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  created_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_paise IS NOT NULL OR (product_id IS NOT NULL AND variant_id IS NOT NULL AND quantity IS NOT NULL))
);
CREATE INDEX prepaid_adjustments_customer_idx ON prepaid_adjustments (customer_id, status);

-- ============================================================================================
-- Permissions for the backend's database user.
--   Orders, payments, payment requests, prepaid adjustments: read, add, edit (never delete).
--   Order items, the status history, the credit ledger, refunds and payment events: read and add only (append-only).
-- ============================================================================================
GRANT SELECT, INSERT, UPDATE ON orders, payments, payment_requests, prepaid_adjustments TO shreeram_app;
GRANT SELECT, INSERT ON order_items, order_status_history, credit_ledger_entries, refunds, payment_events TO shreeram_app;
-- payment events record when they were processed.
GRANT UPDATE (processed_at) ON payment_events TO shreeram_app;
GRANT USAGE, SELECT ON SEQUENCE order_number_seq TO shreeram_app;

COMMIT;
