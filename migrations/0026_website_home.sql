-- 0026: the public website's Home page text, edited by staff in the admin (Website > Home page).
-- Run as the migration user (shreeram_migrate). Safe to run once; it does not touch any existing table.

BEGIN;

-- ONE row for the whole website. `id` can only ever be true, so a second row is impossible.
-- `content` holds the page's words and links as one JSON object; the backend checks its shape before saving.
CREATE TABLE website_home (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);

-- The starting text, so the website shows a complete page before anyone edits it.
INSERT INTO website_home (content) VALUES ('{
  "announcement": "",
  "heroTitle": "Fresh milk at your door, every morning",
  "heroSubtitle": "Pure milk, curd, paneer and ghee from our own dairy, delivered before 7 AM. Order once, try a trial, or subscribe and pause any time.",
  "heroImageUrl": "",
  "highlights": [
    { "title": "Fresh every day", "text": "Collected, chilled and delivered the same morning." },
    { "title": "Delivered before 7 AM", "text": "On your doorstep before your day begins." },
    { "title": "Skip or pause any time", "text": "Going away? Pause deliveries in a tap. Nothing is lost." },
    { "title": "Pay your way", "text": "UPI, cards or a monthly credit account." }
  ],
  "steps": [
    { "title": "Get the app", "text": "Download ShreeRam Milks and sign in with your email." },
    { "title": "Choose your milk", "text": "Order once, try a short trial, or start a daily plan." },
    { "title": "Wake up to fresh milk", "text": "We deliver every morning. Skip a day whenever you like." }
  ],
  "showProducts": true,
  "productsTitle": "Our products",
  "ctaTitle": "Start your fresh mornings today",
  "ctaText": "Download the app, enter your PIN code and see what we deliver to you.",
  "playStoreUrl": "",
  "seoTitle": "ShreeRam Milks: fresh milk delivered every morning",
  "seoDescription": "Order farm-fresh milk, curd, paneer and ghee online. Daily delivery before 7 AM, trials and subscriptions you can pause any time."
}');

-- The backend's database user may read and change the row. It cannot add or delete rows.
GRANT SELECT, UPDATE ON website_home TO shreeram_app;

COMMIT;
