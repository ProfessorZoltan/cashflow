import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, getDoc, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig, ALLOWED_EMAILS } from "./firebase-config.js";

const E = window.CashflowEngine;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---- Firebase init ----
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
setPersistence(auth, browserLocalPersistence).catch(() => {});

// ---- Shared state, kept live by Firestore listeners ----
const data = { items: [], overrides: [], anchors: [], manual: [], dayOverrides: [] };
let me = { name: "", email: "" };
let openDetails = {};
let showPast = localStorage.getItem("cf_showPast") === "1";
let view = localStorage.getItem("cf_view") || "combined"; // "combined" | "eric" | "laura"

// ---- Ownership ----
// Income: "Pay Day Eric" -> Eric; all other income -> Laura.
// Expenses whose name contains a person's name -> that person; the rest use the
// agreed flexible allocation; anything unrecognized falls back to Eric (visible
// and reassignable in the Recurring tab).
const OWNER_ALLOC = {
  "mortgage": "eric", "all other expenses": "eric", "propane": "eric",
  "gas": "eric", "water": "eric", "guitar": "eric", "church": "eric",
  "groceries": "laura", "cleaning": "laura", "electricity and internet": "laura",
  "home and car insurance": "laura", "horse lessons": "laura",
  "usbank": "laura", "wells fargo": "laura", "theo therapy": "laura",
};
function computeOwner(item) {
  const n = (item.name || "").toLowerCase().trim().replace(/\s+/g, " ");
  if (item.type === "income") return n.includes("eric") ? "eric" : "laura";
  if (n.includes("eric")) return "eric";
  if (n.includes("laura")) return "laura";
  return OWNER_ALLOC[n] || "eric";
}
function ownerLabel(o) { return o === "eric" ? "Eric" : o === "laura" ? "Laura" : "Combined"; }
let unsub = [];
let renderQueued = false;

function todayISO() { return E.iso(new Date()); }

// ===================== AUTH =====================
onAuthStateChanged(auth, async (user) => {
  if (!user) return showLogin();
  if (!ALLOWED_EMAILS.includes((user.email || "").toLowerCase())) {
    showLogin(`${user.email} isn't on the allowed list. Ask to be added, or sign in with the right account.`);
    await signOut(auth);
    return;
  }
  me = { name: user.displayName || user.email, email: user.email };
  await enterApp();
});

$("#googleBtn").addEventListener("click", async () => {
  $("#loginError").textContent = "";
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    if (e && e.code === "auth/popup-blocked") {
      $("#loginError").textContent = "Your browser blocked the sign-in popup. Allow popups and try again.";
    } else if (e && e.code !== "auth/cancelled-popup-request" && e.code !== "auth/popup-closed-by-user") {
      $("#loginError").textContent = "Sign-in failed. Please try again.";
      console.error(e);
    }
  }
});

$("#signoutBtn").addEventListener("click", async () => {
  await signOut(auth);
});

function showLogin(msg) {
  stopListeners();
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  if (msg) $("#loginError").textContent = msg;
}

async function enterApp() {
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#whoLabel").textContent = me.name;
  updateScope();
  await seedIfEmpty();
  startListeners();
  setTimeout(scrollToToday, 200);
}

// ===================== FIRESTORE SYNC =====================
const COLLECTIONS = ["items", "overrides", "anchors", "manual", "dayOverrides"];

function startListeners() {
  stopListeners();
  setSync("ok");
  COLLECTIONS.forEach((name) => {
    const u = onSnapshot(
      collection(db, name),
      (snap) => {
        data[name] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
        if (name === "items") autoTagOwners();
        scheduleRender();
        setSync(snap.metadata.hasPendingWrites ? "saving" : "ok");
      },
      (err) => { console.error(err); setSync("err"); }
    );
    unsub.push(u);
  });
}
function stopListeners() { unsub.forEach((u) => u()); unsub = []; }

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// Write the March 2026 starting data once, on an empty database. A transaction
// guards against both people seeding at the same time; stable IDs make it
// idempotent regardless.
async function seedIfEmpty() {
  try {
    const metaRef = doc(db, "meta", "app");
    const seed = window.buildCashflowSeed();
    await runTransaction(db, async (tx) => {
      const m = await tx.get(metaRef);
      if (m.exists() && m.data().initialized) return;
      tx.set(metaRef, { initialized: true, seededFrom: "March 2026 tab", seededAt: Date.now() });
      seed.items.forEach((it) => tx.set(doc(db, "items", it.id), it));
      seed.anchors.forEach((a) => tx.set(doc(db, "anchors", a.id), a));
    });
  } catch (e) {
    console.error("Seed skipped:", e);
  }
}

// One-time, non-destructive migration: give every existing item an `owner`
// without touching its amount or any other field. Runs on load until all items
// are tagged; idempotent if both people run it at once (same computed owner).
function autoTagOwners() {
  (data.items || []).forEach((it) => {
    if (it.owner === "eric" || it.owner === "laura") return;
    setDoc(doc(db, "items", it.id), { owner: computeOwner(it) }, { merge: true }).catch(failSave);
  });
}

