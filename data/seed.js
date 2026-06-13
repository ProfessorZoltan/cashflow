/*
 * Initial state seeded from the "March 2026" tab of the shared Google Sheet.
 *
 * Amounts, day-of-month, and frequencies were read directly from that tab's
 * configuration rows. Items with amount 0 in the sheet (Theo therapy, Church)
 * are seeded inactive so they're easy to turn back on. Edit anything in the
 * app's "Recurring Items" screen — this is only the starting point.
 */
function id(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 9);
}

const items = [
  // ---- Income ----
  { name: "Pay Day Eric", type: "income", frequency: "biweekly", amount: 3755, anchorDate: "2026-03-27", active: true },
  { name: "Pay Day Laura PDA", type: "income", frequency: "monthly", amount: 1800, dayOfMonth: 30, active: true },
  { name: "Pay Day Laura EC", type: "income", frequency: "weekly", amount: 858, dayOfWeek: 0, active: true },

  // ---- Expenses: monthly on a day of month ----
  { name: "Mortgage", type: "expense", frequency: "monthly", amount: 3927, dayOfMonth: 15, active: true },
  { name: "Propane", type: "expense", frequency: "monthly", amount: 278, dayOfMonth: 1, active: true },
  { name: "Laura Loan 1", type: "expense", frequency: "monthly", amount: 257, dayOfMonth: 1, active: true },
  { name: "Laura Loan 2", type: "expense", frequency: "monthly", amount: 256, dayOfMonth: 4, active: true },
  { name: "Eric Insurance", type: "expense", frequency: "monthly", amount: 24, dayOfMonth: 1, active: true },
  { name: "Home and Car Insurance", type: "expense", frequency: "monthly", amount: 240, dayOfMonth: 1, active: true },
  { name: "Horse lessons", type: "expense", frequency: "monthly", amount: 230, dayOfMonth: 1, active: true },
  { name: "Eric Loan", type: "expense", frequency: "monthly", amount: 406, dayOfMonth: 22, active: true },
  { name: "Wells Fargo", type: "expense", frequency: "monthly", amount: 120, dayOfMonth: 12, active: true },
  { name: "USBank", type: "expense", frequency: "monthly", amount: 120, dayOfMonth: 27, active: true },
  { name: "Water", type: "expense", frequency: "monthly", amount: 110, dayOfMonth: 24, active: true },
  { name: "Electricity and Internet", type: "expense", frequency: "monthly", amount: 250, dayOfMonth: 28, active: true },
  { name: "Guitar", type: "expense", frequency: "monthly", amount: 120, dayOfMonth: 7, active: true },
  { name: "Theo therapy", type: "expense", frequency: "monthly", amount: 0, dayOfMonth: 7, active: false },
  { name: "Church", type: "expense", frequency: "monthly", amount: 0, dayOfMonth: 10, active: false },

  // ---- Expenses: weekly ----
  { name: "Eric Therapy", type: "expense", frequency: "weekly", amount: 105, dayOfWeek: 2, active: true },

  // ---- Expenses: every other week ----
  { name: "Cleaning", type: "expense", frequency: "biweekly", amount: 180, anchorDate: "2026-03-23", active: true },

  // ---- Expenses: ongoing (monthly total, spread evenly per day) ----
  { name: "Groceries", type: "expense", frequency: "ongoing", amount: 1200, active: true },
  { name: "Gas", type: "expense", frequency: "ongoing", amount: 200, active: true },
  { name: "All Other Expenses", type: "expense", frequency: "ongoing", amount: 960, active: true },
  { name: "Laura Tax", type: "expense", frequency: "ongoing", amount: 625, active: true },
].map((it) => Object.assign({ id: id("item"), dayOfMonth: it.dayOfMonth || 1, dayOfWeek: it.dayOfWeek || 0, note: "" }, it));

function buildSeed() {
  return {
    version: 1,
    items,
    overrides: [],
    // A known balance anchor from the March tab's first projected day.
    // Set "today" to your real bank balance in the app to re-baseline.
    anchors: [
      { date: "2026-03-20", kind: "start", balance: 2000, by: "seed" },
    ],
    manual: [],
    meta: { seededFrom: "March 2026 tab", currency: "USD" },
  };
}

module.exports = { buildSeed };
