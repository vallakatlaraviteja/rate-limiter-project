const express = require("express");
const { tagRoute } = require("./routeTagger");

const app = express();
app.use(express.json());

// Rate limiting is applied per-route via tagRoute() middleware.
// tagRoute stamps the endpoint type and then invokes rateLimiterCheck,
// keeping the URL completely out of endpoint-type resolution.

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Rate Limiter API", version: "1.0" });
});

// AI / heavy endpoints
app.post("/ai/generate", tagRoute("ai"), (req, res) => {
  res.json({ ok: true });
});

app.post("/ai/summarise", tagRoute("ai"), (req, res) => {
  res.json({ ok: true });
});

// Read / light endpoints
app.get("/data/list", tagRoute("read"), (req, res) => {
  res.json({ ok: true });
});

app.get("/data/export", tagRoute("read"), (req, res) => {
  res.json({ ok: true });
});

module.exports = app;