// Build a filtered slice of the data for the active scope. Combined = the whole
// household (all items, plus the legacy/combined-owned balance anchors & one-offs).
// Eric/Laura = only their items, anchors, and one-offs. Overrides & day-overrides
// reference items, so the engine naturally ignores the other person's.
function viewState() {
  if (view === "combined") {
    return {
      items: data.items,
      overrides: data.overrides,
      dayOverrides: data.dayOverrides,
      manual: data.manual,
      anchors: data.anchors.filter((a) => (a.owner || "combined") === "combined"),
    };
  }
  return {
    items: data.items.filter((i) => i.owner === view),
    overrides: data.overrides,
    dayOverrides: data.dayOverrides,
    manual: data.manual.filter((m) => m.owner === view),
    anchors: data.anchors.filter((a) => a.owner === view),
  };
}

function setSync(s) {
  const dot = $("#syncDot");
  if (!dot) return;
  dot.className = "dot" + (s === "saving" ? " saving" : s === "err" ? " err" : "");
  dot.title = s === "saving" ? "Saving…" : s === "err" ? "Connection problem" : "Synced live";
}

// ===================== MUTATIONS (direct Firestore writes) =====================
function uid(p) { return p + "_" + Math.random().toString(36).slice(2, 9); }

// Anchors are per-scope: combined keeps the legacy `date_kind` id (so existing
// household anchors keep working) while Eric/Laura get their own `owner_date_kind`.
function anchorId(date, kind) {
  return view === "combined" ? `${date}_${kind}` : `${view}_${date}_${kind}`;
}
function setAnchor(date, kind, balance) {
  setDoc(doc(db, "anchors", anchorId(date, kind)), { date, kind, balance, owner: view, by: me.name }).catch(failSave);
}
function clearAnchor(date, kind) {
  deleteDoc(doc(db, "anchors", anchorId(date, kind))).catch(failSave);
}
function saveItem(item) { setDoc(doc(db, "items", item.id), item).catch(failSave); }
function deleteItem(id) { deleteDoc(doc(db, "items", id)).catch(failSave); }
function saveOverride(ov) { setDoc(doc(db, "overrides", ov.id), ov).catch(failSave); }
function deleteOverride(id) { deleteDoc(doc(db, "overrides", id)).catch(failSave); }
function saveManual(m) { setDoc(doc(db, "manual", m.id), m).catch(failSave); }
function deleteManual(id) { deleteDoc(doc(db, "manual", id)).catch(failSave); }
// Per-day, single-occurrence override of one item's amount (does not affect
// any other day). Deterministic id so re-editing the same day upserts.
function dayOvId(itemId, date) { return `${itemId}__${date}`; }
function setDayOverride(itemId, date, amount) {
  const id = dayOvId(itemId, date);
  setDoc(doc(db, "dayOverrides", id), { id, itemId, date, amount, by: me.name }).catch(failSave);
}
function clearDayOverride(itemId, date) {
  deleteDoc(doc(db, "dayOverrides", dayOvId(itemId, date))).catch(failSave);
}
function failSave(e) { console.error(e); setSync("err"); }

// ===================== TABS =====================
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    ["calendar", "items", "overrides", "graph", "withdraw"].forEach((name) =>
      $(`#tab-${name}`).classList.toggle("hidden", name !== t.dataset.tab)
    );
    if (t.dataset.tab === "graph") renderGraph();
    if (t.dataset.tab === "withdraw" && $("#wdAmount").value.trim()) computeWithdraw();
  })
);
$$(".scope").forEach((b) =>
  b.addEventListener("click", () => {
    view = b.dataset.scope;
    localStorage.setItem("cf_view", view);
    updateScope();
    render();
    if ($("#wdAmount").value.trim()) computeWithdraw();
  })
);
function updateScope() {
  $$(".scope").forEach((x) => x.classList.toggle("active", x.dataset.scope === view));
}
$("#wdGo").addEventListener("click", computeWithdraw);
$("#wdAmount").addEventListener("keydown", (e) => { if (e.key === "Enter") computeWithdraw(); });
$("#horizon").addEventListener("change", render);
$("#togglePast").addEventListener("click", () => {
  showPast = !showPast;
  localStorage.setItem("cf_showPast", showPast ? "1" : "0");
  renderCalendar();
  if (!showPast) setTimeout(scrollToToday, 30);
});
$("#graphHorizon").addEventListener("change", renderGraph);
let _grResize;
window.addEventListener("resize", () => { clearTimeout(_grResize); _grResize = setTimeout(renderGraph, 150); });
$("#todayBtn").addEventListener("click", scrollToToday);
$("#addItemBtn").addEventListener("click", () => openItemModal(null));
$("#addOverrideBtn").addEventListener("click", () => openOverrideModal(null));

