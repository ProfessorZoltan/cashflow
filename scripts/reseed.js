"use strict";
// Overwrite data/store.json with a fresh seed from the March 2026 tab.
// Use with care — this discards any edits made in the app.
const fs = require("fs");
const path = require("path");
const { buildSeed } = require("../data/seed");

const STORE = path.join(__dirname, "..", "data", "store.json");
fs.writeFileSync(STORE, JSON.stringify(buildSeed(), null, 2));
console.log("Reseeded", STORE);
