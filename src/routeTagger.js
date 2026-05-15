/**
 * routeTagger.js
 *
 * Stamps req._endpointType with the given tag, then immediately invokes the
 * rate-limiter enforcement step.  This two-step design is important:
 *
 *   1. The global rate-limiter middleware registered in app.js is a
 *      pass-through because at that point Express has not yet resolved which
 *      route matched, so the endpoint type is unknown.
 *
 *   2. tagRoute() is placed as the first route-level middleware on every
 *      route.  By the time Express calls it, the route is known, so we stamp
 *      the type and hand off to rateLimiterCheck immediately.
 *
 * This keeps URL parsing completely out of the picture — the endpointType
 * comes solely from the string passed to tagRoute().
 *
 * Usage:
 *   app.get('/data/list', tagRoute('read'), handler)
 *   app.post('/ai/generate', tagRoute('ai'), handler)
 */

"use strict";

const { rateLimiterCheck } = require("./rateLimiter");

function tagRoute(endpointType) {
  return function (req, res, next) {
    req._endpointType = endpointType;
    // Delegate enforcement now that endpoint type is known
    rateLimiterCheck(req, res, next);
  };
}

module.exports = { tagRoute };
