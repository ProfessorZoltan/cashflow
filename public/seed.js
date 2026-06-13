/*
 * Starting data from the "March 2026" tab of the shared Google Sheet.
 * Written to Firestore once, the first time the app opens on an empty database.
 * After that it's all editable in the app — this is only the starting point.
 *
 * Exposed as window.buildCashflowSeed() for the (module) app script.
 */
(function (root) {
  function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  var rawItems = [
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
  ];

  root.buildCashflowSeed = function () {
    var items = rawItems.map(function (it) {
      return Object.assign(
        { id: slug(it.name), dayOfMonth: it.dayOfMonth || 1, dayOfWeek: it.dayOfWeek || 0, anchorDate: it.anchorDate || "", note: "" },
        it
      );
    });
    return {
      items: items,
      // A known balance anchor from the March tab's first projected day.
      anchors: [{ id: "2026-03-20_start", date: "2026-03-20", kind: "start", balance: 2000, by: "seed" }],
      overrides: [],
      manual: [],
    };
  };
})(typeof self !== "undefined" ? self : this);
