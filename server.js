"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const { buildSeed } = require("./data/seed");

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.CASHFLOW_PASSWORD || "";
// DATA_DIR lets a host point storage at a mounted persistent disk.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE = path.join(DATA_DIR, "store.json");

if (!PASSWORD) {
  console.warn(
    "\n  WARNING: CASHFLOW_PASSWORD is not set. The app is UNPROTECTED.\n" +
      "  Set a shared password before exposing this to the internet, e.g.\n" +
      "    CASHFLOW_PASSWORD='our-secret' npm start\n"
  );
}

// ---- Persistence (serialized read-modify-write, atomic file replace) ----
function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch (e) {
    const seed = buildSeed();
    save(seed);
    return seed;
  }
}

function save(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STORE); // atomic on the same filesystem
}

// Simple promise-chain mutex so concurrent saves don't interleave.
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Ensure the store exists on boot.
load();

// ---- App ----
const app = express();
app.use(express.json({ limit: "2mb" }));

// Auth: every /api call must carry the shared password as a Bearer token.
function auth(req, res, next) {
  if (!PASSWORD) return next(); // unprotected mode (dev only)
  const hdr = req.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (token === PASSWORD) return next();
  res.set("WWW-Authenticate", "Bearer");
  return res.status(401).json({ error: "Unauthorized" });
}

app.post("/api/login", (req, res) => {
  const pw = (req.body && req.body.password) || "";
  if (!PASSWORD || pw === PASSWORD) return res.json({ ok: true, protected: !!PASSWORD });
  res.status(401).json({ ok: false, error: "Wrong password" });
});

app.get("/api/state", auth, (req, res) => {
  res.json(load());
});

// Optimistic concurrency: client sends the version it edited from.
// If it still matches, we bump the version and persist; otherwise 409 with
// the current state so the client can re-apply its (idempotent) change.
app.put("/api/state", auth, (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming.version !== "number") {
    return res.status(400).json({ error: "Missing version" });
  }
  withLock(() => {
    const current = load();
    if (incoming.version !== current.version) {
      res.status(409).json({ error: "Version conflict", state: current });
      return;
    }
    const next = Object.assign({}, incoming, { version: current.version + 1 });
    save(next);
    res.json(next);
  }).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Save failed" });
  });
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Shared Cashflow running on http://localhost:${PORT}`);
});
