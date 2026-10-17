# ShreeRam Milks API

Express + TypeScript + Postgres (AWS RDS). One API for the admin, the customer app and any future website.

## Run it

```bash
npm install
cp .env.example .env.local      # then fill in .env.local; it is ignored by Git
npm run dev                     # http://localhost:4000, restarts on changes
```

Check it is up: `http://localhost:4000/health` (process) and `http://localhost:4000/health/db` (database).

From your phone on the same network, use your laptop's address, for example `http://192.168.1.20:4000/health`.
Allow port 4000 in Windows Firewall once.

## Database

- `DATABASE_URL` uses the **application user** (`shreeram_app`): read and write data only.
- `MIGRATION_DATABASE_URL` uses the **migration user** (`shreeram_migrate`): used only by `npm run migrate`.
- Never use the master `postgres` account in the app.
- RDS is reached through the AWS Session Manager tunnel on `localhost:5432`. Keep certificate checks on: set
  `DB_SSL_CA_PATH` to the AWS RDS CA bundle and `DB_TLS_SERVERNAME` to the RDS hostname, because the certificate
  is for that name and not for `localhost`. `DB_SSL=disable` exists only for a local Postgres without TLS, and the
  server refuses to start with it in production.

### Admin login codes by email

`MAIL_MODE=smtp` emails the one-time login code using `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`
(Gmail with an app password works for development; use AWS SES's SMTP endpoint in production). `MAIL_MODE=console`
prints the code in the backend window instead, for development only; the server refuses it in production.
If an email cannot be sent, the admin sees a plain message and the reason stays in the server log.

### Migrations

Plain SQL files in `migrations/`, named `0001_name.sql`, `0002_name.sql`, and run in order by `npm run migrate`.
Each runs in its own transaction. An applied migration must never be edited; add a new one. The runner refuses to
continue if an applied file has changed, if two files share a number, or if a file the database knows about is missing.

## Standards

Read `PERFORMANCE-AND-AWS.md` before adding or changing any endpoint, query, upload or AWS setting.

## Checks

```bash
npm run check    # type-check, lint and tests
npm run build    # compile to dist/
```

## Rules for adding features

- Every external input (body, query, params) goes through `validate()` with a Zod schema.
- Errors are `AppError`s with a stable `code`; the apps translate the code. Unexpected errors become a generic 500 and
  are logged in full, never shown to the client.
- Never take a user id from the request body. Read it from the verified session, and filter every query by it.
- Money is integer paise, and totals are calculated on the server.
- Secrets live in `.env.local` locally and in AWS Secrets Manager in production. Never commit them.
