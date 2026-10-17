-- 0006: Help (topics + questions) and Policies (versioned legal documents).
-- Run as the migration user (shreeram_migrate), in one go.
-- It is wrapped in BEGIN/COMMIT: either everything is created or nothing is. If pgAdmin shows an error,
-- run `ROLLBACK;` once and tell me what the error said. It does not touch any existing table.

BEGIN;

-- ============================================================================================
-- Help topics: the fixed list of issue types. Used by the Help screen's topic chips now, and by
-- customer issue reports later, so questions and reports can never use different lists.
-- Staff can rename, reorder and re-icon them in the admin; they cannot add or delete (the app knows this list).
-- ============================================================================================
CREATE TABLE help_topics (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,39}$'),
  label_en text NOT NULL CHECK (length(trim(label_en)) BETWEEN 1 AND 60),
  label_gu text NOT NULL DEFAULT '' CHECK (length(label_gu) <= 60),
  icon_key text NOT NULL CHECK (length(icon_key) BETWEEN 1 AND 40),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO help_topics (id, label_en, label_gu, icon_key, sort_order) VALUES
  ('delivery_missing',   'Delivery not received', 'ડિલિવરી મળી નથી',        'package-x',   1),
  ('late_delivery',      'Late delivery',         'મોડી ડિલિવરી',             'clock',       2),
  ('wrong_product',      'Wrong product',         'ખોટી પ્રોડક્ટ',            'shuffle',     3),
  ('quality_issue',      'Quality issue',         'ગુણવત્તાની સમસ્યા',       'badge-alert', 4),
  ('payment_issue',      'Payment issue',         'ચુકવણીની સમસ્યા',         'credit-card', 5),
  ('subscription_issue', 'Subscription issue',    'સબ્સ્ક્રિપ્શનની સમસ્યા',  'repeat',      6),
  ('address_issue',      'Address issue',         'સરનામાની સમસ્યા',         'map-pin',     7),
  ('other',              'Other',                 'અન્ય',                      'help-circle', 8);

-- ============================================================================================
-- Help questions: a question and answer in English and Gujarati, filed under one topic.
-- Only 'published' questions reach the app. 'featured' ones are shown first (the service allows at most 5).
-- ============================================================================================
CREATE TABLE faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id text NOT NULL REFERENCES help_topics (id),
  question_en text NOT NULL CHECK (length(trim(question_en)) BETWEEN 1 AND 160),
  question_gu text NOT NULL DEFAULT '' CHECK (length(question_gu) <= 160),
  answer_en text NOT NULL CHECK (length(trim(answer_en)) BETWEEN 1 AND 800),
  answer_gu text NOT NULL DEFAULT '' CHECK (length(answer_gu) <= 800),
  -- Extra words people might search for, such as "milk late" finding the delivery answer.
  search_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(search_keywords) <= 10),
  featured boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  -- A hidden question can never hold a featured place.
  CHECK (NOT featured OR status = 'published')
);
CREATE INDEX faqs_status_topic_order_idx ON faqs (status, topic_id, sort_order);

-- ============================================================================================
-- Policies: one row per VERSION of each legal document (privacy, terms, refund...).
-- A published version is never edited: a change is a new version. At most one version per type is published
-- at a time; publishing a new one archives the old one. Old versions are kept for the record.
-- ============================================================================================
CREATE TABLE policy_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('privacy', 'terms', 'refund', 'cancellation', 'subscription', 'delivery')),
  version text NOT NULL CHECK (length(trim(version)) BETWEEN 1 AND 20),
  title_en text NOT NULL CHECK (length(trim(title_en)) BETWEEN 1 AND 120),
  title_gu text NOT NULL DEFAULT '' CHECK (length(title_gu) <= 120),
  body_en text NOT NULL CHECK (length(trim(body_en)) >= 1 AND length(body_en) <= 20000),
  body_gu text NOT NULL DEFAULT '' CHECK (length(body_gu) <= 20000),
  effective_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  UNIQUE (type, version),
  -- A draft has never been published; anything else has.
  CHECK ((status = 'draft') = (published_at IS NULL))
);
-- The database itself refuses a second published version of the same policy.
CREATE UNIQUE INDEX policy_one_published_per_type_idx ON policy_documents (type) WHERE status = 'published';

-- Legal history protection. Once a version leaves 'draft', its wording, version label and date are frozen,
-- it can only move forward (published -> archived), and it can never be deleted.
CREATE FUNCTION policy_documents_protect_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'A published or archived policy version cannot be deleted.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF (NEW.type, NEW.version, NEW.title_en, NEW.title_gu, NEW.body_en, NEW.body_gu, NEW.effective_date, NEW.published_at)
       IS DISTINCT FROM (OLD.type, OLD.version, OLD.title_en, OLD.title_gu, OLD.body_en, OLD.body_gu, OLD.effective_date, OLD.published_at) THEN
      RAISE EXCEPTION 'A published policy version cannot be edited. Create a new version instead.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
      RAISE EXCEPTION 'An archived policy version cannot be published again. Create a new version instead.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'published' AND NEW.status = 'draft' THEN
      RAISE EXCEPTION 'A published policy version cannot go back to draft.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_documents_protect_history_update BEFORE UPDATE ON policy_documents
  FOR EACH ROW EXECUTE FUNCTION policy_documents_protect_history();
CREATE TRIGGER policy_documents_protect_history_delete BEFORE DELETE ON policy_documents
  FOR EACH ROW EXECUTE FUNCTION policy_documents_protect_history();

-- ============================================================================================
-- Permissions for the backend's database user (the lesson from 0003). It can do only what the app needs:
--   topics: read and edit (no add, no delete)   questions: read, add, edit (hide with 'inactive', never delete)
--   policies: read, add, edit, delete (the trigger above limits edits and deletes to drafts)
-- ============================================================================================
GRANT SELECT, UPDATE ON help_topics TO shreeram_app;
GRANT SELECT, INSERT, UPDATE ON faqs TO shreeram_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_documents TO shreeram_app;

COMMIT;
