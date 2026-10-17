-- 0008: PIN directory — a read-only reference list of India's PIN codes (post offices with district and state).
-- It is only used to fill in city and state for you, and to find all PINs of a city. It does NOT decide where you deliver:
-- delivery is decided only by the PINs you add to your own service areas.
-- Run as the migration user (shreeram_migrate), in one go. Wrapped in BEGIN/COMMIT: everything is created or nothing is.
-- It creates one new, empty table and touches nothing else. The data is loaded later by a separate import step.

BEGIN;

CREATE TABLE pin_directory (
  id bigserial PRIMARY KEY,
  pin_code text NOT NULL CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  office_name text NOT NULL DEFAULT '' CHECK (length(office_name) <= 120),
  district text NOT NULL DEFAULT '' CHECK (length(district) <= 80),
  state text NOT NULL DEFAULT '' CHECK (length(state) <= 60),
  -- One post office is listed once per PIN, so re-running the import cannot create copies.
  UNIQUE (pin_code, office_name)
);
-- "What is this PIN?" and "which PINs are in this district?" both need to be instant.
CREATE INDEX pin_directory_pin_code_idx ON pin_directory (pin_code);
CREATE INDEX pin_directory_state_district_idx ON pin_directory (lower(state), lower(district));

-- The backend's database user may only read this list. The import runs as the migration user.
GRANT SELECT ON pin_directory TO shreeram_app;

COMMIT;
