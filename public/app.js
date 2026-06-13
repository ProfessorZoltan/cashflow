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
const data = { items: [], overrides: [], anchors: [], manual: [] };
let me = { name: "", email: "" };
let openDetails = {};
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
  await seedIfEmpty();
  startListeners();
  setTimeout(scrollToToday, 200);
}

// ===================== FIRESTORE SYNC =====================
const COLLECTIONS = ["items", "overrides", "anchors", "manual"];

function startListeners() {
  stopListeners();
  setSync("ok");
  COLLECTIONS.forEach((name) => {
    const u = onSnapshot(
      collection(db, name),
      (snap) => {
        data[name] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
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

function setSync(s) {
  const dot = $("#syncDot");
  if (!dot) return;
  dot.className = "dot" + (s === "saving" ? " saving" : s === "err" ? " err" : "");
  dot.title = s === "saving" ? "Saving…" : s === "err" ? "Connection problem" : "Synced live";
}

// ===================== MUTATIONS (direct Firestore writes) =====================
function uid(p) { return p + "_" + Math.random().toString(36).slice(2, 9); }

function setAnchor(date, kind, balance) {
  const id = `${date}_${kind}`;
  setDoc(doc(db, "anchors", id), { date, kind, balance, by: me.name }).catch(failSave);
}
function clearAnchor(date, kind) {
  deleteDoc(doc(db, "anchors", `${date}_${kind}`)).catch(failSave);
}
function saveItem(item) { setDoc(doc(db, "items", item.id), item).catch(failSave); }
function deleteItem(id) { deleteDoc(doc(db, "items", id)).catch(failSave); }
function saveOverride(ov) { setDoc(doc(db, "overrides", ov.id), ov).catch(failSave); }
function deleteOverride(id) { deleteDoc(doc(db, "overrides", id)).catch(failSave); }
function saveManual(m) { setDoc(doc(db, "manual", m.id), m).catch(failSave); }
function deleteManual(id) { deleteDoc(doc(db, "manual", id)).catch(failSave); }
function failSave(e) { console.error(e); setSync("err"); }

// ===================== TABS =====================
$$(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    ["calendar", "items", "overrides"].forEach((name) =>
      $(`#tab-${name}`).classList.toggle("hidden", name !== t.dataset.tab)
    );
  })
);
$("#horizon").addEventListener("change", render);
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

function projectionRange() {
  const horizon = parseInt($("#horizon").value, 10);
  const today = new Date();
  let earliest = today;
  data.anchors.forEach((a) => { const d = E.parseISO(a.date); if (d < earliest) earliest = d; });
  const minStart = E.addDays(today, -30);
  const start = earliest > minStart ? earliest : minStart;
  return { fromISO: E.iso(start), toISO: E.iso(E.addDays(today, horizon)) };
}

function render() {
  renderCalendar();
  renderItems();
  renderOverrides();
}

function renderCalendar() {
  const { fromISO, toISO } = projectionRange();
  const rows = E.project(data, fromISO, toISO);
  const tISO = todayISO();
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
    tdOut.className = "c-num num neg";
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
  td.className = "c-bal";
  const val = kind === "start" ? r.start : r.end;
  const anchored = kind === "start" ? r.anchoredStart : r.anchoredEnd;
  const wrap = document.createElement("div");
  wrap.className = "balcell";
  const input = document.createElement("input");
  input.className = "editbal num" + (anchored ? " anchored" : "") + (val < 0 ? " c-bal-val neg" : "");
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
    left.innerHTML = escapeHTML(ln.name) + (ln.isOverride ? `<span class="ov">(override)</span>` : "");
    const right = document.createElement("span");
    right.className = ln.amount >= 0 ? "pos num" : "neg num";
    right.textContent = fmt(ln.amount);
    row.appendChild(left);
    row.appendChild(right);
    if (ln.manual) {
      const del = document.createElement("button");
      del.textContent = "✕";
      del.className = "det-btn";
      del.title = "Remove this one-off entry";
      del.style.marginLeft = "8px";
      del.addEventListener("click", () => deleteManual(ln.id));
      row.appendChild(del);
    }
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

function renderItems() {
  const wrap = $("#itemsList");
  wrap.innerHTML = "";
  const items = data.items.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === "income" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  items.forEach((it) => {
    const card = document.createElement("div");
    card.className = "card" + (it.active === false ? " inactive" : "");
    card.innerHTML =
      `<div class="card-head"><span class="nm">${escapeHTML(it.name)}</span>` +
      `<span class="tag ${it.type}">${it.type}</span></div>` +
      `<div class="card-sub">${escapeHTML(E.describe(it))}</div>` +
      `<div class="card-amt ${it.type === "income" ? "pos" : "neg"}">` +
      (it.frequency === "ongoing" ? `${fmt(it.amount)}/mo` : `${fmt(it.amount)}`) +
      `</div>`;
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.appendChild(mkBtn("Edit", () => openItemModal(it.id)));
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
  const ovs = data.overrides.slice().sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1));
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
    saveManual({ id: uid("man"), date, type, amount: Math.abs(amt), label: $("#m_label").value.trim(), by: me.name });
    closeModal();
  };
}

function openItemModal(itemId) {
  const it = itemId ? data.items.find((i) => i.id === itemId) : null;
  const cur = it || { type: "expense", frequency: "monthly", amount: 0, dayOfMonth: 1, dayOfWeek: 0, anchorDate: todayISO(), active: true, name: "" };
  openModal(`
    <h2>${it ? "Edit item" : "Add item"}</h2>
    <div class="field"><label>Name</label><input id="i_name" value="${escapeAttr(cur.name)}" placeholder="e.g. Mortgage" /></div>
    <div class="field"><label>Type</label>
      <div class="seg" id="i_type">
        <button data-v="income" class="${cur.type === "income" ? "sel" : ""}">Income</button>
        <button data-v="expense" class="${cur.type === "expense" ? "sel" : ""}">Expense</button>
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
