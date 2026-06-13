/*
 * Cashflow projection engine.
 *
 * Works in the browser (window.CashflowEngine) and in Node (module.exports)
 * so the same logic can be unit-tested server-side and run client-side.
 *
 * Frequency types (matching the Google Sheet):
 *   - monthly   : charged once a month on `dayOfMonth` (clamped to month length)
 *   - weekly    : charged on every `dayOfWeek` (0=Sun .. 6=Sat)
 *   - biweekly  : charged every 14 days starting from `anchorDate`
 *   - ongoing   : spread evenly across the month -> amount/daysInMonth each day
 *
 * For monthly/weekly/biweekly, `amount` is the per-occurrence value.
 * For ongoing, `amount` is the MONTHLY total; the engine divides by the number
 * of days in that day's month so the spend is spread in equal daily amounts.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CashflowEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function iso(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function parseISO(s) {
    var p = s.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function addDays(d, n) {
    var x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function daysInMonth(d) {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  }
  function diffDays(a, b) {
    // whole-day difference, DST-safe
    var ms = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) -
             Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round(ms / 86400000);
  }
  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // Does a (non-ongoing) item land on date d? Returns true/false.
  function occursOn(item, d) {
    switch (item.frequency) {
      case "monthly": {
        var dim = daysInMonth(d);
        var target = Math.min(item.dayOfMonth || 1, dim);
        return d.getDate() === target;
      }
      case "weekly":
        return d.getDay() === Number(item.dayOfWeek);
      case "biweekly": {
        if (!item.anchorDate) return false;
        var diff = diffDays(d, parseISO(item.anchorDate));
        return diff >= 0 && diff % 14 === 0;
      }
      case "ongoing":
        return true; // every day
      default:
        return false;
    }
  }

  // Build, for each item, its overrides sorted by fromDate, plus a live counter.
  function buildOverrideState(state) {
    var byItem = {};
    (state.overrides || []).forEach(function (ov) {
      if (!ov.amounts || !ov.amounts.length) return;
      (byItem[ov.itemId] = byItem[ov.itemId] || []).push(ov);
    });
    Object.keys(byItem).forEach(function (k) {
      byItem[k].sort(function (a, b) {
        return a.fromDate < b.fromDate ? -1 : a.fromDate > b.fromDate ? 1 : 0;
      });
    });
    return { byItem: byItem, consumed: {} };
  }

  // Returns { amount, isOverride } for one occurrence of an item on date d.
  function occurrenceValue(item, d, ovState) {
    var list = ovState.byItem[item.id];
    if (list) {
      var dISO = iso(d);
      for (var i = 0; i < list.length; i++) {
        var ov = list[i];
        var used = ovState.consumed[ov.id] || 0;
        if (dISO >= ov.fromDate && used < ov.amounts.length) {
          ovState.consumed[ov.id] = used + 1;
          return { amount: Number(ov.amounts[used]), isOverride: true };
        }
      }
    }
    return { amount: Number(item.amount) || 0, isOverride: false };
  }

  // Signed daily contribution of an item on date d (income +, expense -).
  // Also advances the override counter when an occurrence happens.
  function itemContribution(item, d, ovState) {
    if (item.active === false) return null;
    if (!occursOn(item, d)) return null;
    var ov = occurrenceValue(item, d, ovState);
    var value;
    if (item.frequency === "ongoing") {
      value = ov.isOverride ? ov.amount : ov.amount / daysInMonth(d);
    } else {
      value = ov.amount;
    }
    var signed = item.type === "income" ? value : -value;
    return { name: item.name, type: item.type, amount: round2(signed), isOverride: ov.isOverride };
  }

  /*
   * Project balances day-by-day across [fromISO, toISO] inclusive.
   * Returns an array of row objects:
   *   { date, dow, start, income, expense, net, end, lines:[...], anchoredStart, anchoredEnd }
   */
  function project(state, fromISO, toISO) {
    var anchorStart = {}, anchorEnd = {};
    (state.anchors || []).forEach(function (a) {
      if (a.kind === "end") anchorEnd[a.date] = Number(a.balance);
      else anchorStart[a.date] = Number(a.balance);
    });

    var manualByDate = {};
    (state.manual || []).forEach(function (m) {
      (manualByDate[m.date] = manualByDate[m.date] || []).push(m);
    });

    var ovState = buildOverrideState(state);
    var items = state.items || [];

    var rows = [];
    var prevEnd = null;
    var cur = parseISO(fromISO);
    var end = parseISO(toISO);

    while (cur <= end) {
      var dISO = iso(cur);
      var lines = [];
      var income = 0, expense = 0;

      // Recurring items (iterate in stored order so override counters advance
      // deterministically across the whole window).
      for (var i = 0; i < items.length; i++) {
        var c = itemContribution(items[i], cur, ovState);
        if (!c || c.amount === 0) continue;
        lines.push(c);
        if (c.amount >= 0) income += c.amount;
        else expense += c.amount;
      }

      // One-off manual entries
      (manualByDate[dISO] || []).forEach(function (m) {
        var amt = m.type === "income" ? Math.abs(Number(m.amount)) : -Math.abs(Number(m.amount));
        lines.push({ name: m.label || (m.type === "income" ? "Misc income" : "Misc expense"), type: m.type, amount: round2(amt), manual: true, id: m.id });
        if (amt >= 0) income += amt; else expense += amt;
      });

      var net = round2(income + expense);

      var start;
      if (dISO in anchorStart) start = anchorStart[dISO];
      else if (prevEnd !== null) start = prevEnd;
      else if (dISO in anchorEnd) start = round2(anchorEnd[dISO] - net);
      else start = 0;

      var endBal = dISO in anchorEnd ? anchorEnd[dISO] : round2(start + net);

      rows.push({
        date: dISO,
        dow: cur.getDay(),
        start: round2(start),
        income: round2(income),
        expense: round2(expense),
        net: net,
        end: round2(endBal),
        lines: lines,
        anchoredStart: dISO in anchorStart,
        anchoredEnd: dISO in anchorEnd,
      });

      prevEnd = endBal;
      cur = addDays(cur, 1);
    }
    return rows;
  }

  // Human description of an item's schedule.
  function describe(item) {
    var dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    switch (item.frequency) {
      case "monthly": return "Monthly on day " + (item.dayOfMonth || 1);
      case "weekly": return "Weekly on " + dows[Number(item.dayOfWeek) || 0];
      case "biweekly": return "Every 2 weeks from " + (item.anchorDate || "?");
      case "ongoing": return "Ongoing (spread daily across the month)";
      default: return item.frequency;
    }
  }

  return {
    project: project,
    describe: describe,
    occursOn: occursOn,
    iso: iso,
    parseISO: parseISO,
    addDays: addDays,
    daysInMonth: daysInMonth,
    round2: round2,
  };
});
