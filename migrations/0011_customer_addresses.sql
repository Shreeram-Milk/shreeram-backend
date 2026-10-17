-- 0011: customer addresses — where each customer lives (several per customer), and how they want deliveries handled.
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
-- It only creates new tables. It changes and deletes nothing that exists.
-- Addresses are never physically deleted: when a customer removes one it is marked removed, so old orders keep their address.
-- Whether an address can be delivered to is NOT stored: the delivery check works it out from your service areas every time,
-- so it stays right when you change a service area.

BEGIN;

CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  label text NOT NULL DEFAULT 'home' CHECK (label IN ('home', 'work', 'other')),
  -- Who receives the delivery and how to reach them (may differ from the account holder).
  recipient_name text NOT NULL CHECK (length(trim(recipient_name)) BETWEEN 1 AND 100),
  recipient_phone text NOT NULL CHECK (recipient_phone ~ '^\+[1-9][0-9]{7,14}$'),
  line1 text NOT NULL CHECK (length(trim(line1)) BETWEEN 1 AND 150),
  line2 text NOT NULL DEFAULT '' CHECK (length(line2) <= 150),
  landmark text NOT NULL DEFAULT '' CHECK (length(landmark) <= 150),
  city text NOT NULL DEFAULT '' CHECK (length(city) <= 80),
  pin_code text NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  is_default boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (customer_id) WHERE removed_at IS NULL;
-- At most one default address per customer, enforced by the database itself.
CREATE UNIQUE INDEX customer_addresses_one_default_idx ON customer_addresses (customer_id) WHERE is_default AND removed_at IS NULL;

-- One set of delivery preferences per customer ("don't ring the bell", "leave at the milk box"...).
CREATE TABLE customer_doorstep_instructions (
  customer_id uuid PRIMARY KEY REFERENCES customers (id),
  drop_location text NOT NULL DEFAULT 'front-door' CHECK (drop_location IN ('front-door', 'side-gate', 'milk-box', 'security-desk')),
  handoff text NOT NULL DEFAULT 'leave-at-door' CHECK (handoff IN ('hand-to-me', 'leave-at-door', 'milk-box', 'security')),
  no_doorbell boolean NOT NULL DEFAULT false,
  no_call boolean NOT NULL DEFAULT false,
  notify_after_delivery boolean NOT NULL DEFAULT true,
  additional_instructions text NOT NULL DEFAULT '' CHECK (length(additional_instructions) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON customer_addresses, customer_doorstep_instructions TO shreeram_app;

COMMIT;
