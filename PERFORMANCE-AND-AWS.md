# PERFORMANCE-AND-AWS.md — Speed, Scale and AWS Standard

> The same file lives in `admin/`, `Backend/` and `Frontend/`. Keep the three copies identical.
> It works with `AGENTS.md` (architecture), `DESIGN.md` (visuals) and `specs.md` (business rules).
> If it conflicts with security, money or data integrity rules, those win.

**Purpose.** Keep ShreeRam Milks fast on a phone over mobile data, cheap to run on AWS, and able to grow from hundreds to many thousands of customers **without a rewrite**. Fix structural problems first; never micro-optimise.

---

## 1. Compression

### The rule
**Compress at the edge, not in application code.** Do not add compression middleware to the Node API while CloudFront (or another CDN or proxy) sits in front of it. Compressing twice wastes CPU and can break caching.

| Thing | What to do |
|---|---|
| JSON from the API | CloudFront **Compress objects automatically** (Brotli first, gzip as fallback). Until CloudFront exists, a small API with small JSON needs nothing. |
| Admin website (Next.js) | `next start` gzips already. Behind CloudFront set `compress: false` in `next.config` and let CloudFront do it, so it is not done twice. |
| Pictures (JPEG, PNG, WebP) | **Never gzip or Brotli.** They are already compressed and will not shrink. Shrink them by resizing and by choosing the format (see section 4). |
| SVG icons | Text, so Brotli and gzip help. Keep them under 100 KB. |
| zstd | Not yet. Browser and React Native support is uneven. Revisit later. |

### What matters more than compression
1. **Send less.** Select only the columns a screen needs. Return small DTOs, never raw database rows.
2. **Paginate** every list that can grow (customers, orders, deliveries, history). Fixed page size, default 20, maximum 100.
3. **Shrink pictures** before they are stored.
4. **Cache** what rarely changes (section 3).

Compression typically saves 60–80% on JSON lists, but only when the list is large. A 2 KB banner response gains almost nothing. Paying attention to payload size comes first; compression is the last step.

---

## 2. Backend (Express + Postgres on AWS)

**Stateless.** No data kept in server memory between requests (no in-memory sessions, carts, or counters). Any server can answer any request, so we can add servers when traffic grows. Sessions already live in the database.

**Database**
- Every query names its columns. No `select *` on growing tables.
- Add an index for every column used in `where`, `order by` or a join on a growing table. Create the index in the same migration as the table.
- No queries inside loops (N+1). Use joins or `= any($1)` batches.
- Keep transactions short and focused. Never call an outside service (S3, SMS, payment) inside a transaction.
- Use one shared connection pool. Set a statement timeout and a pool size that fits the RDS instance (small instance: 10–20 connections). When several servers run, put **RDS Proxy** in front so connections are not exhausted.
- Every migration is reviewed for locks: adding a column with a default is fine; rewriting a big table is not.

**Requests**
- Set timeouts on every outgoing call (S3, SMS, payments, email).
- Independent reads run in parallel (`Promise.all`). Dependent writes stay in order.
- Rate limits stay on. Public endpoints get stricter limits than admin.
- Webhooks and payments are idempotent (unique keys), so a retry never double-charges.
- Shut down gracefully: stop taking requests, finish current ones, close the pool.

**Responses**
- Private data: `Cache-Control: no-store` (the current default).
- Public, rarely-changing data (banners, onboarding, FAQs, policies, delivery slots): send `Cache-Control: public, max-age=60` plus an `ETag`, so the app and CloudFront can reuse it. Never do this for anything personal.
- Log one short line per request, with no tokens, cookies, or personal data.

---

## 3. Caching, by kind of data

| Kind | Examples | Rule |
|---|---|---|
| Public content | banners, onboarding, FAQs, policies, categories, slots | Short shared cache (60 s – 5 min) at CloudFront and the app |
| Dynamic business data | orders, subscriptions, deliveries, credit balances | Fresh. No shared cache. |
| Personal data | profile, addresses, payments | `no-store`. Never in a shared cache. |
| Picture files | S3 objects | Cache for a long time. Their key never changes (see section 4). |

After an admin edit, the app may show the old version for as long as the cache lasts. Choose the cache time per feature; urgent notices (maintenance, warnings) stay short.

---

## 4. Pictures and files

