-- 0012: support tickets — a customer reports a problem in the app; staff read it, reply, and close it in the admin.
-- Run as the migration user (shreeram_migrate), in one go.
-- Wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error, run `ROLLBACK;` once and send me the error.
-- It only creates new tables. It changes and deletes nothing that exists.
-- Tickets and messages are never deleted: a closed ticket stays as history. When a customer deletes their account, the app blanks
-- what that customer wrote (the backend does this in the same step as the rest of the deletion).
-- A ticket is linked to its customer only for now. Links to orders, deliveries and subscriptions are added in the orders bundle,
-- when those tables exist.

BEGIN;

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The number staff and customers quote: TKT-1001, TKT-1002, ...
  ticket_number integer GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers (id),
  category text NOT NULL CHECK (category IN ('delivery_missing', 'late_delivery', 'wrong_product', 'quality_issue', 'payment_issue', 'subscription_issue', 'address_issue', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  -- The staff member looking after it (blank until someone takes it).
  assignee_admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, updated_at DESC);
CREATE INDEX support_tickets_customer_idx ON support_tickets (customer_id, created_at DESC);
CREATE INDEX support_tickets_category_idx ON support_tickets (category);

CREATE TABLE support_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets (id),
  author text NOT NULL CHECK (author IN ('customer', 'admin')),
  -- Which staff member wrote it (only for author = 'admin').
  admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((author = 'admin') OR admin_id IS NULL)
);
CREATE INDEX support_ticket_messages_ticket_idx ON support_ticket_messages (ticket_id, created_at);

GRANT SELECT, INSERT, UPDATE ON support_tickets TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON support_ticket_messages TO shreeram_app;

COMMIT;
