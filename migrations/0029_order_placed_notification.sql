-- Adds the "order placed" message: sent to the customer when an order is placed (credit, or paid online and confirmed).
-- Safe to run more than once. Until it is run, the app simply does not send this one message; nothing else is affected.
DO $$
DECLARE
  found record;
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
  CHECK (event_key IN ('order_placed', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent'));
ALTER TABLE notifications ADD CONSTRAINT notifications_event_key_check
  CHECK (event_key IN ('order_placed', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'broadcast'));

INSERT INTO notification_templates (event_key, title, title_gu, body, body_gu) VALUES
  ('order_placed', 'Order placed', 'ઓર્ડર થઈ ગયો',
   'Thank you! Your order {{order}} is placed.',
   'આભાર! તમારો ઓર્ડર {{order}} થઈ ગયો છે.')
ON CONFLICT (event_key) DO NOTHING;
