/**
 * server.js - Entry point
 * Starts the HTTP server on the configured port.
 */

"use strict";

const app = require("./src/app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Rate-limiter server running on port ${PORT}`);
});
