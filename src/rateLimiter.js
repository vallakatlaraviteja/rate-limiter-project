/**
 * rateLimiter.js
 *
 * Context-aware, in-memory rate limiter middleware.
 *
 * Rules enforced:
 *   free  + ai   →   5 req / 60 s
 *   free  + read →  30 req / 60 s
 *   paid  + ai   →  30 req / 60 s
 *   paid  + read → 120 req / 60 s
 *
 * Key design decisions:
 *   - All state is held in a plain JS Map (process lifetime only).
 *   - The user identity defaults to the X-Forwarded-For / remote address so
 *     that the tests do not need to send an extra identity header, but the key
 *     also includes tier + endpoint type so different tiers never share a bucket.
 *   - Window reset uses a "fixed window" strategy: when now >= windowStart +
 *     windowSeconds the counter is reset and a new window begins.
 *   - No setInterval cleanup is needed for correctness; stale keys are evicted
 *     lazily on the next hit from the same key.
 */

"use strict";

const WINDOW_SECONDS = 60;

// ------------------------------------------------------------------
// Rule table  (tier → endpointType → limit)
// ------------------------------------------------------------------
const RULES = {
  free: {
    ai: 5,
    read: 30,
  },
  paid: {
    ai: 30,
    read: 120,
  },
};

const VALID_TIERS = new Set(Object.keys(RULES));

// ------------------------------------------------------------------
// In-memory store
// { key → { count: number, windowStart: number (ms) } }
// ------------------------------------------------------------------
const store = new Map();

// ------------------------------------------------------------------
// Pure helpers (exported for unit-testing)
// ------------------------------------------------------------------

/**
 * Resolve the tier from the request header.
 * Falls back to "free" when absent or unrecognised.
 */
function resolveTier(req) {
  const header = (req.headers["x-user-tier"] || "").trim().toLowerCase();
  return VALID_TIERS.has(header) ? header : "free";
}

/**
 * Resolve a stable user identifier.
 * Uses X-User-ID when provided, otherwise falls back to remote IP.
 */
function resolveUserId(req) {
  return (
    req.headers["x-user-id"] ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

/**
 * Build the store key from the three dimensions that make a bucket unique.
 */
function buildKey(userId, tier, endpointType) {
  return `${userId}::${tier}::${endpointType}`;
}

/**
 * Core check-and-increment logic.
 * Returns { allowed: boolean, limit, remaining, retryAfterSeconds }
 *
 * Exported so tests can call it directly without spinning up an HTTP server.
 *
 * @param {string} key          - Unique bucket key
 * @param {number} limit        - Max requests per window
 * @param {number} nowMs        - Current timestamp in milliseconds (injectable for tests)
 */
function checkLimit(key, limit, nowMs = Date.now()) {
  const windowMs = WINDOW_SECONDS * 1000;

  let entry = store.get(key);

  // First request ever, or window has elapsed → start a fresh window
  if (!entry || nowMs >= entry.windowStart + windowMs) {
    entry = { count: 0, windowStart: nowMs };
  }

  if (entry.count >= limit) {
    // Reject - do NOT increment
    const elapsed = nowMs - entry.windowStart;
    const retryAfterSeconds = Math.max(
      0,
      Math.ceil((windowMs - elapsed) / 1000)
    );
    store.set(key, entry); // persist (unchanged) so window start stays stable
    return {
      allowed: false,
      limit,
      retryAfterSeconds,
    };
  }

  // Allow - increment and persist
  entry.count += 1;
  store.set(key, entry);
  return {
    allowed: true,
    limit,
    retryAfterSeconds: 0,
  };
}

// ------------------------------------------------------------------
// Express middleware
// ------------------------------------------------------------------

function rateLimiterMiddleware(req, res, next) {
  // endpointType is stamped by tagRoute() which runs before this middleware
  // reaches the handler. But because we registered the global middleware
  // BEFORE the routes, tagRoute() hasn't run yet at this point in the chain.
  //
  // We solve this by deferring the check to after the route-level middleware
  // has had a chance to stamp req._endpointType by wrapping next().
  //
  // Strategy: call next() immediately so Express continues matching and
  // running route-level middleware. We intercept by wrapping res.json /
  // res.send ONLY if the route hasn't been tagged — but that is fragile.
  //
  // Better strategy (used here): run the limiter as a post-routing hook by
  // using router-level middleware that Express resolves after tagRoute.
  // Because we attach the global middleware BEFORE routes are defined in
  // app.js, we need to shift the check to a small wrapper that tagRoute
  // triggers.  See rateLimiterCheck() below — tagRoute calls it after stamping.
  //
  // This middleware is therefore intentionally a pass-through; the real
  // check is in rateLimiterCheck(), called from within tagRoute.
  next();
}

/**
 * The actual enforcement function, called by tagRoute after it stamps
 * req._endpointType.
 */
function rateLimiterCheck(req, res, next) {
  const endpointType = req._endpointType;

  // Resolve tier & user
  const tier = resolveTier(req);
  const userId = resolveUserId(req);

  // Look up rule
  const tierRules = RULES[tier];
  const limit = tierRules?.[endpointType];

  if (limit === undefined) {
    // Unknown endpoint type - let it through (no rule = no limit)
    return next();
  }

  const key = buildKey(userId, tier, endpointType);
  const result = checkLimit(key, limit);

  if (!result.allowed) {
    return res.status(429).json({
      error: "rate_limit_exceeded",
      limit: result.limit,
      window_seconds: WINDOW_SECONDS,
      retry_after_seconds: result.retryAfterSeconds,
    });
  }

  next();
}

// ------------------------------------------------------------------
// Expose store reset for tests
// ------------------------------------------------------------------
function resetStore() {
  store.clear();
}

module.exports = {
  rateLimiterMiddleware,
  rateLimiterCheck,
  resolveTier,
  resolveUserId,
  buildKey,
  checkLimit,
  resetStore,
  RULES,
  WINDOW_SECONDS,
};
