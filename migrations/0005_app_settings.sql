-- 0005: app settings (support details, feature switches, app availability).
-- Run as the migration user (shreeram_migrate). Safe to run once; it does not touch any existing table.

-- ONE row for the whole business. `id` can only ever be true, so a second row is impossible.
CREATE TABLE app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),

  -- Support contact
  support_phone text NOT NULL DEFAULT '' CHECK (length(support_phone) <= 20),
  support_email text NOT NULL DEFAULT '' CHECK (length(support_email) <= 120),
  support_whatsapp text NOT NULL DEFAULT '' CHECK (length(support_whatsapp) <= 20),
  call_enabled boolean NOT NULL DEFAULT false,
  chat_enabled boolean NOT NULL DEFAULT false,
  whatsapp_enabled boolean NOT NULL DEFAULT false,

  -- Support hours and messages (English and Gujarati)
  support_hours_en text NOT NULL DEFAULT '' CHECK (length(support_hours_en) <= 80),
  support_hours_gu text NOT NULL DEFAULT '' CHECK (length(support_hours_gu) <= 80),
  after_hours_message_en text NOT NULL DEFAULT '' CHECK (length(after_hours_message_en) <= 160),
  after_hours_message_gu text NOT NULL DEFAULT '' CHECK (length(after_hours_message_gu) <= 160),
  delivery_promise_en text NOT NULL DEFAULT '' CHECK (length(delivery_promise_en) <= 120),
  delivery_promise_gu text NOT NULL DEFAULT '' CHECK (length(delivery_promise_gu) <= 120),

  -- App availability: older apps are asked to update; maintenance mode shows a message instead of the app.
  minimum_app_version text NOT NULL DEFAULT '1.0.0' CHECK (minimum_app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  maintenance_mode boolean NOT NULL DEFAULT false,
  maintenance_message_en text NOT NULL DEFAULT '' CHECK (length(maintenance_message_en) <= 200),
  maintenance_message_gu text NOT NULL DEFAULT '' CHECK (length(maintenance_message_gu) <= 200),
  show_maintenance_contact boolean NOT NULL DEFAULT false,

  -- Feature switches. They only show or hide features the installed app already has.
  flag_show_trials boolean NOT NULL DEFAULT true,
  flag_show_subscriptions boolean NOT NULL DEFAULT true,
  flag_show_offers boolean NOT NULL DEFAULT true,
  flag_show_quality_reports boolean NOT NULL DEFAULT true,
  flag_show_seasonal_banner boolean NOT NULL DEFAULT true,

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);

-- The starting row, so reading the settings always finds something.
INSERT INTO app_settings (support_hours_en, delivery_promise_en) VALUES ('Daily, 5:00 AM – 8:00 PM', 'Delivered before 7:00 AM');

-- The backend's database user may read and change the row. It cannot add or delete rows.
GRANT SELECT, UPDATE ON app_settings TO shreeram_app;
