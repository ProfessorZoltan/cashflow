"use strict";
(function () {
  const E = window.CashflowEngine;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---- Local session ----
  const LS = {
    get pw() { return localStorage.getItem("cf_pw") || ""; },
    set pw(v) { localStorage.setItem("cf_pw", v); },
    get profile() { return localStorage.getItem("cf_profile") || ""; },
    set profile(v) { localStorage.setItem("cf_profile", v); },
  };

  let state = null;        // current shared state (with .version)
  let pollTimer = null;
  let openDetails = {};    // date -> bool (expanded breakdown rows)

  function todayISO() { return E.iso(new Date()); }

  // ---- Networking ----
  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (LS.pw) headers["Authorization"] = "Bearer " + LS.pw;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    return res;
  }

  async function pull() {
    const res = await api("/api/state");
    if (res.status === 401) { logout(); throw new Error("unauth"); }
    state = await res.json();
    return state;
  }

  // Apply an idempotent mutation locally, then persist. On version conflict,
  // refetch the latest, re-apply the same mutation, and retry once more.
  let saving = false;
  async function mutate(fn) {
    if (!state) return;
    fn(state);
    render();
    await push(fn);
  }

  async function push(fn, attempt = 0) {
    saving = true;
    setSync("saving");
    try {
      const res = await api("/api/state", { method: "PUT", body: JSON.stringify(state) });
      if (res.status === 409) {
        const body = await res.json();
        state = body.state;              // adopt server's latest
        if (fn) fn(state);               // re-apply our idempotent change
        if (attempt < 3) return push(fn, attempt + 1);
        throw new Error("conflict");
      }
      if (res.status === 401) { logout(); return; }
      if (!res.ok) throw new Error("save failed");
      state = await res.json();          // server returns bumped version
      setSync("ok");
      render();
    } catch (e) {
      console.error(e);
      setSync("err");
    } finally {
      saving = false;
    }
  }

  function setSync(s) {
    const dot = $("#syncDot");
    dot.className = "dot" + (s === "saving" ? " saving" : s === "err" ? " err" : "");
    dot.title = s === "saving" ? "Saving…" : s === "err" ? "Save error — will retry on next edit" : "Synced";
  }

  // Background refresh: pick up the other person's edits when we have none pending.
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (saving) return;
      try {
        const res = await api("/api/state");
        if (!res.ok) return;
        const remote = await res.json();
        if (state && remote.version !== state.version) {
          state = remote;
          render();
        }
      } catch (_) {}
    }, 5000);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // ---- Auth UI ----
  function showLogin() {
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    if (LS.profile) {
      const b = $(`.profile-btn[data-profile="${LS.profile}"]`);
      if (b) b.classList.add("sel");
    }
  }
  function logout() {
    LS.pw = "";
    localStorage.removeItem("cf_pw");
    stopPolling();
    showLogin();
  }

  $$(".profile-btn").forEach((b) =>
    b.addEventListener("click", () => {
      $$(".profile-btn").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      LS.profile = b.dataset.profile;
    })
  );

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!LS.profile) { $("#loginError").textContent = "Pick who's editing first."; return; }
    const pw = $("#password").value;
    const res = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) { $("#loginError").textContent = body.error || "Login failed."; return; }
    LS.pw = pw;
    await enterApp();
  });

  async function enterApp() {
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#whoLabel").textContent = LS.profile || "—";
    await pull();
    render();
    startPolling();
    setTimeout(scrollToToday, 60);
  }

  // ---- Tabs ----
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

  // ---- Rendering ----
  function fmt(n) {
    const v = Math.round(n);
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString();
  }
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function projectionRange() {
    const horizon = parseInt($("#horizon").value, 10);
    const today = new Date();
    // Start from the earliest anchor (to carry the running balance forward),
    // but never show more than ~30 days of history before today.
    let earliest = today;
    (state.anchors || []).forEach((a) => {
      const d = E.parseISO(a.date);
      if (d < earliest) earliest = d;
    });
    const minStart = E.addDays(today, -30);
    const start = earliest > minStart ? earliest : minStart;
    const fromISO = E.iso(start);
    const toISO = E.iso(E.addDays(today, horizon));
    return { fromISO, toISO };
  }

  function render() {
    if (!state) return;
    renderCalendar();
    renderItems();
    renderOverrides();
  }

  function renderCalendar() {
    const { fromISO, toISO } = projectionRange();
    const rows = E.project(state, fromISO, toISO);
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
      tr.className =
        (isToday ? "row-today " : "") +
        (weekend ? "row-weekend " : "") +
        (r.end < 0 ? "row-neg" : "");
      tr.id = "row-" + r.date;

      // Date
      const tdDate = document.createElement("td");
      tdDate.className = "c-date";
      tdDate.innerHTML =
        `<div class="datecell"><div class="d-main">${MON[d.getMonth()]} ${d.getDate()}` +
        (isToday ? `<span class="todaytag">TODAY</span>` : "") +
        `</div><div class="d-sub">${DOW[r.dow]}</div></div>`;
      tr.appendChild(tdDate);

      // Start balance (editable -> start anchor)
      tr.appendChild(balCell(r, "start"));

      // In / Out
      const tdIn = document.createElement("td");
      tdIn.className = "c-num num pos";
      tdIn.textContent = r.income ? fmt(r.income) : "";
      tr.appendChild(tdIn);

      const tdOut = document.createElement("td");
      tdOut.className = "c-num num neg";
      tdOut.textContent = r.expense ? fmt(r.expense) : "";
      tr.appendChild(tdOut);

      // End balance (editable -> end anchor)
      tr.appendChild(balCell(r, "end"));

      // Details toggle
      const tdDet = document.createElement("td");
      tdDet.className = "c-det";
      const btn = document.createElement("button");
      btn.className = "det-btn";
      btn.textContent = openDetails[r.date] ? "▾" : "›";
      btn.title = "Show what happens this day";
      btn.addEventListener("click", () => {
        openDetails[r.date] = !openDetails[r.date];
        renderCalendar();
      });
      tdDet.appendChild(btn);
      tr.appendChild(tdDet);

      frag.appendChild(tr);

      if (openDetails[r.date]) frag.appendChild(detailRow(r));
    });

    body.appendChild(frag);

    const warn = $("#lowWarn");
    if (firstNeg) {
      warn.classList.remove("hidden");
      warn.textContent = `⚠ Balance goes negative on ${MON[E.parseISO(firstNeg.date).getMonth()]} ${E.parseISO(firstNeg.date).getDate()} (${fmt(firstNeg.end)})`;
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
    input.title = anchored ? "Known balance — click to change. Clear the box to remove." : "Click to set the real bank balance for this day";
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
      m.title = "Known balance (anchored). Clearing the value removes it.";
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
      left.innerHTML = ln.name + (ln.isOverride ? `<span class="ov">(override)</span>` : "");
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

  // ---- Items screen ----
  function renderItems() {
    const wrap = $("#itemsList");
    wrap.innerHTML = "";
    const items = (state.items || []).slice().sort((a, b) => {
      if (a.type !== b.type) return a.type === "income" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    items.forEach((it) => {
      const card = document.createElement("div");
      card.className = "card" + (it.active === false ? " inactive" : "");
      card.innerHTML =
        `<div class="card-head"><span class="nm">${it.name}</span>` +
        `<span class="tag ${it.type}">${it.type}</span></div>` +
        `<div class="card-sub">${E.describe(it)}</div>` +
        `<div class="card-amt ${it.type === "income" ? "pos" : "neg"}">` +
        (it.frequency === "ongoing" ? `${fmt(it.amount)}/mo` : `${fmt(it.amount)}`) +
        `</div>`;
      const actions = document.createElement("div");
      actions.className = "card-actions";
      const edit = mkBtn("Edit", () => openItemModal(it.id));
      const ov = mkBtn("Override next…", () => openOverrideModal(null, it.id));
      const toggle = mkBtn(it.active === false ? "Activate" : "Pause", () =>
        mutate((s) => {
          const x = s.items.find((i) => i.id === it.id);
          if (x) x.active = !(x.active !== false);
        })
      );
      actions.appendChild(edit);
      actions.appendChild(ov);
      actions.appendChild(toggle);
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

  // ---- Overrides screen ----
  function renderOverrides() {
    const wrap = $("#overridesList");
    wrap.innerHTML = "";
    const ovs = (state.overrides || []).slice().sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1));
    if (!ovs.length) {
      wrap.innerHTML = `<p class="muted pad">No overrides yet.</p>`;
      return;
    }
    ovs.forEach((ov) => {
      const it = (state.items || []).find((i) => i.id === ov.itemId);
      const card = document.createElement("div");
      card.className = "card";
      const amts = ov.amounts.map((a) => fmt(a)).join(", ");
      card.innerHTML =
        `<div class="card-head"><span class="nm">${it ? it.name : "(deleted item)"}</span>` +
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

  // ---- Mutations ----
  function uid(p) { return p + "_" + Math.random().toString(36).slice(2, 9); }

  function setAnchor(date, kind, balance) {
    mutate((s) => {
      s.anchors = s.anchors || [];
      const ex = s.anchors.find((a) => a.date === date && a.kind === kind);
      if (ex) { ex.balance = balance; ex.by = LS.profile; }
      else s.anchors.push({ date, kind, balance, by: LS.profile });
    });
  }
  function clearAnchor(date, kind) {
    mutate((s) => {
      s.anchors = (s.anchors || []).filter((a) => !(a.date === date && a.kind === kind));
    });
  }
  function deleteManual(mid) {
    mutate((s) => { s.manual = (s.manual || []).filter((m) => m.id !== mid); });
  }
  function deleteOverride(oid) {
    mutate((s) => { s.overrides = (s.overrides || []).filter((o) => o.id !== oid); });
  }

  // ---- Modals ----
  function openModal(html) {
    $("#modalCard").innerHTML = html;
    $("#modal").classList.remove("hidden");
  }
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
      const entry = { id: uid("man"), date, type, amount: Math.abs(amt), label: $("#m_label").value.trim(), by: LS.profile };
      mutate((s) => {
        s.manual = s.manual || [];
        if (!s.manual.find((m) => m.id === entry.id)) s.manual.push(entry);
      });
      closeModal();
    };
  }

  function openItemModal(itemId) {
    const it = itemId ? state.items.find((i) => i.id === itemId) : null;
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
      const type = $("#i_type button.sel").dataset.v;
      const frequency = freqSel.value;
      const amount = Number(($("#i_amt").value || "0").replace(/[$,\s]/g, "")) || 0;
      const id = it ? it.id : uid("item");
      const next = {
        id, name, type, frequency, amount,
        dayOfMonth: Math.min(31, Math.max(1, parseInt($("#i_dom").value, 10) || 1)),
        dayOfWeek: parseInt($("#i_dow").value, 10) || 0,
        anchorDate: $("#i_anch").value || todayISO(),
        active: it ? it.active !== false : true,
        note: it ? it.note || "" : "",
      };
      mutate((s) => {
        s.items = s.items || [];
        const idx = s.items.findIndex((x) => x.id === id);
        if (idx >= 0) s.items[idx] = next; else s.items.push(next);
      });
      closeModal();
    };
  }

  function openOverrideModal(overrideId, presetItemId) {
    const ov = overrideId ? state.overrides.find((o) => o.id === overrideId) : null;
    const itemId = ov ? ov.itemId : presetItemId || (state.items[0] && state.items[0].id);
    const fromDate = ov ? ov.fromDate : todayISO();
    const amountsStr = ov ? ov.amounts.join(", ") : "";
    const count = ov ? ov.amounts.length : 1;
    openModal(`
      <h2>${ov ? "Edit override" : "Override next instances"}</h2>
      <div class="field"><label>Item</label>
        <select id="o_item">${state.items.map((i) => `<option value="${i.id}" ${i.id === itemId ? "selected" : ""}>${i.name} (${i.type})</option>`).join("")}</select>
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
      const itm = $("#o_item").value;
      const from = $("#o_from").value || todayISO();
      const raw = ($("#o_amts").value || "").trim();
      if (!raw) { $("#o_amts").focus(); return; }
      const parts = raw.split(",").map((x) => Number(x.replace(/[$,\s]/g, ""))).filter((x) => !Number.isNaN(x));
      let amounts;
      if (parts.length > 1) amounts = parts;
      else {
        const n = Math.max(1, parseInt($("#o_count").value, 10) || 1);
        amounts = new Array(n).fill(parts[0] || 0);
      }
      const id = ov ? ov.id : uid("ov");
      const next = { id, itemId: itm, fromDate: from, amounts, by: LS.profile };
      mutate((s) => {
        s.overrides = s.overrides || [];
        const idx = s.overrides.findIndex((o) => o.id === id);
        if (idx >= 0) s.overrides[idx] = next; else s.overrides.push(next);
      });
      closeModal();
    };
  }

  function escapeAttr(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // ---- Boot ----
  async function boot() {
    if (LS.pw) {
      try { await pull(); await enterApp(); return; } catch (_) {}
    }
    showLogin();
  }
  boot();
})();
