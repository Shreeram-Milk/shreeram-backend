-- The rider app (one rider: the owner). Safe to run more than once.
--   rider_sessions : sign-ins of the rider app. Kept apart from admin_sessions on purpose, so a rider sign-in can never open the admin panel.
--   rider_checkins : "the rider reached this PIN code in this delivery window". One row per PIN, window and day, so the customers
--                    are told "arriving soon" once, however many times the button is pressed.
--   a new automatic message, "Rider arriving", with its English and Gujarati wording (staff can edit it like the others).
-- Until this is run, the rider app cannot sign in; nothing else is affected.

CREATE TABLE IF NOT EXISTS rider_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  ip_address inet
);
CREATE INDEX IF NOT EXISTS rider_sessions_user_idx ON rider_sessions (admin_user_id);

CREATE TABLE IF NOT EXISTS rider_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users (id),
  delivery_date date NOT NULL,
  delivery_slot_id uuid NOT NULL REFERENCES delivery_slots (id),
  pin_code text NOT NULL,
  customers_notified integer NOT NULL DEFAULT 0 CHECK (customers_notified >= 0),
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_date, delivery_slot_id, pin_code)
);
CREATE INDEX IF NOT EXISTS rider_checkins_day_idx ON rider_checkins (delivery_date, delivery_slot_id);

GRANT SELECT, INSERT, UPDATE ON rider_sessions TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON rider_checkins TO shreeram_app;

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
  CHECK (event_key IN ('order_placed', 'order_cancelled', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'rider_arriving'));
ALTER TABLE notifications ADD CONSTRAINT notifications_event_key_check
  CHECK (event_key IN ('order_placed', 'order_cancelled', 'out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'rider_arriving', 'broadcast'));

INSERT INTO notification_templates (event_key, title, title_gu, body, body_gu) VALUES
  ('rider_arriving', 'Your delivery is arriving soon', 'તમારી ડિલિવરી થોડી વારમાં આવી રહી છે',
   'Our rider has reached your area. Your order {{order}} will arrive in about 15-20 minutes.',
   'અમારા રાઇડર તમારા વિસ્તારમાં પહોંચી ગયા છે. તમારો ઓર્ડર {{order}} લગભગ 15-20 મિનિટમાં પહોંચશે.')
ON CONFLICT (event_key) DO NOTHING;