- **Private bucket always.** No public access. Files are read through short-lived signed links (CloudFront signed URLs or S3 presigned URLs).
- **Random keys.** `banners/2026/10/<uuid>.webp`. A name typed by a user never reaches the path. A key is never reused for different content, so it can be cached for a long time.
- **Resize before storing.** Banners: about 1200 px wide, under 200 KB. Onboarding: about 1080 px wide, under 250 KB. Product cards: a small thumbnail (about 400 px) plus a larger version for the detail page. Do not send a 2 MB photo to draw a 100 px thumbnail.
- **Prefer WebP** (smaller than JPEG at the same quality). AVIF later if every target supports it.
- **Verify after upload.** The backend checks size and type with S3 before a file is marked ready. SVGs are read back and refused if they contain scripts or links.
- **Clean up.** A lifecycle rule deletes uploads that stayed `pending` for more than 1 day.
- **CloudFront in front of the bucket** (Origin Access Control) once traffic grows, so pictures come from a nearby edge and S3 is not hit for every view.

---

## 5. AWS

**Identity**
- Production uses an **IAM role** attached to the service. **No access keys** in production.
- Development keys live only in the untracked `.env.local`. They are never committed, logged, or sent to a browser or phone.
- Each environment (dev, staging, production) has its own bucket, database and IAM permissions. Least privilege: the app may only read, write and sign for its own bucket.
- Rotate shared passwords and keys before launch and after anyone leaves.

**Network and data**
- RDS in a **private subnet**, no public address. The app reaches it through the VPC. (Developers use the Session Manager tunnel.)
- Automated backups on; Multi-AZ for production; test a restore once.
- TLS everywhere; certificate checks on.
- Secrets in **Secrets Manager** or **Parameter Store**, not in code or plain environment files.

**Running the app**
- Containers (ECS Fargate or App Runner) behind an **Application Load Balancer**. Health checks use `/health`.
- Start with 2 small instances in different zones. Add autoscaling on CPU and request count when real traffic needs it.
- **SES** for email, **CloudWatch** logs and alarms (5xx rate, p95 latency, database CPU and connections, free storage).
- Budgets and cost alerts from day one.

**Do not build early.** No queues, workers, microservices, Kubernetes or multi-region until a measured problem needs them (AGENTS.md section 39).

---

## 6. Customer app (Expo / React Native)

- All server data goes through **service → hook → screen**. Screens never call `fetch`.
- React Query with deliberate `staleTime`: urgent content short (30 s), stable content long (5 min). Do not refetch on every render or screen focus without a reason.
- Long lists use `FlatList` with a stable `keyExtractor` and pagination. Never `ScrollView` over an unbounded list.
- Show pictures with `expo-image` (disk cache, fade). Always give a size. Never load a full-size image into a small box.
- Keep the JavaScript bundle small: no heavy libraries for small jobs, no duplicates of the same capability.
- Always handle loading, empty and failed states. A failed request must never crash a screen.
- Validate every server response before use (Zod, per `agent-coding-rules.md`). A bad record is dropped, not rendered.
- No console output in shipped code.

## 7. Admin (Next.js)

- Server Components by default; client components as small islands (AGENTS.md sections 6–8).
- Load only what the screen needs. Heavy sections load when opened.
- Lists are paginated and filtered **on the server**. Search is debounced and bounded.
- Large forms are their own route. Do not mount hidden heavy sections.
- Upload pictures straight to S3 with a presigned link; never stream files through the backend.

---

## 8. Budgets (targets, not promises)

| Measure | Target |
|---|---|
| API response, normal read (p95) | under 300 ms |
| JSON list response | under 50 KB per page |
| Banner picture | under 200 KB after resizing |
| Home screen usable on a mid-range phone over 4G | under 3 s |
| Database queries per request | 3 or fewer for a normal screen |
| Admin page's first JavaScript | keep growing slowly; justify any new heavy library |

## 9. Checklist before a feature is called done

- [ ] Lists paginated; columns selected; no N+1; indexes added
- [ ] Payloads small; pictures resized; no public bucket
- [ ] Caching chosen on purpose for this data's kind
- [ ] Timeouts on every outside call; idempotent where money is involved
- [ ] No secrets in code, logs or the client
- [ ] Loading, empty and error states exist
- [ ] Typecheck, lint and tests pass

## 10. Growth stages

| Stage | Customers | What we do |
|---|---|---|
| Now | up to a few thousand | One small API instance, small RDS, S3. Follow sections 1–9. No extra infrastructure. |
| Growing | thousands to tens of thousands | CloudFront for pictures and public API content, 2+ API instances behind the load balancer, RDS Proxy, read-only reports moved off peak. |
| Large | beyond that | Read replica for reports, background workers for bulk notifications and exports, caching layer if measured need appears. |

Move to the next stage because **measurements** say so (slow queries, high CPU, cost), not because of guesses.
