-- 0016: online payments through PhonePe.
--
-- Payment first, order after: when a customer pays online, a pending payment row is written before PhonePe is asked for
-- anything. The orders (or the settled payment request) are created only once PhonePe confirms the payment, from the
-- snapshot frozen on that row. Confirming the same payment twice can never create anything twice: the pending row is
-- locked and moved out of 'pending' in the same step that creates the orders.
--
-- Nothing is removed or rewritten: existing rows keep their values, and every new column has a safe default.

BEGIN;

ALTER TABLE payments
  -- The customer's "Place order" or "Pay now" press. A repeated press (a network retry) finds the same payment instead of starting a second one.
  ADD COLUMN idempotency_key text CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 120),
  -- For paying a payment request online: which request this payment settles.
  ADD COLUMN payment_request_id uuid REFERENCES payment_requests (id),
  -- PhonePe's own ids: its order id (returned when the payment is created) and the transaction id of the attempt that paid.
  ADD COLUMN provider_order_id text CHECK (provider_order_id IS NULL OR length(provider_order_id) <= 100),
  ADD COLUMN provider_transaction_id text CHECK (provider_transaction_id IS NULL OR length(provider_transaction_id) <= 100),
  -- When PhonePe stops accepting this payment.
  ADD COLUMN expires_at timestamptz,
  -- Why a payment failed (PhonePe's error code), shown to staff.
  ADD COLUMN failure_reason text NOT NULL DEFAULT '' CHECK (length(failure_reason) <= 300),
  -- For a paid online payment: whether what it paid for was delivered (orders created / request settled) or must be refunded.
  ADD COLUMN fulfilment text NOT NULL DEFAULT 'none' CHECK (fulfilment IN ('none', 'fulfilled', 'refund_due')),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- One payment per press, per customer.
CREATE UNIQUE INDEX payments_customer_idempotency_idx ON payments (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- The background check reads only payments still waiting for PhonePe.
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'pending';
-- A PhonePe payment always carries our own reference for it (the merchant order id sent to PhonePe).
ALTER TABLE payments ADD CONSTRAINT payments_phonepe_reference_check CHECK (method <> 'phonepe' OR provider_reference IS NOT NULL);

-- What happened to each online payment, step by step, for staff: started, PhonePe order created, checked, paid, failed,
-- delivered, refund due. Append-only.
CREATE TABLE payment_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments (id),
  kind text NOT NULL CHECK (kind IN ('started', 'provider_order_created', 'provider_error', 'status_checked', 'webhook_received', 'paid', 'failed', 'fulfilled', 'refund_due')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_activity_payment_idx ON payment_activity (payment_id, created_at);

-- A webhook names the payment it is about.
ALTER TABLE payment_events ADD COLUMN payment_id uuid REFERENCES payments (id);

-- A refund owed for a payment that has no order (paid, but the order could not be placed) points at the payment directly.
ALTER TABLE prepaid_adjustments ADD COLUMN payment_id uuid REFERENCES payments (id);

-- The backend's user: the activity log is read and add only. (payments, payment_events and prepaid_adjustments
-- already have the permissions they need from 0015; new columns are covered by them.)
GRANT SELECT, INSERT ON payment_activity TO shreeram_app;

COMMIT;
