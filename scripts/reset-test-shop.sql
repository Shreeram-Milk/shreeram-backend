-- Full test-shop reset: customers, commerce records, products and all product/delivery master values.
-- Permanently deletes database records. Take a backup first and stop test traffic while running.
-- Keeps admin users/sessions/audit, app settings, banners, onboarding, help, policies,
-- notification templates/broadcasts, website content, media assets and the national PIN directory.
-- Does not cancel/refund anything at PhonePe or delete image files from storage.
-- Run as the database owner/migration user, as one script. Never run on a shop with real transactions.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF current_database() <> 'shreeram_dev' THEN
    RAISE EXCEPTION 'Wrong database: %. Expected shreeram_dev.', current_database();
  END IF;
END $$;

-- All related tables are named explicitly. An unexpected foreign-key dependency stops the reset.
TRUNCATE TABLE
  public.customer_sign_in_codes,
  public.customer_sessions,
  public.customer_addresses,
  public.customer_doorstep_instructions,
  public.push_tokens,
  public.notifications,
  public.support_ticket_messages,
  public.support_tickets,
  public.order_items,
  public.order_status_history,
  public.orders,
  public.subscription_activity,
  public.subscription_lines,
  public.subscription_pauses,
  public.subscription_skips,
  public.subscriptions,
  public.payment_activity,
  public.payment_events,
  public.payment_requests,
  public.payments,
  public.refunds,
  public.prepaid_adjustments,
  public.credit_ledger_entries,
  public.offer_redemptions,
  public.offer_products,
  public.offers,
  public.product_gallery_images,
  public.product_trial_plans,
  public.product_subscription_rules,
  public.product_variants,
  public.products,
  public.fulfilment_profiles,
  public.service_area_pin_slots,
  public.service_area_pins,
  public.cutoff_conditions,
  public.categories,
  public.trial_plans,
  public.subscription_rules,
  public.cutoff_rules,
  public.service_areas,
  public.delivery_slots,
  public.customers
RESTRICT;

ALTER SEQUENCE public.order_number_seq RESTART WITH 1001;
ALTER SEQUENCE public.subscription_number_seq RESTART WITH 1001;

COMMIT;

SELECT 'customers' AS what, count(*) AS remaining FROM public.customers
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'orders', count(*) FROM public.orders
UNION ALL SELECT 'subscriptions', count(*) FROM public.subscriptions
UNION ALL SELECT 'payments', count(*) FROM public.payments
UNION ALL SELECT 'categories', count(*) FROM public.categories
UNION ALL SELECT 'service areas', count(*) FROM public.service_areas;
