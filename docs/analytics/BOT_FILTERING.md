# bot filtering

reduce automated noise without collecting visitor identities or blocking ordinary page access

## request checks

`POST /api/events` validates the request before storing anything in D1:

- `application/json`, an allowed event type and source, and a UUIDv4 event ID
- no unexpected payload fields; maximum body size of 1,024 bytes
- a present User-Agent that is not recognized by `isbot@5.2.2`
- consistent Origin and Fetch Metadata when those headers are available
- no speculative prefetch or prerender request headers
- a successful decision from the private rate limiter Worker

invalid or filtered events return `204` without a database write. requests above the quota return `429` with `Retry-After: 60`. unavailable bindings or write failures return `503`. duplicate event IDs are ignored by the unique constraint on event_id

## rate limiting

`workers/analytics-limiter.js` uses the Cloudflare `EVENT_RATE_LIMIT` binding with a limit of 60 requests per 60 seconds per client IP key. the Pages Function obtains the IP from Cloudflare's request headers and sends it only through the private Service Binding; it does not persist the IP in the analytics database or include it in diagnostic logs

this is an approximate rate limit, not distributed bot detection. users sharing an IP may share a quota, and automated clients can spoof ordinary browser headers or distribute traffic across IPs

## maintenance

- run `npm test` after updating bot filters, source validation, or rate limiting
- check legitimate mobile browser User-Agents before tightening any filter
- use Preview and temporary `ANALYTICS_DEBUG=1` for troubleshooting
- keep API error details out of responses and personal request data out of logs

these controls reduce noise and abuse; they do not identify unique visitors or guarantee that events come from humans
