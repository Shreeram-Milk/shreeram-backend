-- Account deletion removes the customer's push tokens in the same statement as anonymising their account.
-- 0022 granted read/write access but omitted the DELETE privilege used by that operation.
BEGIN;

GRANT DELETE ON push_tokens TO shreeram_app;

COMMIT;
