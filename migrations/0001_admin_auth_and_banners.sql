-- 0001: admin sign-in and home-screen banners.
-- Run as the migration user (shreeram_migrate), so the app user can use the tables through default privileges.

-- Admin accounts. Passwords are stored only as a one-way hash, never as text.
CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One-time codes emailed after the password is accepted. Only a hash of the code is kept.
CREATE TABLE admin_login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_login_codes_user_idx ON admin_login_codes (admin_user_id, created_at DESC);

-- Signed-in sessions. Only a hash of the session token is kept, so a database leak cannot be used to sign in.
CREATE TABLE admin_sessions (
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
CREATE INDEX admin_sessions_user_idx ON admin_sessions (admin_user_id);

-- A record of sign-ins and important changes: who did what, and when.
CREATE TABLE admin_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_user_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);

-- Banners and notices shown on the customer app's home screen.
CREATE TABLE banners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL DEFAULT 'promotion' CHECK (type IN ('promotion', 'announcement', 'warning', 'maintenance', 'informational')),
  audience text NOT NULL DEFAULT 'all_users' CHECK (audience IN ('all_users', 'prepaid', 'credit', 'subscribers')),
  title_en text NOT NULL CHECK (length(trim(title_en)) BETWEEN 1 AND 80),
  title_gu text NOT NULL DEFAULT '' CHECK (length(title_gu) <= 80),
  message_en text NOT NULL DEFAULT '' CHECK (length(message_en) <= 160),
  message_gu text NOT NULL DEFAULT '' CHECK (length(message_gu) <= 160),
  cta_type text NOT NULL DEFAULT 'none' CHECK (cta_type IN ('none', 'product', 'category')),
  cta_target text NOT NULL DEFAULT '',
  start_date date,
  end_date date,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CHECK ((cta_type = 'none') = (cta_target = ''))
);
CREATE INDEX banners_status_order_idx ON banners (status, sort_order);
