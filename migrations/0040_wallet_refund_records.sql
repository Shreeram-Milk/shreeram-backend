-- 0040: a clear, permanent record of every wallet refund. Run as the migration user (shreeram_migrate), in one go, in pgAdmin.
-- Wrapped in BEGIN/COMMIT: either everything is added or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
--
-- What it adds (nothing is deleted; no existing row is changed):
--   * refunds.wallet_refund_request_id : each PhonePe refund staff send for a wallet refund request is saved as its own line in
--     the existing `refunds` table, pointing at the PhonePe payment it was sent against AND at the customer's request.
--     So for every customer we can show: what they paid in, what they asked back, and which payment each rupee went back to.
--   * wallet_refund_requests.completed_at : when the money reached the customer's bank. Empty for now; filled automatically
--     later, when the live PhonePe keys and refund webhook are switched on.

BEGIN;

ALTER TABLE refunds ADD COLUMN wallet_refund_request_id uuid REFERENCES wallet_refund_requests (id);
CREATE INDEX refunds_wallet_refund_request_idx ON refunds (wallet_refund_request_id) WHERE wallet_refund_request_id IS NOT NULL;

ALTER TABLE wallet_refund_requests ADD COLUMN completed_at timestamptz;
ALTER TABLE wallet_refund_requests ADD CONSTRAINT wallet_refund_requests_completed_after_sent CHECK (completed_at IS NULL OR status = 'sent');

-- Permissions are unchanged: the app could already read and add refund lines, and read, add and update refund requests.

COMMIT;
