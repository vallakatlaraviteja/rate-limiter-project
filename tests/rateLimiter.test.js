/**
 * tests/rateLimiter.test.js
 *
 * Integration tests using supertest (no real port needed).
 * Tests verify every rule combination, the 429 response schema,
 * window reset behaviour, and edge cases.
 */

"use strict";

const request = require("supertest");
const app = require("../src/app");
const { resetStore, checkLimit, WINDOW_SECONDS } = require("../src/rateLimiter");

beforeEach(() => {
  // Isolate each test with a clean store
  resetStore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeId() {
  // Return a unique user-id per test run to avoid key collisions
  return `user_${Math.random().toString(36).slice(2)}`;
}

async function hitRoute(app, method, path, userId, tier, times = 1) {
  const responses = [];
  for (let i = 0; i < times; i++) {
    const res = await request(app)
      [method](path)
      .set("x-user-id", userId)
      .set("x-user-tier", tier);
    responses.push(res);
  }
  return responses;
}

// ---------------------------------------------------------------------------
// 1. Rule enforcement — correct limit per combination
// ---------------------------------------------------------------------------

describe("Rule enforcement", () => {
  test("free + ai: allows exactly 5, blocks on 6th", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "post", "/ai/generate", id, "free", 6);

    for (let i = 0; i < 5; i++) {
      expect(responses[i].status).toBe(200);
    }
    expect(responses[5].status).toBe(429);
  });

  test("free + read: allows exactly 30, blocks on 31st", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "get", "/data/list", id, "free", 31);

    for (let i = 0; i < 30; i++) {
      expect(responses[i].status).toBe(200);
    }
    expect(responses[30].status).toBe(429);
  });

  test("paid + ai: allows exactly 30, blocks on 31st", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "post", "/ai/generate", id, "paid", 31);

    for (let i = 0; i < 30; i++) {
      expect(responses[i].status).toBe(200);
    }
    expect(responses[30].status).toBe(429);
  });

  test("paid + read: allows exactly 120, blocks on 121st", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "get", "/data/list", id, "paid", 121);

    for (let i = 0; i < 120; i++) {
      expect(responses[i].status).toBe(200);
    }
    expect(responses[120].status).toBe(429);
  });

  test("/ai/summarise is also tagged ai", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "post", "/ai/summarise", id, "free", 6);
    expect(responses[5].status).toBe(429);
  });

  test("/data/export is also tagged read", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "get", "/data/export", id, "free", 31);
    expect(responses[30].status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// 2. 429 response schema
// ---------------------------------------------------------------------------

describe("429 response format", () => {
  test("body matches required schema", async () => {
    const id = makeId();
    await hitRoute(app, "post", "/ai/generate", id, "free", 5);
    const res = await request(app)
      .post("/ai/generate")
      .set("x-user-id", id)
      .set("x-user-tier", "free");

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "rate_limit_exceeded",
      limit: 5,
      window_seconds: WINDOW_SECONDS,
    });
    expect(typeof res.body.retry_after_seconds).toBe("number");
  });

  test("retry_after_seconds is never negative", async () => {
    const id = makeId();
    await hitRoute(app, "post", "/ai/generate", id, "free", 5);
    const res = await request(app)
      .post("/ai/generate")
      .set("x-user-id", id)
      .set("x-user-tier", "free");

    expect(res.body.retry_after_seconds).toBeGreaterThanOrEqual(0);
  });

  test("retry_after_seconds ≤ window_seconds", async () => {
    const id = makeId();
    await hitRoute(app, "post", "/ai/generate", id, "free", 5);
    const res = await request(app)
      .post("/ai/generate")
      .set("x-user-id", id)
      .set("x-user-tier", "free");

    expect(res.body.retry_after_seconds).toBeLessThanOrEqual(WINDOW_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// 3. Window reset
// ---------------------------------------------------------------------------

describe("Window reset", () => {
  test("counter resets after the window elapses (unit-level)", () => {
    // Simulate time travel by calling checkLimit with a fake clock
    const key = "test-window-reset-key";
    const limit = 5;
    const now = Date.now();

    // Exhaust the bucket
    for (let i = 0; i < 5; i++) {
      checkLimit(key, limit, now + i);
    }

    // Still blocked within the window
    const blocked = checkLimit(key, limit, now + 59_000);
    expect(blocked.allowed).toBe(false);

    // Allowed again once window has passed
    const afterWindow = checkLimit(key, limit, now + 60_000);
    expect(afterWindow.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("missing X-User-Tier header defaults to free tier (ai limit = 5)", async () => {
    const id = makeId();
    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(
        await request(app).post("/ai/generate").set("x-user-id", id)
        // No x-user-tier header
      );
    }
    for (let i = 0; i < 5; i++) {
      expect(responses[i].status).toBe(200);
    }
    expect(responses[5].status).toBe(429);
  });

  test("invalid X-User-Tier value defaults to free tier", async () => {
    const id = makeId();
    const responses = await hitRoute(app, "post", "/ai/generate", id, "enterprise", 6);
    expect(responses[5].status).toBe(429);
    expect(responses[5].body.limit).toBe(5); // free+ai limit
  });

  test("different users do not share buckets", async () => {
    const id1 = makeId();
    const id2 = makeId();

    // Exhaust id1
    await hitRoute(app, "post", "/ai/generate", id1, "free", 5);

    // id2 should still be allowed
    const res = await request(app)
      .post("/ai/generate")
      .set("x-user-id", id2)
      .set("x-user-tier", "free");
    expect(res.status).toBe(200);
  });

  test("free and paid tiers for the same user-id are tracked separately", async () => {
    const id = makeId();

    // Exhaust free ai bucket
    await hitRoute(app, "post", "/ai/generate", id, "free", 5);

    // Same user hitting paid should still be allowed (separate bucket)
    const res = await request(app)
      .post("/ai/generate")
      .set("x-user-id", id)
      .set("x-user-tier", "paid");
    expect(res.status).toBe(200);
  });

  test("ai and read buckets for the same user are independent", async () => {
    const id = makeId();

    // Exhaust free ai bucket
    await hitRoute(app, "post", "/ai/generate", id, "free", 5);

    // Read bucket for the same user should still be fresh
    const res = await request(app)
      .get("/data/list")
      .set("x-user-id", id)
      .set("x-user-tier", "free");
    expect(res.status).toBe(200);
  });

  test("successful route returns { ok: true }", async () => {
    const id = makeId();
    const res = await request(app)
      .post("/ai/generate")
      .set("x-user-id", id)
      .set("x-user-tier", "paid");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
