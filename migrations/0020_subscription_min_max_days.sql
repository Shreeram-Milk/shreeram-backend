-- 0020: how short and how long a subscription may be, per Subscription Rule.
--
-- A customer now picks the last delivery day on a calendar instead of choosing a fixed number of deliveries. Each rule says
-- how many days the plan must run at least (counted from the first to the last delivery day, both included) and at most.
-- Every existing rule gets 5 days and 180 days; staff can change them on the rule's page.
--
-- Only an addition. Run it once, in pgAdmin, as postgres.

BEGIN;

ALTER TABLE subscription_rules
  ADD COLUMN min_days integer NOT NULL DEFAULT 5 CHECK (min_days BETWEEN 1 AND 365),
  ADD COLUMN max_days integer NOT NULL DEFAULT 180 CHECK (max_days BETWEEN 1 AND 730),
  ADD CONSTRAINT subscription_rules_days_order CHECK (max_days >= min_days);

COMMIT;
