# sophie analytics

privacy-minimized event analytics for the Sophie Caviezel landing page

## overview

- `page_view` — first visible page load and each bfcache restoration
- `telegram_click` — trusted primary or middle click on the Telegram link
- `fanvue_click` — trusted primary or middle click on the Fanvue link

these are event counts, not unique visitors or confirmed visits to external services

`utm_source` accepts `threads`, `tiktok`, `instagram`, `facebook`, and `tg` (Telegram); missing or unsupported values are stored as `unknown`

## architecture

```text
browser -> POST /api/events -> Pages Function
                             |-> validation + isbot
                             |-> private rate limiter Worker
                             `-> D1 events table
```

analytics uses `sendBeacon` with a `fetch` fallback; it never delays or replaces the direct Telegram and Fanvue links

no tracking cookies, persistent visitor IDs, or device fingerprints are used

## cloudflare bindings

| setting               | purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `ANALYTICS_ENABLED=1` | enable event collection; otherwise the endpoint does not store events |
| `ANALYTICS_DB`        | D1 database binding                                                   |
| `ANALYTICS_LIMITER`   | service binding to the private limiter Worker                         |
| `ANALYTICS_DEBUG=1`   | optional diagnostic messages, without event IDs or client IPs         |
| `EVENT_RATE_LIMIT`    | limiter Worker's rate limit binding, 60 requests per 60 seconds       |

Pages Functions run only for `/api/*` via `public/_routes.json`. the static site's security headers are defined in `public/_headers`

use separate D1 databases and Pages bindings for Preview and Production. production deployment and enabling analytics require explicit approval

## database

schema: [`migrations/0001_events.sql`](../../migrations/0001_events.sql)

| column        | purpose                                                              |
| ------------- | -------------------------------------------------------------------- |
| `seq`         | auto-incrementing integer primary key for event ordering and cursors |
| `event_id`    | unique UUIDv4 for event deduplication                                |
| `occurred_at` | UTC ISO-8601 timestamp assigned by D1 on insert                      |
| `event_type`  | event name restricted by a database `CHECK` constraint               |
| `source`      | normalized UTM source validated by the application                   |

the database does not store IP addresses, user agents, cookies, sessions, or fingerprints

`seq` identifies the insertion order of stored events; gaps are allowed. it is not a visitor or session identifier

duplicate `event_id` values are ignored without creating another event

sources are validated by the client and server rather than restricted by a database `CHECK` constraint. adding an approved source does not require changing the table schema

### indexes

| index                         | purpose                                    |
| ----------------------------- | ------------------------------------------ |
| `idx_events_time_source_type` | time-range aggregations for the dashboard  |
| `idx_events_type_seq`         | sequential event queries for notifications |

indexes are defined in the initial migration

## database migrations

SQL migrations live in [`migrations/`](../../migrations/)

`0001_events.sql` creates the events table and its indexes

```bash
npx wrangler d1 migrations apply ANALYTICS_DB --local --config ./wrangler.local.jsonc
npx wrangler d1 migrations apply sophie-analytics-preview --remote --config ./wrangler.preview-migrations.jsonc
```

Cloudflare tracks applied migrations separately for each database. changing an already applied migration file does not update an existing schema

after deployment, treat applied migrations as immutable. use a new migration for schema changes, or explicitly rebuild a disposable database

production database preparation is separate from website deployment. verify the target database, schema, and migration history before using `wrangler.production-migrations.jsonc`

## development

```bash
npm ci
npm test
npm run build
```

`npm run dev` serves only the Vite frontend; it does not run Cloudflare Pages Functions, D1, or the limiter. integrated API testing requires the D1 and Service Bindings in a Cloudflare environment

## operations

- validate changes with `npm test` and a protected Preview deployment before release
- keep `ANALYTICS_DEBUG` disabled during ordinary operation
- use `wrangler pages deployment tail` for temporary troubleshooting
- preserve `unknown` events; UTM values are labels, not verified referrers
- treat bot filtering and rate limiting as noise reduction, not proof of human traffic

see [bot filtering](BOT_FILTERING.md) for the acceptance policy and its limitations