// ===================== RENDER =====================
function fmt(n) {
  const v = Math.round(n);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString();
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function projectionRange(anchors) {
  const horizon = parseInt($("#horizon").value, 10);
  const today = new Date();
  let earliest = today;
  (anchors || []).forEach((a) => { const d = E.parseISO(a.date); if (d < earliest) earliest = d; });
  const minStart = E.addDays(today, -30);
  const start = earliest > minStart ? earliest : minStart;
  return { fromISO: E.iso(start), toISO: E.iso(E.addDays(today, horizon)) };
}

function render() {
  renderCalendar();
  renderItems();
  renderOverrides();
  renderGraph();
}

function renderCalendar() {
  updatePastBtn();
  const vs = viewState();
  const { fromISO, toISO } = projectionRange(vs.anchors);
  const allRows = E.project(vs, fromISO, toISO);
  const tISO = todayISO();
  // Always project from the earliest balance so the running total is correct,
  // but hide days before today unless the user opts to show them.
  const rows = showPast ? allRows : allRows.filter((r) => r.date >= tISO);
  const body = $("#calBody");
  body.innerHTML = "";
  let firstNeg = null;
  const frag = document.createDocumentFragment();

  rows.forEach((r) => {
    const d = E.parseISO(r.date);
    const isToday = r.date === tISO;
    const weekend = r.dow === 0 || r.dow === 6;
    if (firstNeg === null && r.end < 0 && r.date >= tISO) firstNeg = r;

    const tr = document.createElement("tr");
    tr.className = (isToday ? "row-today " : "") + (weekend ? "row-weekend " : "") + (r.end < 0 ? "row-neg" : "");
    tr.id = "row-" + r.date;

    const tdDate = document.createElement("td");
    tdDate.className = "c-date";
    tdDate.innerHTML =
      `<div class="datecell"><div class="d-main">${MON[d.getMonth()]} ${d.getDate()}` +
      (isToday ? `<span class="todaytag">TODAY</span>` : "") +
      `</div><div class="d-sub">${DOW[r.dow]}</div></div>`;
    tr.appendChild(tdDate);

    tr.appendChild(balCell(r, "start"));

    const tdIn = document.createElement("td");
    tdIn.className = "c-num num pos";
    tdIn.textContent = r.income ? fmt(r.income) : "";
    tr.appendChild(tdIn);

    const tdOut = document.createElement("td");
    tdOut.className = "c-num num out-total";
    tdOut.textContent = r.expense ? fmt(r.expense) : "";
    tr.appendChild(tdOut);

    tr.appendChild(balCell(r, "end"));

    const tdDet = document.createElement("td");
    tdDet.className = "c-det";
    const btn = document.createElement("button");
    btn.className = "det-btn";
    btn.textContent = openDetails[r.date] ? "▾" : "›";
    btn.title = "Show what happens this day";
    btn.addEventListener("click", () => { openDetails[r.date] = !openDetails[r.date]; renderCalendar(); });
    tdDet.appendChild(btn);
    tr.appendChild(tdDet);

    frag.appendChild(tr);
    if (openDetails[r.date]) frag.appendChild(detailRow(r));
  });

  body.appendChild(frag);

  const warn = $("#lowWarn");
  if (firstNeg) {
    const d = E.parseISO(firstNeg.date);
    warn.classList.remove("hidden");
    warn.textContent = `⚠ Balance goes negative on ${MON[d.getMonth()]} ${d.getDate()} (${fmt(firstNeg.end)})`;
  } else {
    warn.classList.add("hidden");
  }
}

function balCell(r, kind) {
  const td = document.createElement("td");
  const val = kind === "start" ? r.start : r.end;
  const anchored = kind === "start" ? r.anchoredStart : r.anchoredEnd;
  // Flag start balances that fall below $1,000 (covers negatives too).
  const low = kind === "start" && val < LOW_THRESHOLD;
  const neg = kind === "end" && val < 0;
  td.className = "c-bal" + (low ? " bal-low" : "");
  const wrap = document.createElement("div");
  wrap.className = "balcell";
  const input = document.createElement("input");
  input.className = "editbal num" + (anchored ? " anchored" : "") + (low ? " low" : "") + (neg ? " c-bal-val neg" : "");
  input.value = Math.round(val);
  input.inputMode = "numeric";
  input.title = anchored ? "Known balance — change it, or clear the box to remove." : "Click to set the real bank balance for this day";
  input.addEventListener("focus", () => input.select());
  input.addEventListener("change", () => {
    const raw = input.value.trim().replace(/[$,\s]/g, "");
    if (raw === "") { clearAnchor(r.date, kind); return; }
    const num = Number(raw);
    if (Number.isNaN(num)) { render(); return; }
    setAnchor(r.date, kind, num);
  });
  wrap.appendChild(input);
  if (anchored) {
    const m = document.createElement("span");
    m.className = "anchormark";
    m.textContent = "●";
    m.title = "Known balance (anchored)";
    wrap.appendChild(m);
  }
  td.appendChild(wrap);
  return td;
}

function detailRow(r) {
  const tr = document.createElement("tr");
  tr.className = "det-row";
  const td = document.createElement("td");
  td.colSpan = 6;
  const list = document.createElement("div");
  list.className = "det-list";
  if (!r.lines.length) {
    const e = document.createElement("div");
    e.className = "det-line muted";
    e.textContent = "Nothing scheduled.";
    list.appendChild(e);
  }
  r.lines.forEach((ln) => {
    const row = document.createElement("div");
    row.className = "det-line";
    const left = document.createElement("span");
    left.innerHTML = escapeHTML(ln.name) + (ln.isOverride && !ln.dayOverridden ? `<span class="ov">(override)</span>` : "");
    row.appendChild(left);

    const right = document.createElement("span");
    right.className = "det-amt";

    if (ln.manual) {
      // One-off entries: show amount + remove button.
      const amt = document.createElement("span");
      amt.className = ln.amount >= 0 ? "pos num" : "neg num";
      amt.textContent = fmt(ln.amount);
      right.appendChild(amt);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.className = "det-revert";
      del.title = "Remove this one-off entry";
      del.addEventListener("click", () => deleteManual(ln.id));
      right.appendChild(del);
    } else {
      // Recurring occurrence: edit just this day's amount in place.
      const sign = document.createElement("span");
      sign.className = "det-sign " + (ln.type === "income" ? "pos" : "neg");
      sign.textContent = ln.type === "income" ? "+$" : "−$";
      const input = document.createElement("input");
      input.className = "det-edit num " + (ln.type === "income" ? "pos" : "neg") + (ln.dayOverridden ? " ov-edit" : "");
      input.inputMode = "decimal";
      input.value = Math.round(Math.abs(ln.amount));
      input.title = "Edit only this day's amount — other days are unchanged. Clear to revert.";
      input.addEventListener("focus", () => input.select());
      input.addEventListener("change", () => {
        const raw = input.value.trim().replace(/[$,\s]/g, "");
        if (raw === "") { ln.dayOverridden ? clearDayOverride(ln.itemId, r.date) : renderCalendar(); return; }
        const v = Math.abs(Number(raw));
        if (Number.isNaN(v)) { renderCalendar(); return; }
        setDayOverride(ln.itemId, r.date, v);
      });
      right.appendChild(sign);
      right.appendChild(input);
      if (ln.dayOverridden) {
        const rev = document.createElement("button");
        rev.className = "det-revert";
        rev.textContent = "↺";
        rev.title = "Revert to the usual amount";
        rev.addEventListener("click", () => clearDayOverride(ln.itemId, r.date));
        right.appendChild(rev);
      }
    }

    row.appendChild(right);
    list.appendChild(row);
  });
  const add = document.createElement("div");
  add.className = "det-add";
  const inc = document.createElement("button");
  inc.textContent = "+ one-off income";
  inc.addEventListener("click", () => openManualModal(r.date, "income"));
  const exp = document.createElement("button");
  exp.textContent = "+ one-off expense";
  exp.addEventListener("click", () => openManualModal(r.date, "expense"));
  add.appendChild(inc);
  add.appendChild(exp);
  list.appendChild(add);
  td.appendChild(list);
  tr.appendChild(td);
  return tr;
}

function scrollToToday() {
  const el = $("#row-" + todayISO());
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updatePastBtn() {
  const b = $("#togglePast");
  if (b) b.textContent = showPast ? "Hide past days" : "Show past days";
}

function renderItems() {
  const wrap = $("#itemsList");
  wrap.innerHTML = "";
  let items = data.items.slice();
  if (view !== "combined") items = items.filter((i) => i.owner === view);
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "income" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  if (!items.length) {
    wrap.innerHTML = `<p class="muted pad">No items in this account yet.</p>`;
    return;
  }
  items.forEach((it) => {
    const owner = it.owner === "eric" || it.owner === "laura" ? it.owner : computeOwner(it);
    const other = owner === "eric" ? "laura" : "eric";
    const card = document.createElement("div");
    card.className = "card" + (it.active === false ? " inactive" : "");
    card.innerHTML =
      `<div class="card-head"><span class="nm">${escapeHTML(it.name)}</span>` +
      `<span class="tag owner ${owner}">${ownerLabel(owner)}</span>` +
      `<span class="tag ${it.type}">${it.type}</span></div>` +
      `<div class="card-sub">${escapeHTML(E.describe(it))}</div>` +
      `<div class="card-amt ${it.type === "income" ? "pos" : "neg"}">` +
      (it.frequency === "ongoing" ? `${fmt(it.amount)}/mo` : `${fmt(it.amount)}`) +
      `</div>`;
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.appendChild(mkBtn("Edit", () => openItemModal(it.id)));
    actions.appendChild(mkBtn("→ " + ownerLabel(other), () => saveItem(Object.assign({}, it, { owner: other }))));
    actions.appendChild(mkBtn("Override next…", () => openOverrideModal(null, it.id)));
    actions.appendChild(mkBtn(it.active === false ? "Activate" : "Pause", () =>
      saveItem(Object.assign({}, it, { active: !(it.active !== false) }))
    ));
    actions.appendChild(mkBtn("Delete", () => { if (confirm(`Delete "${it.name}"?`)) deleteItem(it.id); }, "danger"));
    card.appendChild(actions);
    wrap.appendChild(card);
  });
}

function mkBtn(label, fn, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", fn);
  return b;
}

function renderOverrides() {
  const wrap = $("#overridesList");
  wrap.innerHTML = "";
  const ovs = data.overrides
    .filter((o) => {
      const it = data.items.find((i) => i.id === o.itemId);
      return it && (view === "combined" || it.owner === view);
    })
    .sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1));
  if (!ovs.length) { wrap.innerHTML = `<p class="muted pad">No overrides yet.</p>`; return; }
  ovs.forEach((ov) => {
    const it = data.items.find((i) => i.id === ov.itemId);
    const card = document.createElement("div");
    card.className = "card";
    const amts = ov.amounts.map((a) => fmt(a)).join(", ");
    card.innerHTML =
      `<div class="card-head"><span class="nm">${it ? escapeHTML(it.name) : "(deleted item)"}</span>` +
      `<span class="tag ${it ? it.type : ""}">${ov.amounts.length} instance${ov.amounts.length > 1 ? "s" : ""}</span></div>` +
      `<div class="card-sub">From ${ov.fromDate} — amounts: ${amts}</div>`;
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.appendChild(mkBtn("Edit", () => openOverrideModal(ov.id)));
    actions.appendChild(mkBtn("Delete", () => deleteOverride(ov.id), "danger"));
    card.appendChild(actions);
    wrap.appendChild(card);
  });
}

