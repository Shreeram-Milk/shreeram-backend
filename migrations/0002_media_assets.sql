-- 0002: uploaded pictures (stored in a private S3 bucket) and the banner picture link.
-- Run as the migration user (shreeram_migrate).

-- One row per uploaded file. The file itself lives in S3; this row remembers where, what it is, and whether the upload finished.
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('banner')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),
  -- 'pending' = the upload link was issued; 'ready' = the backend confirmed the file arrived and matches.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  uploaded_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);

-- A banner may have one picture. Removing the picture record never deletes the banner.
ALTER TABLE banners ADD COLUMN image_asset_id uuid REFERENCES media_assets (id) ON DELETE SET NULL;
