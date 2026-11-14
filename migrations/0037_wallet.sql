-- 0037: the ShreeRam wallet. Run as the migration user (shreeram_migrate), in one go, in pgAdmin.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
--
-- What it adds (nothing existing is deleted; no existing row is changed):
--   * wallet_refund_requests : a customer asks for their wallet money back. Staff refund it in PhonePe and record the reference.
--   * wallet_entries         : every rupee that goes into or out of a wallet, one permanent line each. The balance is the sum.
--                              The app can only ADD lines (no edit, no delete), and the database refuses any line that would
--                              take a balance below zero.
--   * payments may now be a 'wallet_topup' (adding money with PhonePe).
--   * orders may now be paid with 'wallet'.
--
-- Until the new app and server are live, nothing uses these tables, so running this early is safe.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Refund requests (created first: wallet_entries points at them).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE wallet_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  -- requested: waiting for staff · sent: refunded in PhonePe · cancelled: not refunded, the money went back into the wallet
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'sent', 'cancelled')),
  customer_note text NOT NULL DEFAULT '' CHECK (length(customer_note) <= 300),
  provider_reference text NOT NULL DEFAULT '' CHECK (length(provider_reference) <= 100),
  staff_note text NOT NULL DEFAULT '' CHECK (length(staff_note) <= 300),
  -- A repeated press of "Request refund" finds the same request instead of making a second one.
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 80),
  handled_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  UNIQUE (customer_id, idempotency_key),
  CHECK (status = 'requested' OR handled_at IS NOT NULL),
  CHECK (status <> 'sent' OR length(trim(provider_reference)) > 0)
);
-- At most one open request per customer.
CREATE UNIQUE INDEX wallet_refund_requests_one_open_idx ON wallet_refund_requests (customer_id) WHERE status = 'requested';
CREATE INDEX wallet_refund_requests_status_idx ON wallet_refund_requests (status, requested_at);

-- ---------------------------------------------------------------------------------------------
-- 2. The wallet ledger.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE wallet_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  -- top_up: added with PhonePe · order_payment: an order paid from the wallet · order_return: an order's money put back
  -- refund_hold: set aside for a refund request · refund_release: a cancelled request put back · manual_adjustment: staff correction
  entry_type text NOT NULL CHECK (entry_type IN ('top_up', 'order_payment', 'order_return', 'refund_hold', 'refund_release', 'manual_adjustment')),
  -- 'credit' adds to the balance, 'debit' takes from it.
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  payment_id uuid REFERENCES payments (id),
  order_id uuid REFERENCES orders (id),
  refund_request_id uuid REFERENCES wallet_refund_requests (id),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  created_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Each kind of line has a fixed direction and points at what caused it.
  CHECK (entry_type <> 'top_up' OR (direction = 'credit' AND payment_id IS NOT NULL)),
  CHECK (entry_type <> 'order_payment' OR (direction = 'debit' AND order_id IS NOT NULL)),
  CHECK (entry_type <> 'order_return' OR (direction = 'credit' AND order_id IS NOT NULL)),
  CHECK (entry_type <> 'refund_hold' OR (direction = 'debit' AND refund_request_id IS NOT NULL)),
  CHECK (entry_type <> 'refund_release' OR (direction = 'credit' AND refund_request_id IS NOT NULL)),
  CHECK (entry_type <> 'manual_adjustment' OR (created_by IS NOT NULL AND length(trim(description)) > 0))
);
CREATE INDEX wallet_entries_customer_idx ON wallet_entries (customer_id, created_at DESC);
-- Never twice: one line per top-up payment, per order paid, per order returned, per refund held or released.
CREATE UNIQUE INDEX wallet_entries_top_up_once_idx ON wallet_entries (payment_id) WHERE entry_type = 'top_up';
CREATE UNIQUE INDEX wallet_entries_order_payment_once_idx ON wallet_entries (order_id) WHERE entry_type = 'order_payment';
CREATE UNIQUE INDEX wallet_entries_order_return_once_idx ON wallet_entries (order_id) WHERE entry_type = 'order_return';
CREATE UNIQUE INDEX wallet_entries_refund_hold_once_idx ON wallet_entries (refund_request_id) WHERE entry_type = 'refund_hold';
CREATE UNIQUE INDEX wallet_entries_refund_release_once_idx ON wallet_entries (refund_request_id) WHERE entry_type = 'refund_release';

-- The database itself refuses a line that would take a wallet below zero, even if the server had a bug.
CREATE FUNCTION wallet_balance_not_negative() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT coalesce(sum(CASE WHEN direction = 'credit' THEN amount_paise ELSE -amount_paise END), 0)
      FROM wallet_entries WHERE customer_id = NEW.customer_id) < 0 THEN
    RAISE EXCEPTION 'WALLET_BALANCE_NEGATIVE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_entries_balance_check AFTER INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION wallet_balance_not_negative();

-- ---------------------------------------------------------------------------------------------
-- 3. Allow the new kinds of payment. The old allowed values all stay.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  found record;
BEGIN
  FOR found IN
    SELECT t.relname AS table_name, c.conname AS constraint_name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'c'
      AND ((t.relname = 'payments' AND pg_get_constraintdef(c.oid) LIKE '%purpose%' AND pg_get_constraintdef(c.oid) LIKE '%credit_settlement%')
        OR (t.relname = 'orders' AND pg_get_constraintdef(c.oid) LIKE '%payment_method%' AND pg_get_constraintdef(c.oid) NOT LIKE '%payment_id%'))
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', found.table_name, found.constraint_name);
  END LOOP;
END $$;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('order', 'credit_settlement', 'subscription', 'wallet_topup'));
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('credit', 'online', 'wallet'));

-- ---------------------------------------------------------------------------------------------
-- 4. Permissions. The ledger can only be read and added to: no UPDATE, no DELETE.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON wallet_entries TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON wallet_refund_requests TO shreeram_app;

COMMIT;