// ===================== BALANCE GRAPH =====================
const LOW_THRESHOLD = 1000;

function renderGraph() {
  const wrap = $("#graphWrap");
  if (!wrap) return;
  const W = Math.round(wrap.clientWidth);
  if (W < 80) return; // panel not visible yet; will draw when opened/resized

  const horizon = parseInt($("#graphHorizon").value, 10) || 180;
  const today = new Date();

  // Project from the earliest known balance so the running total is carried
  // forward correctly, then display from a week before today onward.
  const vs = viewState();
  let earliest = null;
  vs.anchors.forEach((a) => { const d = E.parseISO(a.date); if (!earliest || d < earliest) earliest = d; });
  const projStart = earliest && earliest < today ? earliest : E.addDays(today, -7);
  const allRows = E.project(vs, E.iso(projStart), E.iso(E.addDays(today, horizon)));
  const displayStart = E.iso(E.addDays(today, -7));
  const rows = allRows.filter((r) => r.date >= displayStart);
  if (rows.length < 2) { wrap.innerHTML = `<p class="muted">Not enough data to chart yet.</p>`; return; }

  const vals = rows.map((r) => r.end);
  const n = rows.length;
  const H = 280, padL = 58, padR = 14, padT = 16, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const actualMax = Math.max(...vals);
  const actualMin = Math.min(...vals);
  let maxV = Math.max(actualMax, LOW_THRESHOLD);
  let minV = Math.min(actualMin, 0);
  const span = (maxV - minV) || 1;
  maxV += span * 0.06;
  minV -= span * 0.04;
  const range = maxV - minV;

  const x = (i) => padL + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v) => padT + ((maxV - v) / range) * plotH;
  const baseY = padT + plotH;

  const linePts = rows.map((r, i) => `${x(i).toFixed(1)},${y(r.end).toFixed(1)}`).join(" ");
  const areaPath =
    `M ${x(0).toFixed(1)},${baseY.toFixed(1)} ` +
    rows.map((r, i) => `L ${x(i).toFixed(1)},${y(r.end).toFixed(1)}`).join(" ") +
    ` L ${x(n - 1).toFixed(1)},${baseY.toFixed(1)} Z`;

  // Red regions where balance is below the threshold (clipped to the area).
  const redRects = [];
  let i = 0;
  while (i < n) {
    if (vals[i] < LOW_THRESHOLD) {
      let j = i;
      while (j + 1 < n && vals[j + 1] < LOW_THRESHOLD) j++;
      const x0 = x(i) - (i > 0 ? (x(i) - x(i - 1)) / 2 : 0);
      const x1 = x(j) + (j < n - 1 ? (x(j + 1) - x(j)) / 2 : 0);
      redRects.push(`<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(0, x1 - x0).toFixed(1)}" height="${plotH}" fill="#f87171" fill-opacity="0.5"/>`);
      i = j + 1;
    } else i++;
  }

  const yThresh = y(LOW_THRESHOLD).toFixed(1);
  const yZero = minV <= 0 && maxV >= 0 ? y(0).toFixed(1) : null;
  const todayIdx = rows.findIndex((r) => r.date === todayISO());
  const todayX = todayIdx >= 0 ? x(todayIdx).toFixed(1) : null;
  const axis = (v) => (v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toLocaleString();
  const xLabel = (i) => { const d = E.parseISO(rows[i].date); return `${MON[d.getMonth()]} ${d.getDate()}`; };

  wrap.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Balance over time">
    <defs><clipPath id="areaClip"><path d="${areaPath}"/></clipPath></defs>
    <path d="${areaPath}" fill="#34d399" fill-opacity="0.28"/>
    <g clip-path="url(#areaClip)">${redRects.join("")}</g>
    ${yZero ? `<line x1="${padL}" y1="${yZero}" x2="${W - padR}" y2="${yZero}" stroke="#64748b" stroke-width="1" opacity="0.45"/>` : ""}
    <line x1="${padL}" y1="${yThresh}" x2="${W - padR}" y2="${yThresh}" stroke="#f87171" stroke-width="1" stroke-dasharray="5 4" opacity="0.85"/>
    <polyline points="${linePts}" fill="none" stroke="#10b981" stroke-width="2" stroke-linejoin="round"/>
    ${todayX ? `<line x1="${todayX}" y1="${padT}" x2="${todayX}" y2="${baseY}" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="${todayX}" y="${padT - 4}" text-anchor="middle" fill="#38bdf8" font-size="10">today</text>` : ""}
    <text x="${padL - 6}" y="${y(actualMax).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="11">${axis(actualMax)}</text>
    <text x="${padL - 6}" y="${(Number(yThresh)).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#f87171" font-size="11">$1k</text>
    <text x="${padL - 6}" y="${y(actualMin).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#94a3b8" font-size="11">${axis(actualMin)}</text>
    <text x="${x(0).toFixed(1)}" y="${H - 8}" text-anchor="start" fill="#94a3b8" font-size="11">${xLabel(0)}</text>
    <text x="${x(n - 1).toFixed(1)}" y="${H - 8}" text-anchor="end" fill="#94a3b8" font-size="11">${xLabel(n - 1)}</text>
  </svg>`;

  // Summary stats
  let minRow = rows[0];
  rows.forEach((r) => { if (r.end < minRow.end) minRow = r; });
  const md = E.parseISO(minRow.date);
  const last = rows[n - 1];
  $("#graphStats").innerHTML =
    statCard("Lowest balance ahead", fmt(minRow.end), `${MON[md.getMonth()]} ${md.getDate()}`, minRow.end < LOW_THRESHOLD) +
    statCard(`In ${horizon} days`, fmt(last.end), xLabel(n - 1), last.end < LOW_THRESHOLD);
}

function statCard(lbl, val, sub, danger) {
  return `<div class="graph-stat"><div class="lbl">${lbl}</div>` +
    `<div class="val ${danger ? "neg" : "pos"}">${val}</div>` +
    `<div class="lbl">${sub || ""}</div></div>`;
}

// ===================== WITHDRAW PLANNER =====================
// safe: stays >= $1,000 · caution: dips below $1,000 but stays >= 0 · danger: goes negative
function statusOf(v) { return v >= LOW_THRESHOLD ? "safe" : v >= 0 ? "caution" : "danger"; }
const STATUS_COLOR = { safe: "var(--green)", caution: "var(--orange)", danger: "var(--red)" };

function computeWithdraw() {
  const out = $("#wdResult");
  const X = Math.abs(Number(($("#wdAmount").value || "").replace(/[$,\s]/g, "")));
  if (!X || Number.isNaN(X)) { out.innerHTML = `<p class="muted">Enter an amount, then tap “Find best day.”</p>`; return; }

  const today = new Date();
  const tISO = todayISO();
  // Project from the earliest balance (correct carry), out far enough that a
  // late-window withdrawal still has a full cycle of bills to be tested against.
  const vs = viewState();
  let earliest = null;
  vs.anchors.forEach((a) => { const d = E.parseISO(a.date); if (!earliest || d < earliest) earliest = d; });
  const projStart = earliest && earliest < today ? earliest : today;
  const rows = E.project(vs, E.iso(projStart), E.iso(E.addDays(today, 45)));
  const win = rows.filter((r) => r.date >= tISO);
  if (win.length < 2) { out.innerHTML = `<p class="muted">Not enough projection data yet.</p>`; return; }

  const lastCand = E.iso(E.addDays(today, 30));
  const candidates = win.filter((r) => r.date <= lastCand);

  // Removing X on day D lowers every balance from D onward by X. For each D,
  // find the lowest balance from D forward (the cushion the withdrawal leaves).
  const evals = candidates.map((c) => {
    let minAfter = Infinity, minDate = c.date;
    for (const r of win) {
      if (r.date < c.date) continue;
      const b = r.end - X;
      if (b < minAfter) { minAfter = b; minDate = r.date; }
    }
    return { date: c.date, balAfter: c.end - X, minAfter, minDate };
  });

  // Best = the day that leaves the highest cushion; earliest wins ties.
  let best = evals[0];
  for (const e of evals) if (e.minAfter > best.minAfter + 0.005) best = e;

  // The earliest day that's still safe is often the more actionable answer.
  const dlabel = (iso) => { const d = E.parseISO(iso); return `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`; };
  const firstSafe = evals.find((e) => e.minAfter >= LOW_THRESHOLD);
  const firstPositive = evals.find((e) => e.minAfter >= 0);
  let earliestLine = "";
  if (firstSafe && firstSafe.date !== best.date) earliestLine = `Earliest fully-safe day: <strong>${dlabel(firstSafe.date)}</strong>`;
  else if (!firstSafe && firstPositive) earliestLine = `Earliest day you stay positive: <strong>${dlabel(firstPositive.date)}</strong>`;

  const st = statusOf(best.minAfter);
  const bd = E.parseISO(best.date);
  const md = E.parseISO(best.minDate);
  const dayLabel = `${DOW[bd.getDay()]} ${MON[bd.getMonth()]} ${bd.getDate()}`;
  const lowWhen = `${MON[md.getMonth()]} ${md.getDate()}`;
  const msg =
    st === "safe" ? `Safe — your balance stays above $1,000 the whole time.` :
    st === "caution" ? `Doable, but afterward the balance dips to ${fmt(best.minAfter)} (below $1,000) around ${lowWhen}.` :
    `⚠ No day in the next 30 keeps you positive — removing ${fmt(X)} would overdraw to ${fmt(best.minAfter)} around ${lowWhen}.`;

  const listRows = evals.map((e) => {
    const d = E.parseISO(e.date);
    const s = statusOf(e.minAfter);
    const isBest = e.date === best.date;
    return `<div class="wd-row${isBest ? " best" : ""}">` +
      `<span>${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}${isBest ? ' <span class="ov">best</span>' : ""}</span>` +
      `<span class="num">${fmt(e.balAfter)}</span>` +
      `<span class="num" style="color:${STATUS_COLOR[s]}">${fmt(e.minAfter)}</span>` +
      `<span class="wd-dot" style="background:${STATUS_COLOR[s]}"></span>` +
      `</div>`;
  }).join("");

  out.innerHTML =
    `<div class="wd-headline ${st}">` +
      `<div class="wd-hl-label">Best day to remove ${fmt(X)}</div>` +
      `<div class="wd-hl-day ${st}">${dayLabel}</div>` +
      `<div class="wd-hl-sub">Balance right after: ${fmt(best.balAfter)} · Lowest afterward: ${fmt(best.minAfter)}</div>` +
      (earliestLine ? `<div class="wd-hl-sub">${earliestLine}</div>` : "") +
      `<div class="wd-hl-msg">${msg}</div>` +
    `</div>` +
    `<div class="wd-row wd-head"><span>Day</span><span>After</span><span>Lowest after</span><span></span></div>` +
    `<div class="wd-list">${listRows}</div>`;
}

// ===================== MODALS =====================
function openModal(html) { $("#modalCard").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

function openManualModal(date, type) {
  openModal(`
    <h2>One-off ${type} on ${date}</h2>
    <div class="field"><label>Label</label><input id="m_label" placeholder="${type === "income" ? "e.g. tax refund" : "e.g. car repair"}" /></div>
    <div class="field"><label>Amount</label><input id="m_amt" inputmode="decimal" placeholder="0" /></div>
    <div class="modal-actions">
      <button class="cancel" id="m_cancel">Cancel</button>
      <button class="save" id="m_save">Add</button>
    </div>`);
  $("#m_label").focus();
  $("#m_cancel").onclick = closeModal;
  $("#m_save").onclick = () => {
    const amt = Number(($("#m_amt").value || "").replace(/[$,\s]/g, ""));
    if (!amt) { closeModal(); return; }
    saveManual({ id: uid("man"), date, type, amount: Math.abs(amt), label: $("#m_label").value.trim(), owner: view, by: me.name });
    closeModal();
  };
}

function openItemModal(itemId) {
  const it = itemId ? data.items.find((i) => i.id === itemId) : null;
  const cur = it || { type: "expense", frequency: "monthly", amount: 0, dayOfMonth: 1, dayOfWeek: 0, anchorDate: todayISO(), active: true, name: "" };
  const curOwner = it ? (it.owner === "eric" || it.owner === "laura" ? it.owner : computeOwner(it)) : (view !== "combined" ? view : "eric");
  openModal(`
    <h2>${it ? "Edit item" : "Add item"}</h2>
    <div class="field"><label>Name</label><input id="i_name" value="${escapeAttr(cur.name)}" placeholder="e.g. Mortgage" /></div>
    <div class="field"><label>Type</label>
      <div class="seg" id="i_type">
        <button data-v="income" class="${cur.type === "income" ? "sel" : ""}">Income</button>
        <button data-v="expense" class="${cur.type === "expense" ? "sel" : ""}">Expense</button>
      </div>
    </div>
    <div class="field"><label>Account (owner)</label>
      <div class="seg" id="i_owner">
        <button data-v="eric" class="${curOwner === "eric" ? "sel" : ""}">Eric</button>
        <button data-v="laura" class="${curOwner === "laura" ? "sel" : ""}">Laura</button>
      </div>
    </div>
    <div class="field"><label>Frequency</label>
      <select id="i_freq">
        <option value="monthly" ${cur.frequency === "monthly" ? "selected" : ""}>Monthly (day of month)</option>
        <option value="weekly" ${cur.frequency === "weekly" ? "selected" : ""}>Weekly (day of week)</option>
        <option value="biweekly" ${cur.frequency === "biweekly" ? "selected" : ""}>Every 2 weeks</option>
        <option value="ongoing" ${cur.frequency === "ongoing" ? "selected" : ""}>Ongoing (spread daily)</option>
      </select>
    </div>
    <div class="field"><label id="i_amtLabel">Amount</label>
      <input id="i_amt" inputmode="decimal" value="${cur.amount}" />
      <span class="hint" id="i_amtHint"></span>
    </div>
    <div class="field" id="i_domWrap"><label>Day of month (1–31)</label><input id="i_dom" inputmode="numeric" value="${cur.dayOfMonth || 1}" /></div>
    <div class="field" id="i_dowWrap"><label>Day of week</label>
      <select id="i_dow">${DOW.map((d, n) => `<option value="${n}" ${Number(cur.dayOfWeek) === n ? "selected" : ""}>${d}</option>`).join("")}</select>
    </div>
    <div class="field" id="i_anchWrap"><label>A date this happens (sets the 2-week cycle)</label><input id="i_anch" type="date" value="${cur.anchorDate || todayISO()}" /></div>
    <div class="modal-actions">
      <button class="cancel" id="i_cancel">Cancel</button>
      <button class="save" id="i_save">${it ? "Save" : "Add"}</button>
    </div>`);

  $$("#i_type button").forEach((b) =>
    b.addEventListener("click", () => { $$("#i_type button").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); })
  );
  $$("#i_owner button").forEach((b) =>
    b.addEventListener("click", () => { $$("#i_owner button").forEach((x) => x.classList.remove("sel")); b.classList.add("sel"); })
  );
  const freqSel = $("#i_freq");
  function syncFreqFields() {
    const f = freqSel.value;
    $("#i_domWrap").style.display = f === "monthly" ? "" : "none";
    $("#i_dowWrap").style.display = f === "weekly" ? "" : "none";
    $("#i_anchWrap").style.display = f === "biweekly" ? "" : "none";
    $("#i_amtLabel").textContent = f === "ongoing" ? "Monthly total amount" : "Amount per occurrence";
    $("#i_amtHint").textContent = f === "ongoing" ? "Spread evenly across each day of the month." : "";
  }
  freqSel.addEventListener("change", syncFreqFields);
  syncFreqFields();

  $("#i_cancel").onclick = closeModal;
  $("#i_save").onclick = () => {
    const name = $("#i_name").value.trim();
    if (!name) { $("#i_name").focus(); return; }
    const id = it ? it.id : uid("item");
    saveItem({
      id, name,
      type: $("#i_type button.sel").dataset.v,
      owner: $("#i_owner button.sel").dataset.v,
      frequency: freqSel.value,
      amount: Number(($("#i_amt").value || "0").replace(/[$,\s]/g, "")) || 0,
      dayOfMonth: Math.min(31, Math.max(1, parseInt($("#i_dom").value, 10) || 1)),
      dayOfWeek: parseInt($("#i_dow").value, 10) || 0,
      anchorDate: $("#i_anch").value || todayISO(),
      active: it ? it.active !== false : true,
      note: it ? it.note || "" : "",
    });
    closeModal();
  };
}

function openOverrideModal(overrideId, presetItemId) {
  const ov = overrideId ? data.overrides.find((o) => o.id === overrideId) : null;
  if (!data.items.length) { alert("Add a recurring item first."); return; }
  const itemId = ov ? ov.itemId : presetItemId || data.items[0].id;
  const fromDate = ov ? ov.fromDate : todayISO();
  const amountsStr = ov ? ov.amounts.join(", ") : "";
  const count = ov ? ov.amounts.length : 1;
  openModal(`
    <h2>${ov ? "Edit override" : "Override next instances"}</h2>
    <div class="field"><label>Item</label>
      <select id="o_item">${data.items.map((i) => `<option value="${i.id}" ${i.id === itemId ? "selected" : ""}>${escapeHTML(i.name)} (${i.type})</option>`).join("")}</select>
    </div>
    <div class="field"><label>Starting from</label><input id="o_from" type="date" value="${fromDate}" /></div>
    <div class="field"><label>How many upcoming instances</label><input id="o_count" inputmode="numeric" value="${count}" /></div>
    <div class="field"><label>Amounts</label>
      <input id="o_amts" placeholder="e.g. 1200  (or 1200, 1100, 1300 per instance)" value="${escapeAttr(amountsStr)}" />
      <span class="hint">One number applies to every instance. A comma-separated list sets each instance individually (overrides the count).</span>
    </div>
    <div class="modal-actions">
      <button class="cancel" id="o_cancel">Cancel</button>
      <button class="save" id="o_save">${ov ? "Save" : "Add"}</button>
    </div>`);
  $("#o_cancel").onclick = closeModal;
  $("#o_save").onclick = () => {
    const raw = ($("#o_amts").value || "").trim();
    if (!raw) { $("#o_amts").focus(); return; }
    const parts = raw.split(",").map((x) => Number(x.replace(/[$,\s]/g, ""))).filter((x) => !Number.isNaN(x));
    let amounts;
    if (parts.length > 1) amounts = parts;
    else amounts = new Array(Math.max(1, parseInt($("#o_count").value, 10) || 1)).fill(parts[0] || 0);
    saveOverride({
      id: ov ? ov.id : uid("ov"),
      itemId: $("#o_item").value,
      fromDate: $("#o_from").value || todayISO(),
      amounts,
      by: me.name,
    });
    closeModal();
  };
}

function escapeAttr(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHTML(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Show a clear message if Firebase config hasn't been filled in yet.
if (String(firebaseConfig.apiKey).startsWith("PASTE")) {
  $("#loginError").textContent = "Firebase isn't configured yet — paste your settings into public/firebase-config.js.";
}
