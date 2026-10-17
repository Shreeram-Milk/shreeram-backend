# ShreeRam Milks backend: hand-over notes for hosting

For the person setting up AWS. Names only: never put real values in this file or in git.

## 1. Environment variables

Set these in the hosting platform's secret store. The server refuses to start in production if a required one is missing (see `src/config/env.ts`).

| Name | Required in production | What it is |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `HOST`, `PORT` | no | Defaults `0.0.0.0` and `4000` |
| `LOG_LEVEL` | no | Default `info` |
| `CORS_ORIGINS` | yes | Comma-separated exact origins of the admin site, for example `https://admin.example.com`. No wildcard. |
| `RATE_LIMIT_PER_MINUTE` | no | Default 300 |
| `DATABASE_URL` | yes | Postgres connection for the app user (`shreeram_app`) |
| `MIGRATION_DATABASE_URL` | for migrations | Postgres connection for the migration user (`shreeram_migrate`) |
| `DB_SSL`, `DB_SSL_CA_PATH`, `DB_TLS_SERVERNAME` | as needed | Database TLS. `DB_SSL=require` by default |
| `AUTH_SECRET` | yes | At least 32 random characters. Signs sign-in sessions and codes. Make a fresh one for production |
| `MAIL_MODE` | yes | Must be `smtp` in production (customers' sign-in codes and admin login codes are emailed) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | yes | The mail account. Set SPF and DKIM for the sending domain so codes reach the inbox, not Spam |
| `PUSH_MODE` | yes | Must be `fcm` in production |
| `FIREBASE_SERVICE_ACCOUNT_FILE` or `FIREBASE_SERVICE_ACCOUNT_JSON` | yes | Firebase service account for notifications. Create a **new** key for production |
| `AWS_REGION`, `S3_MEDIA_BUCKET` | yes | Private bucket for pictures. Use an instance role, not keys |
| `PHONEPE_ENV` | yes | `production` once PhonePe is live (default `sandbox`) |
| `ALLOW_SANDBOX_PAYMENTS` | no | `true` lets a `NODE_ENV=production` server use `PHONEPE_ENV=sandbox` for testing on AWS (UAT, Play closed test). Everything else stays strict. The server refuses to start if it is `true` together with `PHONEPE_ENV=production`. **Remove it when going live.** |
| `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, `PHONEPE_CLIENT_VERSION`, `PHONEPE_MERCHANT_ID` | yes | PhonePe live credentials (set all together) |
| `PHONEPE_WEBHOOK_USERNAME`, `PHONEPE_WEBHOOK_PASSWORD` | yes | The username and password typed into PhonePe's webhook settings (see `PHONEPE-WEBHOOK-SETUP.txt`) |
| `REVIEW_ACCOUNT_EMAIL`, `REVIEW_ACCOUNT_CODE` | only if the Play reviewer needs it | A demo sign-in: this email always signs in with this fixed 6-digit code, and no email is sent. Set both or neither. **Remove them after the store review.** |

## 2. Database

Create the database and two roles first: `shreeram_migrate` (owns the tables, used for migrations) and `shreeram_app` (what the server uses). The migrations assume both roles exist.

Run the files in `migrations/` **in this order, once each**, as `shreeram_migrate`. Either run `npm run migrate` (it remembers which files already ran) or paste each file into a SQL tool.

| File | What it adds |
| --- | --- |
| `0001_admin_auth_and_banners.sql` | Admin sign-in, home-screen banners |
| `0002_media_assets.sql`, `0003_media_assets_grants.sql` | Uploaded pictures |
| `0004_banner_labels_icons_onboarding.sql` | Banner labels and icons, first-run slides |
| `0005_app_settings.sql` | App settings |
| `0006_help_and_policies.sql` | Help and policies |
| `0007_master_data.sql` | Categories, slots, cut-off rules, service areas, trial plans, subscription rules |
| `0008_pin_directory.sql` | PIN directory (then run `npm run import-pins`) |
| `0009_products.sql` | Products and sizes |
| `0010_customers.sql`, `0011_customer_addresses.sql`, `0012_support_tickets.sql` | Customers, addresses, support |
| `0013_master_data_delete.sql`, `0014_delivery_on_product.sql` | Master data delete, delivery on product |
| `0015_orders_payments_credit.sql`, `0016_online_payments.sql`, `0017_payment_method_details.sql` | Orders, payments, credit |
| `0018_subscriptions_and_deliveries.sql` to `0021_trial_can_repeat.sql` | Subscriptions, trials, deadlines |
| `0022_notifications.sql` | Notifications |
| `0023_email_sign_in.sql` | Customers sign in with email |
| `0024_offers.sql` | Offers (percent, flat, free gift), banner "Offers page" link |
| `0025_remove_organic_badge.sql` | Removes the Organic product badge |

Then create the first admin: `npm run create-admin`.

Before the first real customer: take a backup, then run `scripts/pre-launch-clear-test-data.sql` once (it asks for the database name as a safety check). Never run it again after launch. `scripts/dev-reset-test-orders.sql` is for the development database only.

## 3. Build and run

```
npm ci
npm run check      # type check, lint, tests
npm run build
npm start
```

Health: `GET /health` (server up) and `GET /health/db` (database reachable). PhonePe webhooks must reach `/webhooks/phonepe` over HTTPS.

## 4. After launch

- PhonePe: switch to live keys only after the app is live, then re-test one real small payment and one refund.
- Remove `REVIEW_ACCOUNT_*` after Google Play review.
- Rotate any secret that was ever shared in chat or email.
