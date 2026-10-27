-- Adds the "order cancelled" message: sent to the customer when staff cancel a one-time order (a cancelled subscription or trial day
-- already has its own "delivery skipped" message). Safe to run more than once. Until it is run, the app simply does not send this one
-- message; nothing else is affected.
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
  CHECK (event_key IN ('order_placed', 'order_cancelled', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent'));
ALTER TABLE notifications ADD CONSTRAINT notifications_event_key_check
  CHECK (event_key IN ('order_placed', 'order_cancelled', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'broadcast'));

INSERT INTO notification_templates (event_key, title, title_gu, body, body_gu) VALUES
  ('order_cancelled', 'Order cancelled', 'ઓર્ડર રદ થયો',
   'Your order {{order}} was cancelled by our team. Please contact support if you have any questions.',
   'તમારો ઓર્ડર {{order}} અમારી ટીમે રદ કર્યો છે. કોઈ પ્રશ્ન હોય તો કૃપા કરીને સપોર્ટનો સંપર્ક કરો.')
ON CONFLICT (event_key) DO NOTHING;
