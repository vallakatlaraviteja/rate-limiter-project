# Context-Aware Rate Limiter

A context-aware HTTP rate-limiting middleware built with **Node.js 18+ and Express**. It enforces different request quotas depending on the caller's subscription tier and the type of endpoint being hit — with no external dependencies for state storage.

---

## Live Deployment

> **https://rate-limiter-nestack.onrender.com** *(replace with your actual Render/Railway/Fly URL after deploying)*

---

## How to Run

### Prerequisites

- Node.js 18 or later
- npm

### Install and start

```bash
git clone https://github.com/yourName_Nestack_Submission
cd yourName_Nestack_Submission
npm install
npm start          # starts on port 3000
```

The server listens on `PORT` env var if set, otherwise defaults to `3000`.

### Run the test suite

```bash
npm test
```

All 16 tests should pass. They cover every rule combination, the exact 429 schema, window-reset behaviour, and edge cases such as missing headers and bucket isolation.

### Manual smoke test

```bash
# Should return 200 five times, then 429 on the sixth
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/ai/generate \
    -H "X-User-Tier: free" \
    -H "X-User-ID: alice"
done
```

---

## API Routes

| Method | Path | Endpoint type |
|--------|------|---------------|
| POST | `/ai/generate` | `ai` |
| POST | `/ai/summarise` | `ai` |
| GET | `/data/list` | `read` |
| GET | `/data/export` | `read` |

All routes return `{ "ok": true }` on success.

### Request headers

| Header | Values | Default |
|--------|--------|---------|
| `X-User-Tier` | `free` \| `paid` | `free` |
| `X-User-ID` | any string | remote IP |

### Rate limits

| Tier | Endpoint type | Limit | Window |
|------|--------------|-------|--------|
| free | ai | 5 | 60 s |
| free | read | 30 | 60 s |
| paid | ai | 30 | 60 s |
| paid | read | 120 | 60 s |

### 429 response body

```json
{
  "error": "rate_limit_exceeded",
  "limit": 5,
  "window_seconds": 60,
  "retry_after_seconds": 34
}
```

`retry_after_seconds` is the number of whole seconds remaining in the current window. It is always ≥ 0.

---

## Design Decisions

### Route tagging instead of URL parsing

The assessment explicitly forbids determining the endpoint type from the URL string. The solution uses a `tagRoute(type)` helper that returns a small Express middleware. Each route definition includes it as its first middleware:

```js
app.post('/ai/generate', tagRoute('ai'), handler)
app.get('/data/list',    tagRoute('read'), handler)
```

`tagRoute` stamps `req._endpointType` with the given string and then immediately calls `rateLimiterCheck`. The rate limiter reads `req._endpointType` — it never inspects `req.path`, `req.url`, or `req.route`. Adding a new endpoint type requires only a new string in the rule table and a `tagRoute` call; no regex patterns or URL conventions need updating.

### Two-phase middleware design

A naïve approach of registering a single global middleware runs into a timing problem: when global middleware fires, Express has not yet matched the route, so the endpoint type is unknown. Rather than parse the URL to work around this, the design splits responsibility cleanly:

- The global middleware layer does nothing (it could be removed entirely; it is present only as an extension point).
- `tagRoute` is a route-level middleware that runs *after* route matching, so the type is always available when `rateLimiterCheck` executes.

This means enforcement happens at exactly the right moment with zero URL inspection.

### Fixed-window algorithm

Each unique key (user ID + tier + endpoint type) has a `{ count, windowStart }` record. When a request arrives:

1. If the record is missing or `now ≥ windowStart + 60 000 ms`, a fresh window starts with `count = 0`.
2. If `count ≥ limit`, the request is rejected with a 429. The store entry is not mutated on rejection so the `windowStart` remains stable for accurate `retry_after_seconds` calculation.
3. Otherwise `count` is incremented and the request proceeds.

A fixed window was chosen over a sliding window deliberately: it is simpler, completely predictable, has O(1) memory per key, and the assessment's test matrix describes limits in terms of discrete windows ("5 requests per 60 seconds"), which matches a fixed-window model exactly.

### In-memory store with lazy eviction

State is kept in a plain `Map`. There is no background cleanup timer. Stale entries are detected and overwritten at read time when the window has elapsed. This avoids timer drift, makes the store deterministic under test (time is injectable), and removes the need to manage interval handles.

### User identity

The user identifier defaults to `X-User-ID` header, falling back to `X-Forwarded-For` and then the TCP remote address. This means the test suite can set `X-User-ID` to create isolated buckets per test without restarting the server, while a real deployment behind a reverse proxy will pick up the correct client IP.

### No external libraries for rate limiting

The entire algorithm is implemented from scratch in `src/rateLimiter.js` (~100 lines). No `express-rate-limit`, `rate-limiter-flexible`, or similar packages are used.

---

## Limitations

### Single-process only

The in-memory `Map` is not shared across OS processes. If the application is horizontally scaled (multiple Node.js workers or containers), each process maintains an independent counter. A user could send five requests to each of *N* workers before being blocked, effectively multiplying their quota by *N*. Fixing this requires a shared atomic store (Redis, Postgres advisory locks, etc.), which is explicitly excluded from this assessment.

### Fixed-window boundary burst

A fixed window allows a burst of `2 × limit` requests in a short period. For example, a free user can exhaust their 5-request AI quota at 00:59, then immediately issue 5 more at 01:00 when the window resets — 10 requests within a two-second span. A sliding window or token-bucket algorithm would prevent this at the cost of increased implementation complexity.

### No persistence across restarts

Counters live only for the lifetime of the Node.js process. A server restart grants every user a fresh quota regardless of how many requests they made before the restart. This is acceptable for a development or stateless deployment context but would be a violation of the rate-limit contract in a production environment.

### Clock skew in distributed mode

`retry_after_seconds` is calculated from `Date.now()` on the server. If a client is behind a load balancer that routes them to a different server after a 429, that server's clock may differ slightly. The value is correct per-process but not globally synchronised.

### No IP reputation or fingerprinting

The current user identity relies entirely on `X-User-ID` and the remote IP. A determined caller can rotate IPs or omit the `X-User-ID` header to receive a fresh bucket, because there is no device fingerprinting, token-based identity, or IP-range grouping.

---

## Project Structure

```
.
├── server.js            # Entry point — starts HTTP server
├── src/
│   ├── app.js           # Express application, route definitions
│   ├── rateLimiter.js   # Core algorithm, in-memory store, middleware
│   └── routeTagger.js   # tagRoute() helper
├── tests/
│   └── rateLimiter.test.js   # 16 integration + unit tests
├── package.json
└── README.md
```
