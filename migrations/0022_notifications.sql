-- 0022: notifications (Bundle D).
--
--   * push_tokens: the phone's notification address for each customer (one customer can have several phones).
--   * notification_templates: the wording of each automatic message. The events are fixed by the system; staff edit the
--     wording in English and Gujarati and can switch a message off.
--   * notifications: every message a customer was sent. This is what the app's bell and notification list show, so a message
--     is never lost even if the customer had notifications turned off. The same event for the same thing is stored once
--     (dedupe_key), so repeating a button or the delivery job can never send a message twice.
--   * broadcasts: a one-off message to a group of customers (everyone, a group by filter, or chosen customers).
--
-- Only additions. Nothing existing is removed or rewritten. Safe to run once in pgAdmin as postgres.

BEGIN;

CREATE TABLE push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  token text NOT NULL UNIQUE CHECK (length(token) BETWEEN 20 AND 4096),
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_customer_idx ON push_tokens (customer_id) WHERE active;

CREATE TABLE notification_templates (
  event_key text PRIMARY KEY CHECK (event_key IN ('out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  title_gu text NOT NULL DEFAULT '' CHECK (length(title_gu) <= 60),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 240),
  body_gu text NOT NULL DEFAULT '' CHECK (length(body_gu) <= 240),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id)
);

INSERT INTO notification_templates (event_key, title, title_gu, body, body_gu) VALUES
  ('out_for_delivery', 'On its way', 'ડિલિવરી માટે નીકળી',
   'Your order {{order}} is out for delivery.',
   'તમારો ઓર્ડર {{order}} ડિલિવરી માટે નીકળી ગયો છે.'),
  ('delivered', 'Delivered', 'ડિલિવર થઈ ગયો',
   'Your order {{order}} has been delivered. Enjoy!',
   'તમારો ઓર્ડર {{order}} ડિલિવર થઈ ગયો છે. આનંદ માણો!'),
  ('day_skipped', 'Delivery skipped', 'ડિલિવરી છોડાઈ',
   'Your {{product}} delivery on {{date}} ({{window}}) was skipped by our team. It is added at the end of your plan.',
   '{{date}} ({{window}}) ની તમારી {{product}} ડિલિવરી અમારી ટીમે છોડી છે. તે તમારા પ્લાનના અંતે ઉમેરાઈ છે.'),
  ('credit_limit_reached', 'Credit limit reached', 'ક્રેડિટ મર્યાદા પૂરી',
   'Your {{product}} delivery on {{date}} was skipped because your credit limit is used up. Please pay to continue.',
   'તમારી ક્રેડિટ મર્યાદા પૂરી થઈ હોવાથી {{date}} ની {{product}} ડિલિવરી છોડાઈ છે. ચાલુ રાખવા માટે કૃપા કરીને ચુકવણી કરો.'),
  ('payment_requested', 'Payment requested', 'ચુકવણીની વિનંતી',
   'Please pay {{amount}} to clear your balance. Open the app and tap Pay.',
   'તમારું બાકી {{amount}} ચૂકવવા વિનંતી છે. એપ ખોલીને Pay દબાવો.'),
  ('refund_sent', 'Refund sent', 'રિફંડ મોકલાયું',
   'Your refund of {{amount}} has been sent. It may take a few days to reach your account.',
   'તમારું {{amount}} નું રિફંડ મોકલવામાં આવ્યું છે. તમારા ખાતામાં આવતા થોડા દિવસ લાગી શકે છે.');

CREATE TABLE broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  title_gu text NOT NULL DEFAULT '' CHECK (length(title_gu) <= 60),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 240),
  body_gu text NOT NULL DEFAULT '' CHECK (length(body_gu) <= 240),
  -- Who it was sent to, exactly as chosen: {"type":"all"}, {"type":"filter",...} or {"type":"customers","customerIds":[...]}.
  audience jsonb NOT NULL,
  recipients integer NOT NULL DEFAULT 0,
  pushed integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  created_by uuid REFERENCES admin_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX broadcasts_created_idx ON broadcasts (created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  event_key text NOT NULL CHECK (event_key IN ('out_for_delivery', 'delivered', 'day_skipped', 'credit_limit_reached', 'payment_requested', 'refund_sent', 'broadcast')),
  title text NOT NULL,
  title_gu text NOT NULL DEFAULT '',
  body text NOT NULL,
  body_gu text NOT NULL DEFAULT '',
  -- A screen of the app to open when the customer taps the message, such as /order-tracking?orderId=... (null: the list).
  link text,
  broadcast_id uuid REFERENCES broadcasts (id),
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_customer_idx ON notifications (customer_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (customer_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_broadcast_idx ON notifications (broadcast_id) WHERE broadcast_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON push_tokens TO shreeram_app;
GRANT SELECT, UPDATE ON notification_templates TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON broadcasts TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON notifications TO shreeram_app;

COMMIT;
