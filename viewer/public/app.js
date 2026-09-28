"use strict";

const $ = (s, r = document) => r.querySelector(s);

// theme tokens read live from CSS vars so charts repaint correctly on light/dark
let chartColors = null;
const cssv = (n) => chartColors ? (chartColors[n] ??= chartColors.style.getPropertyValue(n).trim()) : getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const palette = () => ["--accent", "--cyan", "--amber", "--violet", "--green", "--red", "--faint"].map(cssv);

const state = {
  all: [],
  view: [],
  sort: { key: "ts", dir: -1 },
  filters: { search: "", provider: "", platform: "", workspace: "", model: "", vendor: "", mode: "", effort: "", since: "", until: "", ctx: 0 },
  zoom: null,                     // {from,to} day keys the time charts are showing;
                                  // a view of the same data, not a filter on it
  chartView: { axis: "calendar", grain: "auto", hidden: [] },
  group: true,
  expanded: [],
  fields: {},                     // this project's stored-field flags
  enabled: true,                  // is this project tracked
  budgetMonthly: null,            // optional USD monthly budget (ui.budgetMonthly)
  searchKeys: null,               // Set of record keys matching the server-side
                                  // full-text search; null = no active search
};
// Field-group visible? Defaults to true so a missing/unreachable config shows all.
const has = (g) => state.fields[g] !== false;

// ---------- formatting (locale-aware: honors the viewer's browser locale) ----------
const fmtInt = (n) => (n || 0).toLocaleString();
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return n.toLocaleString();
}
const _usd2 = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const _usd3 = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 });
const fmtUsd = (n) => ((n = n || 0) < 10 ? _usd3 : _usd2).format(n);
const _whenFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function fmtWhen(ts) {
  if (!ts) return "—";
  return _whenFmt.format(new Date(ts));
}
function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function fmtBytes(n) {
  n = n || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}
let toastTimer;
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.hidden = false; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 300); }, 3200);
}
// Permanently delete records by composite identity — always behind a confirm.
const eventKey = (e) => ({ provider: PROV(e), sessionId: e.sessionId, id: e.id });
// Mirrors STORE.tombstoneKey() on the server — the shared record identity used
// for delete, export, and search-hit matching.
const keyOf = (e) =>
  JSON.stringify([PROV(e), e.sessionId == null ? "" : String(e.sessionId), e.id == null ? "" : String(e.id)]);
async function delEvents(keys, label) {
  keys = (keys || []).filter((k) => k && k.id != null);
  if (!keys.length) return;
  if (!confirm(`Permanently delete ${keys.length} ${label}?\n\nThis removes the record(s) from disk and cannot be undone.`)) return;
  let r = {};
  try {
    r = await (await fetch("/api/events", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    })).json();
  } catch {}
  await load();
  toast(`Deleted ${r.removed || 0} record(s) · freed ${fmtBytes(r.bytesFreed)}`);
}
const dayKey = (ts) => (ts || "").slice(0, 10);

// ---------- export (client-side; exports the currently filtered records) ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function exportRecords(kind) {
  const rows = state.view;
  if (!rows.length) { toast("nothing to export"); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === "json") {
    // The table only holds 280-char previews — fetch the FULL stored records so
    // the export actually contains the prompt/response text.
    let full = null;
    try {
      full = await (await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: rows.map(eventKey) }),
      })).json();
    } catch {}
    const out = Array.isArray(full) && full.length ? full : rows;
    if (!Array.isArray(full) || !full.length) toast("full text unavailable — exported previews");
    download(`ai-usage-${stamp}.json`, JSON.stringify(out, null, 2), "application/json");
  } else {
    const cols = ["ts", "provider", "platform", "workspace", "sessionId", "model", "vendor", "permissionMode", "promptChars", "responseChars", "input", "output", "reasoning", "cacheRead", "cacheWrite", "costTotal", "costSource", "estimated", "estimatedRate", "durationMs", "contextFillPct", "sessionName", "subagentRuns", "subagentCost"];
    const line = (e) => [
      e.ts, PROV(e), e.entrypoint || "", e.workspace, e.sessionId, e.model, has("meta") ? e.vendor : null, e.permissionMode,
      e.promptChars, e.responseChars,
      T_IN(e), T_OUT(e), (e.usage && e.usage.reasoning) || 0, (e.usage && e.usage.cacheRead) || 0, (e.usage && e.usage.cacheCreate) || 0,
      COST(e), (e.cost && e.cost.source) || "", COST_ESTIMATED(e) ? 1 : 0,
      e.cost && e.cost.estimatedRate ? 1 : 0, e.durationMs || 0, contextObserved(e) ? e.contextFillPct : null,
      e.sessionName, e.counts?.subagentCalls, sumRuns(e, "cost", "total"),
    ].map(csvCell).join(",");
    const csv = [cols.join(","), ...rows.map(line)].join("\r\n");
    download(`ai-usage-${stamp}.csv`, csv, "text/csv");
  }
  toast(`exported ${rows.length} record(s)`);
}

// derived accessors used for sorting (null-safe: records may omit disabled groups)
const T_IN = (e) => (e.usage && e.usage.input) || 0;
const T_OUT = (e) => (e.usage && e.usage.output) || 0;
const T_TOTAL = (e) => { const u = e.usage; return u ? (u.input || 0) + (u.output || 0) + (u.cacheCreate || 0) + (u.cacheRead || 0) : 0; };
const contextObserved = (e) => Number.isFinite(e.contextFillPct) && e.contextMax > 0;
const COST = (e) => (e.cost && e.cost.total) || 0;
const COST_ESTIMATED = (e) => !!(e.cost && (e.cost.estimated || e.cost.source === "estimated"));
// Two different reasons a cost can be approximate; a Cursor row can have either.
const estReason = (e) => e.cost && e.cost.estimatedRate
  ? `No listed price for ${e.model || "this model"} — charged at the default rate for its family`
  : "Cursor doesn't store exact token counts locally; tokens estimated from text length";
const PROV = (e) => e.provider || "claude";
// Provider → its brand color (shared with badges via CSS vars).
const provColor = (p) => cssv(`--prov-${p}`) || cssv("--faint");
// Distinct providers present in a set, in a stable order.
function provsIn(arr) {
  const order = ["claude", "codex", "cursor", "opencode", "cline", "roo", "kilo"];
  const seen = new Set(arr.map(PROV));
  return order.filter((p) => seen.has(p)).concat([...seen].filter((p) => !order.includes(p)));
}

// ---------- config (per project: title/ui + tracking + stored fields) ----------
async function boot() {
  await loadConfig();
  await load();
}
async function loadConfig() {
  let cfg = {};
  try { cfg = await (await fetch("/api/config")).json(); } catch {}
  if (cfg.title) {
    document.title = cfg.title + " · AI Usage Inspector";
    const t = $("#proj"); if (t) t.textContent = cfg.title;
  }
  const ui = cfg.ui || {};
  if (ui.filters) state.filters = { ...state.filters, ...ui.filters };
  if (ui.sort && ui.sort.key) state.sort = ui.sort;
  if (typeof ui.group === "boolean") state.group = ui.group;
  if (Array.isArray(ui.expanded)) state.expanded = ui.expanded.filter((key) => typeof key === "string");
  state.chartView = validateChartView(ui.chartView);
  state.budgetMonthly = typeof ui.budgetMonthly === "number" && ui.budgetMonthly > 0 ? ui.budgetMonthly : null;
  state.fields = cfg.fields || {};
  state.enabled = !cfg.tracking || cfg.tracking.enabled !== false;
  applySettingsVisibility();
}
// Persist a config patch ({tracking} / {fields}) to this project's config.
async function saveConfigPatch(patch) {
  try {
    const cfg = await (await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    })).json();
    state.fields = cfg.fields || {};
    state.enabled = !cfg.tracking || cfg.tracking.enabled !== false;
    renderSettings();
    applySettingsVisibility();
    apply();
    toast("settings saved");
  } catch { toast("save failed"); }
}
// Reflect disabled field-groups onto the chrome: hide table columns + filters.
function applySettingsVisibility() {
  const grid = $("#grid");
  if (grid) {
    grid.classList.toggle("hide-col-in", !has("tokens"));
    grid.classList.toggle("hide-col-out", !has("tokens"));
    grid.classList.toggle("hide-col-context", !has("context"));
    grid.classList.toggle("hide-col-cost", !has("cost"));
  }
  const eff = $("#ctl-effort"); if (eff) eff.hidden = !has("meta");
  const vendor = $("#ctl-vendor"); if (vendor) vendor.hidden = !has("meta");
  const plat = $("#ctl-platform"); if (plat) plat.hidden = !has("meta");
  const ctx = $("#ctl-ctx"); if (ctx) ctx.hidden = !has("context");
}

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const live = new Set();
    for (const e of state.view) {
      live.add("session:" + sessionKey(e));
      live.add(turnTreeKey(e));
      const visit = (runs, prefix = []) => runs.forEach((run, i) => {
        const runPath = [...prefix, i];
        live.add("run:" + keyOf(e) + ":" + runPath.join("."));
        visit(runsOf(run), runPath);
      });
      visit(runsOf(e));
    }
    state.expanded = [...new Set(state.expanded)].filter((key) => live.has(key)).slice(-500);
    fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui: { filters: state.filters, sort: state.sort, group: state.group, expanded: state.expanded, chartView: validateChartView(state.chartView) } }),
    }).catch(() => {});
  }, 400);
}

// Sync the on-screen controls to current state (after options are built).
function reflect() {
  const f = state.filters;
  $("#f-search").value = f.search || "";
  $("#f-provider").value = f.provider || "";
  $("#f-platform").value = f.platform || "";
  $("#f-workspace").value = f.workspace || "";
  $("#f-model").value = f.model || "";
  $("#f-vendor").value = f.vendor || "";
  $("#f-mode").value = f.mode || "";
  $("#f-effort").value = f.effort || "";
  $("#f-since").value = f.since || "";
  $("#f-until").value = f.until || "";
  $("#f-ctx").value = f.ctx || 0;
  $("#f-ctx-v").textContent = String(f.ctx || 0);
  $("#f-group").checked = state.group;
}

// ---------- load ----------
async function load() {
  const res = await fetch("/api/events");
  state.all = await res.json();
  buildFilterOptions();
  reflect();
  await runSearch();
  apply();
}

// Resolve the current search term against the FULL stored text, server-side.
// Only the matching keys come back, so state.all stays complete and totals that
// are meant to ignore filters (e.g. "this month") stay correct.
let searchSeq = 0;
async function runSearch() {
  const q = (state.filters.search || "").trim();
  if (!q) {
    state.searchKeys = null;
    return;
  }
  const seq = ++searchSeq;
  try {
    const r = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json();
    if (seq !== searchSeq) return; // a newer keystroke already won
    state.searchKeys = Array.isArray(r.keys) ? new Set(r.keys) : null;
  } catch {
    state.searchKeys = null; // fall back to preview matching
  }
}

let searchTimer;
function onSearchInput() {
  clearTimeout(searchTimer);
  // Drop the previous query's hit set first — keeping it would filter the table
  // by the OLD term until the new search resolves.
  state.searchKeys = null;
  apply(); // instant feedback from previews
  searchTimer = setTimeout(async () => {
    await runSearch();
    apply();
  }, 220);
}

function uniq(key) {
  return [...new Set(state.all.map((e) => e[key]).filter(Boolean))].sort();
}
function fillSelect(id, values, label) {
  const el = $(id);
  el.innerHTML = `<option value="">all ${label}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
}
function buildFilterOptions() {
  fillSelect("#f-provider", [...new Set(state.all.map(PROV))].sort(), "providers");
  fillSelect("#f-platform", uniq("entrypoint"), "platforms");
  fillSelect("#f-workspace", uniq("workspace"), "workspaces");
  fillSelect("#f-model", uniq("model"), "models");
  fillSelect("#f-vendor", uniq("vendor"), "vendors");
  fillSelect("#f-mode", uniq("permissionMode"), "modes");
  fillSelect("#f-effort", [...new Set(state.all.map((e) => e.effortLevel).filter(Boolean))].sort(), "efforts");
}

// ---------- filtering ----------
function apply() {
  const f = state.filters;
  const q = f.search.toLowerCase();
  state.view = state.all.filter((e) => {
    if (f.provider && (e.provider || "claude") !== f.provider) return false;
    if (f.platform && e.entrypoint !== f.platform) return false;
    if (f.workspace && e.workspace !== f.workspace) return false;
    if (f.model && e.model !== f.model) return false;
    if (has("meta") && f.vendor && e.vendor !== f.vendor) return false;
    if (f.mode && e.permissionMode !== f.mode) return false;
    if (f.effort && e.effortLevel !== f.effort) return false;
    if (f.since && dayKey(e.ts) < f.since) return false;
    if (f.until && dayKey(e.ts) > f.until) return false;
    if (f.ctx && (!contextObserved(e) || e.contextFillPct < f.ctx)) return false;
    // Text search is resolved server-side against the stored prompt/response
    // (this list only carries 280-char previews). While the hit set is still in
    // flight, fall back to matching the previews so typing stays responsive.
    if (q) {
      if (state.searchKeys) {
        if (!state.searchKeys.has(keyOf(e))) return false;
      } else {
        const hay = [e.promptPreview, e.responsePreview, e.slug, e.workspace, e.sessionName, e.sessionTitle,
          e.agent?.nickname, ...allRuns(e).flatMap((r) => [r.agentType, r.description])].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
    }
    return true;
  });
  renderStats();
  renderCharts();
  renderTable();
  const r = state.all.length ? `${fmtWhen(state.all[state.all.length - 1].ts)} → ${fmtWhen(state.all[0].ts)}` : "no data";
  $("#meta-range").textContent = `${state.view.length}/${state.all.length} turns · ${r}`;
  const del = $("#f-del");
  if (del) { del.textContent = `delete shown (${state.view.length})`; del.disabled = state.view.length === 0; }
  persist();
}

// ---------- stats ----------
function renderStats() {
  const v = state.view;
  // Compaction summaries open real turns but nobody typed them, so they are not
  // prompts. Their cost still counts — it was really spent.
  const synthetic = v.reduce((a, e) => a + (e.synthetic ? 1 : 0), 0);
  const prompts = v.length - synthetic;
  const tin = v.reduce((a, e) => a + T_IN(e), 0);
  const tout = v.reduce((a, e) => a + T_OUT(e), 0);
  const ttot = v.reduce((a, e) => a + T_TOTAL(e), 0);
  const cost = v.reduce((a, e) => a + COST(e), 0);
  // Only real observations enter the mean; an unknown window is not measured zero.
  const ctxRecs = v.filter(contextObserved);
  const avgCtx = ctxRecs.length ? ctxRecs.reduce((a, e) => a + e.contextFillPct, 0) / ctxRecs.length : null;
  const dur = v.reduce((a, e) => a + (e.durationMs || 0), 0);
  const subs = v.reduce((a, e) => a + (e.counts ? e.counts.subagentCalls : 0), 0);
  // Only records with a real measured latency (> 0); unknown providers encode 0.
  const respRecs = v.filter((e) => e.firstResponseMs > 0);
  const avgResp = respRecs.length ? respRecs.reduce((a, e) => a + e.firstResponseMs, 0) / respRecs.length : 0;

  const byModel = tally(v, (e) => e.model, () => 1);
  const topModel = topKey(byModel);
  const byWs = tally(v, (e) => e.workspace, () => 1);
  const topWs = topKey(byWs);

  // ordered by what matters most for hands-on work; $ is an estimate, kept last.
  // Cards for disabled field-groups are omitted.
  const cards = [];
  if (has("tokens")) cards.push({ label: "tokens · total", val: fmtTok(ttot), sub: `${fmtTok(tin)} in · ${fmtTok(tout)} out`, cls: "accent" });
  const promptSub = synthetic
    ? `${subs} subagent calls · ${fmtInt(synthetic)} auto-continued`
    : `${subs} subagent calls`;
  cards.push({ label: "prompts", val: fmtInt(prompts), sub: promptSub, cls: "" });
  if (has("context")) cards.push({ label: "avg context", val: avgCtx == null ? "—" : avgCtx.toFixed(1) + "<small>%</small>", sub: "of window filled", cls: "amber", bar: avgCtx });
  if (has("timing")) cards.push({ label: "active time", val: fmtDur(dur), sub: "summed turn duration", cls: "" });
  if (has("timing") && respRecs.length) cards.push({ label: "avg first response", val: fmtDur(avgResp), sub: "prompt → first reply", cls: "" });
  cards.push({ label: "top model", val: esc(shortModel(topModel)), sub: topModel ? byModel[topModel] + " turns" : "—", cls: "" });
  cards.push({ label: "busiest workspace", val: esc(topWs || "—"), sub: topWs ? byWs[topWs] + " turns" : "—", cls: "" });
  if (has("cost")) {
    // With more than one agent in view, which agent spent it matters more than
    // the per-prompt average — delegated work is otherwise invisible up here.
    const costProvs = provsIn(v);
    let costSub = prompts ? `${fmtUsd(cost / prompts)} / prompt` : "—";
    if (costProvs.length > 1) {
      const byProv = {};
      for (const e of v) byProv[PROV(e)] = (byProv[PROV(e)] || 0) + COST(e);
      costSub = costProvs
        .slice()
        .sort((a, b) => byProv[b] - byProv[a])
        .map((p) => `${esc(p)} ${fmtUsd(byProv[p])}`)
        .join(" · ");
    }
    cards.push({ label: "cost", val: fmtUsd(cost), sub: costSub, cls: "cost" });
  }
  // This month's spend (computed across ALL records, independent of filters) +
  // optional monthly budget with warn/danger accents.
  if (has("cost")) {
    // Compare in LOCAL calendar months: record ts is UTC, so slicing the ISO
    // string would bucket e.g. local Aug 1 00:30 (UTC Jul 31) into the wrong month.
    const now = new Date(), ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    const localMonth = (ts) => {
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? "" : d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    };
    const monthCost = state.all.reduce((a, e) => (localMonth(e.ts) === ym ? a + COST(e) : a), 0);
    const b = state.budgetMonthly;
    let cls = "cost", sub = "spent this month across all records";
    if (b) {
      const pct = monthCost / b;
      cls = pct >= 1 ? "danger" : pct >= 0.8 ? "warn" : "cost";
      sub = `${fmtUsd(monthCost)} of ${fmtUsd(b)} budget · ${Math.round(pct * 100)}%`;
    }
    cards.push({ label: "this month", val: fmtUsd(monthCost), sub: b ? sub : sub, cls });
  }
  $("#stats").innerHTML = cards
    .map(
      (c) => `<div class="stat ${c.cls}" style="--bar:${c.bar || 0}%">
        <div class="label">${c.label}</div>
        <div class="val">${c.val}</div>
        <div class="sub">${c.sub}</div></div>`
    )
    .join("");
}
function tally(arr, keyFn, valFn) {
  const m = {};
  for (const e of arr) { const k = keyFn(e) || "—"; m[k] = (m[k] || 0) + valFn(e); }
  return m;
}
const topKey = (m) => Object.keys(m).sort((a, b) => m[b] - m[a])[0] || "";
// Model may arrive as a non-string (a provider can store it as an object), so
// coerce before trimming — `.replace` on an object would throw and blank the table.
const shortModel = (m) => {
  if (!m) return "—";
  const s = typeof m === "string" ? m : m.id || m.modelID || m.model || String(m);
  return s.replace(/^claude-/, "").replace(/-\d{8}$/, "");
};

// ---------- charts ----------
function validateChartView(value) {
  const v = value && typeof value === "object" ? value : {};
  return { axis: ["calendar", "active"].includes(v.axis) ? v.axis : "calendar",
    grain: ["auto", "day", "week", "month"].includes(v.grain) ? v.grain : "auto",
    hidden: Array.isArray(v.hidden) ? [...new Set(v.hidden.filter((id) => typeof id === "string" && /^(tokens:(input|output|cacheRead|cacheCreate)|context:(mean|peak)|cost:[a-z0-9_-]{1,48})$/.test(id)))].slice(0, 64) : [] };
}
// Intl objects are reusable. Never construct one per point or table cell.
const dateFormats = new Map(), axisFormats = new Map();
function dateFormatter(locale, shape) {
  const key = `${locale || ""}:${shape}`;
  if (!dateFormats.has(key)) dateFormats.set(key, new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short", ...(shape !== "boundary" ? { day: "numeric" } : {}), ...(shape !== "short" ? { year: "numeric" } : {}) }));
  return dateFormats.get(key);
}
function fmtAxis(value, kind = "tokens", locale) {
  const digits = value && Math.abs(value) < 1 ? Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(Math.abs(value))))) : 2;
  const key = `${locale || ""}:${kind}:${digits}`;
  if (!axisFormats.has(key)) axisFormats.set(key, new Intl.NumberFormat(locale, {
    notation: "compact", maximumFractionDigits: digits,
    ...(kind === "cost" ? { style: "currency", currency: "USD", minimumFractionDigits: 0 } : {}),
  }));
  return axisFormats.get(key).format(value) + (kind === "context" ? "%" : "");
}
const TOKEN_TYPES = [
  { key: "input", label: "Input", color: "--accent" },
  { key: "output", label: "Output", color: "--cyan" },
  { key: "cacheRead", label: "Cache read", color: "--violet" },
  { key: "cacheCreate", label: "Cache write", color: "--amber" },
];
const DAY_MS = 86400000;
// Use the recorded date, as since/until do. UTC arithmetic on date-only keys
// avoids DST and browser-zone shifts; timestamps are never reinterpreted here.
const dateNumber = (key) => Date.parse(`${key}T00:00:00Z`);
const dateKeyAt = (ms) => new Date(ms).toISOString().slice(0, 10);
function calendarKeys(keys, axis) {
  if (!keys.length || axis === "active") return keys;
  const first = dateNumber(keys[0]), last = dateNumber(keys[keys.length - 1]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return keys;
  return Array.from({ length: Math.round((last - first) / DAY_MS) + 1 }, (_, i) => dateKeyAt(first + i * DAY_MS));
}
function chartGrain(count, choice) {
  return choice === "auto" ? (count > 730 ? "month" : count > 120 ? "week" : "day") : choice;
}
function periodKey(key, grain) {
  if (grain === "month") return key.slice(0, 7) + "-01";
  if (grain === "week") {
    const ms = dateNumber(key), weekday = new Date(ms).getUTCDay();
    return dateKeyAt(ms - ((weekday + 6) % 7) * DAY_MS); // Monday
  }
  return key;
}
function blankPeriod(key) {
  return { key, from: key, to: key, tok: 0, cost: 0, n: 0, models: Object.create(null),
    types: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, providers: Object.create(null), ctxSum: 0, ctxN: 0, ctxMax: null };
}
function bucketPeriods(days, keys, grain) {
  const map = new Map();
  for (const key of keys) {
    const bucket = periodKey(key, grain), d = days[key];
    if (!map.has(bucket)) map.set(bucket, { ...blankPeriod(bucket), from: key });
    const p = map.get(bucket); p.to = key;
    if (d.ctxMax != null) p.ctxMax = Math.max(p.ctxMax ?? 0, d.ctxMax);
    for (const field of ["tok", "cost", "n", "ctxSum", "ctxN"]) p[field] += d[field];
    for (const field of ["types", "providers", "models"]) {
      for (const [name, value] of Object.entries(d[field])) p[field][name] = (p[field][name] || 0) + value;
    }
  }
  return [...map.values()];
}
function niceScale(maximum) {
  const max = maximum > 0 && Number.isFinite(maximum) ? maximum : 1;
  const raw = max / 4, unit = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * unit >= raw) * unit;
  const top = Math.ceil(max / step) * step;
  return { max: top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
function dateTicks(keys, limit = 4, grain = "day", locale) {
  if (!keys.length) return [];
  const count = Math.min(keys.length, Math.max(2, limit));
  const indices = [...new Set(Array.from({ length: count }, (_, i) => Math.round(i * (keys.length - 1) / Math.max(1, count - 1))))];
  // Give year changes a real tick, replacing the nearest interior tick to avoid crowding. A change within
  // half a tick spacing of either end would collide with that end's label, so the next tick names the year.
  const gap = (keys.length - 1) / Math.max(1, count - 1) / 2;
  for (let i = 1; i < keys.length; i++) if (keys[i].slice(0, 4) !== keys[i - 1].slice(0, 4) && i >= gap && keys.length - 1 - i >= gap) {
    const candidates = indices.filter((j) => j > 0 && j < keys.length - 1);
    const nearest = candidates.sort((a, b) => Math.abs(a - i) - Math.abs(b - i))[0];
    if (nearest != null) indices[indices.indexOf(nearest)] = i;
  }
  let year = "";
  return [...new Set(indices)].sort((a, b) => a - b).map((index) => {
    const changed = keys[index].slice(0, 4) !== year; year = keys[index].slice(0, 4);
    const shape = changed ? (index && grain !== "day" && keys[index - 1].slice(0, 4) !== year ? "boundary" : "full") : "short";
    const date = new Date(dateNumber(keys[index]));
    return { index, label: dateFormatter(locale, shape).format(date),
      phoneLabel: dateFormatter(locale, index === 0 || year !== keys[0].slice(0, 4) ? "full" : "short").format(date) };
  });
}
function chartSeries(periods, kind, providers = provsIn(state.view)) {
  if (!has(kind)) return [];
  if (kind === "tokens") return TOKEN_TYPES.map((t) => ({ id: `tokens:${t.key}`, label: t.label, color: cssv(t.color), values: periods.map((p) => p.types[t.key]) }));
  if (kind === "cost") return providers.map((p) => ({ id: `cost:${p}`, label: p, color: provColor(p), values: periods.map((d) => d.providers[p] || 0) }));
  return [{ id: "context:mean", label: "Mean context", color: cssv("--cyan"), values: periods.map((p) => p.ctxN ? p.ctxSum / p.ctxN : null) },
    { id: "context:peak", label: "Peak context", color: cssv("--amber"), values: periods.map((p) => p.ctxMax) }];
}
function stackSeries(series) {
  const totals = new Array(series[0]?.values.length || 0).fill(0);
  const layers = series.map((s) => ({ ...s, points: s.values.map((value, i) => {
    const bottom = totals[i]; totals[i] += value || 0;
    return { bottom, top: totals[i] };
  }) }));
  return { totals, layers };
}
function toggleSeries(id) {
  const hidden = state.chartView.hidden;
  state.chartView.hidden = hidden.includes(id) ? hidden.filter((key) => key !== id) : [...hidden, id];
  persist();
  renderCharts();
}
function panZoom(keys, zoom, offset) {
  if (!zoom || keys.length < 3) return null;
  const shown = daysInZoom(keys, zoom), width = shown.length;
  const start = Math.max(0, Math.min(keys.length - width, keys.indexOf(shown[0]) + Math.round(offset)));
  return zoomFromIndices(keys, start, start + width - 1);
}
function overviewMetricLabel() {
  return has("tokens") ? "Daily tokens" : has("cost") ? "Daily cost" : "Daily turns";
}
function overviewNoteText(axis, grain) {
  const coverage = axis === "calendar" ? "Every calendar day, including days with no use" : "Only days with use \u00b7 gaps removed";
  const grouping = grain === "week" ? "grouped by week (Mon\u2013Sun)" : grain === "month" ? "grouped by month" : "shown by day";
  return `${coverage} \u00b7 ${grouping}`;
}
function overviewSelectionText(all, shown, axis) {
  if (!all.length || !shown.length) return "";
  const days = shown.length;
  const unit = axis === "active" ? (days === 1 ? "active day" : "active days") : (days === 1 ? "day" : "days");
  return `Showing ${fmtDay(shown[0])} \u2013 ${fmtDay(shown[shown.length - 1])} \u00b7 ${fmtInt(days)} ${unit}`;
}
// Square-root heights keep a quiet day visible beside a spike; linear scaling
// would collapse it to a sub-pixel sliver. A small nonzero floor guarantees at
// least a hairline even for the quietest day with recorded use.
function overviewBarHeight(value, max) {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.max(1.5, Math.sqrt(value / max) * 28);
}
function overviewIndexAt(allKeys, ratio) {
  if (!allKeys.length) return 0;
  return Math.max(0, Math.min(allKeys.length - 1, Math.floor(ratio * allKeys.length)));
}
// Native arrows move one day; PageUp/PageDown move one week so keyboard users
// can cross a month without dozens of presses. Home/End jump to the ends.
function overviewHandleKey(value, key, maxIndex) {
  if (key === "Home") return 0;
  if (key === "End") return maxIndex;
  if (key === "PageUp") return Math.max(0, Math.min(maxIndex, value - 7));
  if (key === "PageDown") return Math.max(0, Math.min(maxIndex, value + 7));
  if (key === "ArrowLeft" || key === "ArrowUp") return Math.max(0, Math.min(maxIndex, value - 1));
  if (key === "ArrowRight" || key === "ArrowDown") return Math.max(0, Math.min(maxIndex, value + 1));
  return null;
}
// Clicking the dimmed strip outside the window moves the whole window there,
// keeping its width; a click inside the window leaves it where it is.
function overviewClickZoom(allKeys, zoom, ratio) {
  const shown = daysInZoom(allKeys, zoom), width = shown.length;
  if (!allKeys.length || width >= allKeys.length || width < 1) return zoomFromIndices(allKeys, 0, allKeys.length - 1);
  const center = overviewIndexAt(allKeys, ratio);
  if (allKeys[center] >= shown[0] && allKeys[center] <= shown[shown.length - 1]) return zoom;
  let start = Math.round(center - (width - 1) / 2);
  start = Math.max(0, Math.min(allKeys.length - width, start));
  return zoomFromIndices(allKeys, start, start + width - 1);
}
// Dragging the highlighted window pans it by the dragged distance, clamped so
// the window keeps its width at both edges.
function overviewDragZoom(allKeys, zoom, fromRatio, toRatio) {
  if (!zoom) return null;
  const shown = daysInZoom(allKeys, zoom), width = shown.length;
  if (width >= allKeys.length) return null;
  const delta = Math.round((toRatio - fromRatio) * allKeys.length);
  const start = Math.max(0, Math.min(allKeys.length - width, allKeys.indexOf(shown[0]) + delta));
  return zoomFromIndices(allKeys, start, start + width - 1);
}
// The dates under the window's handles, in percent of the strip. Each grows away from the window while
// there is room; a window too narrow to keep two dates apart gets one label for both, kept inside the strip.
function overviewEndLabels(left, width, fromText, toText) {
  const label = (cls, at, text) => `<span class="overview-end-label ${cls}" style="left:${at}%">${esc(text)}</span>`;
  if (width < 30) {
    const centre = left + width / 2;
    const text = fromText === toText ? fromText : `${fromText} – ${toText}`;
    return centre < 25 ? label("from", left, text) : centre > 75 ? label("to", left + width, text) : label("centre", centre, text);
  }
  return label(`from${left > 22 ? " outward" : ""}`, left, fromText) + label(`to${left + width < 78 ? " outward" : ""}`, left + width, toText);
}
function chartControls(all, shown, grain) {
  const select = (name, options, selected) => `<label>${name === "axis" ? "Time axis" : "Group by"}<select data-chart-option="${name}">${options.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("")}</select></label>`;
  const metric = has("tokens") ? "tok" : has("cost") ? "cost" : "n";
  const max = all.reduce((m, key) => Math.max(m, CHART_DAYS.days[key][metric]), 1);
  // At most 240 overview columns, each preserving its bin's peak.
  const stride = Math.max(1, Math.ceil(all.length / 240)), peaks = [];
  for (let i = 0; i < all.length; i += stride) peaks.push(all.slice(i, i + stride).reduce((m, k) => Math.max(m, CHART_DAYS.days[k][metric]), 0));
  const bars = peaks.map((value, i) => { const h = overviewBarHeight(value, max); return `<rect x="${i * 100 / peaks.length}" y="${30 - h}" width="${100 / peaks.length}" height="${h}"/>`; }).join("");
  const start = Math.max(0, all.indexOf(shown[0])), end = Math.max(0, all.indexOf(shown[shown.length - 1]));
  const label = overviewMetricLabel();
  const left = start / all.length * 100, width = (end - start + 1) / all.length * 100;
  return `<div class="card span2 chart-controls"><div class="chart-heading"><div><h2>Usage patterns</h2><p>Explore the filtered turns. Chart views leave totals and the table intact.</p></div><div class="chart-options">${select("axis", [["calendar", "Every day"], ["active", "Days with use only"]], state.chartView.axis)}${select("grain", [["auto", `Automatic (${grain})`], ["day", "Day"], ["week", "Week (Mon\u2013Sun)"], ["month", "Month"]], state.chartView.grain)}</div></div>
    ${all.length ? `<div class="chart-overview"><div class="overview-top"><span class="overview-metric">${esc(label)}</span><span class="overview-scale" title="Square-root scale keeps quiet days visible">Square-root scale</span></div>
    <div class="overview-strip" data-overview-strip style="--cols:${all.length}"><svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="${esc(label)} overview, square-root scale">${bars}</svg><div class="overview-shade" aria-hidden="true" style="left:0;width:${left}%"></div><div class="overview-shade" aria-hidden="true" style="left:${left + width}%;right:0"></div><div class="overview-window" data-overview-window style="left:${left}%;width:${width}%"></div><input class="overview-handle" data-overview="from" role="slider" aria-label="Chart window start" aria-valuemin="0" aria-valuemax="${all.length - 1}" aria-valuenow="${start}" aria-valuetext="${esc(fmtDay(all[start]))}" type="range" min="0" max="${all.length - 1}" value="${start}" step="1"><input class="overview-handle" data-overview="to" role="slider" aria-label="Chart window end" aria-valuemin="0" aria-valuemax="${all.length - 1}" aria-valuenow="${end}" aria-valuetext="${esc(fmtDay(all[end]))}" type="range" min="0" max="${all.length - 1}" value="${end}" step="1"></div>
    <div class="overview-ends" aria-hidden="true">${overviewEndLabels(left, width, fmtDay(all[start]), fmtDay(all[end]))}</div>
    <div class="overview-status"><span class="overview-selection">${esc(overviewSelectionText(all, shown, state.chartView.axis))}</span>${state.zoom ? `<button type="button" class="btn ghost" data-zoom="reset">Show all</button><button type="button" class="btn ghost" data-zoom="filter">Filter to this range</button>` : `<span class="overview-hint">Drag a handle to zoom \u00b7 drag the window to pan \u00b7 click the strip to move it</span>`}</div>
    ${state.zoom ? `<div class="overview-pan"><button type="button" class="btn ghost" data-pan="-1" aria-label="Show earlier dates">\u2190 Earlier</button><button type="button" class="btn ghost" data-pan="1" aria-label="Show later dates">Later \u2192</button></div>` : ""}
    <p class="overview-scope">Charts only \u00b7 totals and table use the date filter</p></div>` : ""}
    <p class="chart-note">${esc(overviewNoteText(state.chartView.axis, grain))}</p></div>`;
}
let chartModels = Object.create(null), sharedDateTicks = [];
function prepareChartData(periods, grain, providers) {
  sharedDateTicks = dateTicks(periods.map((p) => p.from), 4, grain);
  chartModels = Object.create(null);
  for (const kind of ["tokens", "cost", "context"]) {
    const allSeries = chartSeries(periods, kind, providers);
    for (const s of allSeries) s.total = s.values.reduce((a, b) => a + (b || 0), 0);
    const series = allSeries.filter((s) => !state.chartView.hidden.includes(s.id));
    const stack = stackSeries(series), total = stack.totals.reduce((a, b) => a + b, 0);
    const ctxN = kind === "context" ? periods.reduce((a, p) => a + p.ctxN, 0) : 0;
    chartModels[kind] = { allSeries, series, stack, average: total / (periods.length || 1),
      mean: ctxN ? periods.reduce((a, p) => a + p.ctxSum, 0) / ctxN : null,
      peak: periods.reduce((a, p) => p.ctxMax == null ? a : Math.max(a ?? 0, p.ctxMax), null) };
  }
}
const chartFormat = (kind) => kind === "cost" ? fmtUsd : kind === "context" ? (v) => `${fmtInt(Math.round(v))}%` : fmtTok;
function chartDataTable(kind) {
  if (!has(kind)) return "";
  const periods = CHART_DAYS.periods, series = chartModels[kind].series, format = chartFormat(kind);
  return `<table class="agent-table"><thead><tr><th>Period</th><th>Turns</th>${series.map((s) => `<th>${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${periods.map((p, i) => `<tr><td>${esc(fmtDay(p.from))}${p.to !== p.from ? ` – ${esc(fmtDay(p.to))}` : ""}</td><td>${fmtInt(p.n)}</td>${series.map((s) => `<td>${s.values[i] == null ? "—" : esc(format(s.values[i]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function chartPlot(periods, kind, series, stack, average, identity = kind) {
  const n = periods.length, isContext = kind === "context";
  const maximum = isContext ? series.reduce((max, s) => s.values.reduce((m, v) => Math.max(m, v || 0), max), 0) : stack.totals.reduce((a, b) => Math.max(a, b), 0);
  const scale = isContext && maximum <= 100 ? { max: 100, ticks: [0, 25, 50, 75, 100] } : niceScale(maximum);
  const W = 640, H = 160, x = (i) => (i + .5) / n * W, y = (v) => H - v / scale.max * H;
  let plot = scale.ticks.map((t) => `<line x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="${cssv("--line-2")}"/>`).join("");
  if (isContext) {
    for (const s of series) {
      let path = "", previous = false;
      for (let i = 0; i < n; i++) {
        const value = s.values[i];
        if (value == null) { previous = false; continue; }
        path += `${previous ? "L" : "M"}${x(i)},${y(value)} `; previous = true;
        if (n <= 60 || (s.values[i - 1] == null && s.values[i + 1] == null)) plot += `<circle cx="${x(i)}" cy="${y(value)}" r="2.5" fill="${s.color}"/>`;
      }
      plot += `<path data-context="${s.id}" d="${path}" fill="none" stroke="${s.color}" stroke-width="2"${s.id === "context:peak" ? ' stroke-dasharray="5 3"' : ""}/>`;
    }
  } else for (const layer of stack.layers) {
    if (kind === "tokens" && n > 1) {
      const top = layer.points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.top)}`).join(" ");
      const bottom = layer.points.map((p, i) => `L${x(i)},${y(p.bottom)}`).reverse().join(" ");
      plot += `<path class="token-area" d="${top} ${bottom} Z" fill="${layer.color}" fill-opacity=".72"/>`;
    } else plot += layer.points.map((p, i) => `<rect x="${x(i) - W / n * .36}" y="${y(p.top)}" width="${W / n * .72}" height="${(p.top - p.bottom) / scale.max * H}" fill="${layer.color}"/>`).join("");
  }
  if (!isContext && series.length) plot += `<line class="chart-average" x1="0" x2="${W}" y1="${y(average)}" y2="${y(average)}" stroke="${cssv("--text")}" stroke-dasharray="5 5" opacity=".55"/>`;
  const axes = `<div class="chart-y">${scale.ticks.slice().reverse().map((v) => `<span>${esc(fmtAxis(v, kind))}</span>`).join("")}</div>`;
  const labels = `<div class="chart-x">${sharedDateTicks.map((t) => `<span style="left:${(t.index + .5) / n * 100}%"><i class="date-desktop">${esc(t.label)}</i><i class="date-phone">${esc(t.phoneLabel)}</i></span>`).join("")}</div>`;
  return `<div class="chart-frame">${axes}<div>${interactive(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${plot}</svg>`, periods.map((p) => p.key), identity)}${labels}</div></div>`;
}
function timeChart(periods, kind) {
  if (!periods.length) return emptyChart();
  const model = chartModels[kind], { allSeries, series, stack, average } = model;
  const format = chartFormat(kind);
  const legend = `<div class="legend series-legend">${allSeries.map((s) => {
    const value = kind === "context" ? (s.id === "context:peak" ? model.peak : model.mean) : s.total;
    return `<button type="button" data-series="${esc(s.id)}" aria-pressed="${!state.chartView.hidden.includes(s.id)}"><i style="background:${s.color}"></i>${esc(s.label)}<b>${value == null ? "—" : esc(format(value))}</b></button>`;
  }).join("")}</div>`;
  const note = kind === "context" ? "Mean and peak of recorded observations; gaps mean no measurement." : kind === "tokens" ? "Independent scales · shared dates · dashed period averages" : `Visible series · ${format(average)} average / ${CHART_DAYS.grain} (dashed).`;
  const body = kind === "tokens" ? `<div class="token-multiples">${series.map((s) => `<section class="token-panel" aria-label="${s.label} tokens"><h4>${s.label}</h4>${chartPlot(periods, kind, [s], stackSeries([s]), s.total / periods.length, s.id)}</section>`).join("")}</div>` : chartPlot(periods, kind, series, stack, average);
  return `<p class="chart-note">${series.length ? esc(note) : "All series hidden · select a legend entry to show it"}</p>${legend}${body}<details class="chart-data" data-chart-table="${kind}"><summary>View ${kind} data · ${fmtInt(periods.length)} periods</summary><div class="agent-wrap"></div></details>`;
}

function renderCharts() {
  chartColors = { style: getComputedStyle(document.documentElement) };
  try { renderChartContents(); } finally { chartColors = null; }
}
function renderChartContents() {
  const v = state.view;
  // One turn scan supplies both time charts and full-view distributions.
  const days = Object.create(null), modelCount = Object.create(null), modeCount = Object.create(null), skillCount = Object.create(null);
  const agentStats = Object.create(null), modelNames = new Map(), buckets = new Array(10).fill(0);
  for (const e of v) {
    const p = PROV(e), tokens = T_TOTAL(e), cost = COST(e);
    if (!modelNames.has(e.model)) modelNames.set(e.model, shortModel(e.model));
    const m = modelNames.get(e.model), mode = e.permissionMode || "—";
    modelCount[m] = (modelCount[m] || 0) + 1; modeCount[mode] = (modeCount[mode] || 0) + 1;
    for (const skill of e.skills || []) skillCount[skill] = (skillCount[skill] || 0) + 1;
    if (contextObserved(e)) buckets[Math.max(0, Math.min(9, Math.floor(e.contextFillPct / 10)))]++;
    const agent = agentStats[p] ||= { turns: 0, prompts: 0, tok: 0, cost: 0, ms: 0 };
    agent.turns++; if (!e.synthetic) agent.prompts++;
    agent.tok += tokens; agent.cost += cost; agent.ms += e.durationMs || 0;
    const k = dayKey(e.ts);
    if (!days[k]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !Number.isFinite(dateNumber(k))) continue;
      days[k] = blankPeriod(k);
    }
    days[k].tok += tokens; days[k].cost += cost; days[k].n++;
    for (const type of TOKEN_TYPES) days[k].types[type.key] += e.usage?.[type.key] || 0;
    days[k].providers[p] = (days[k].providers[p] || 0) + cost;
    if (contextObserved(e)) { days[k].ctxSum += e.contextFillPct; days[k].ctxN++; days[k].ctxMax = Math.max(days[k].ctxMax ?? 0, e.contextFillPct); }
    if (m) days[k].models[m] = (days[k].models[m] || 0) + 1;
  }
  const activeKeys = Object.keys(days).sort();
  const allKeys = calendarKeys(activeKeys, state.chartView.axis);
  for (const k of allKeys) days[k] ||= blankPeriod(k);
  // What the time charts show: every day, or the window zoomed into. The rest of
  // the dashboard keeps counting every turn in the view — a zoom is a closer
  // look, not a filter, until it is asked to become one.
  // A zoom the data no longer reaches — the filters moved past it — is dropped
  // rather than kept beside a chart that has fallen back to showing every day,
  // where its buttons would act on dates nobody can see.
  if (state.zoom && !allKeys.some((k) => k >= state.zoom.from && k <= state.zoom.to)) state.zoom = null;
  const keys = daysInZoom(allKeys, state.zoom);
  const grain = chartGrain(keys.length, state.chartView.grain);
  const periods = bucketPeriods(days, keys, grain);
  CHART_DAYS = { days, allKeys, keys, periods, grain };
  const provs = provsIn(Object.keys(agentStats).map((provider) => ({ provider })));
  prepareChartData(periods, grain, provs);
  const tok = keys.map((k) => days[k].tok);
  const cost = keys.map((k) => days[k].cost);

  const skillsUsed = Object.keys(skillCount).length;

  const cards = [];
  if (has("tokens") || has("cost") || has("context")) cards.push(chartControls(allKeys, keys, grain));
  if (has("tokens")) cards.push(`<div class="card span2 time-card">
      <h3>tokens over time <b title="All token types in the shown range">${fmtTok(tok.reduce((a, b) => a + b, 0))}</b></h3>
      ${timeChart(periods, "tokens")}${zoomBar(allKeys, keys)}
    </div>`);
  if (has("cost")) cards.push(`<div class="card span2 time-card"><h3>cost / ${grain} <b class="cost-b" title="All providers in the shown range">${fmtUsd(cost.reduce((a, b) => a + b, 0))}</b></h3>${timeChart(periods, "cost")}${has("tokens") ? "" : zoomBar(allKeys, keys)}</div>`);
  if (has("context")) cards.push(`<div class="card time-card"><h3>context fill over time <b title="Mean of recorded observations in the shown range">${chartModels.context.mean == null ? "—" : chartFormat("context")(chartModels.context.mean)}</b></h3>${timeChart(periods, "context")}${has("tokens") || has("cost") ? "" : zoomBar(allKeys, keys)}</div>`);
  if (has("context")) cards.push(`<div class="card"><h3>context fill distribution</h3><p class="chart-note">All filtered turns · hover or focus a bucket for its count and share</p>${histogram(buckets)}</div>`);
  cards.push(`<div class="card"><h3>permission mode</h3>${donut(modeCount, (x) => x + " turns")}</div>`);
  cards.push(`<div class="card"><h3>turns by model</h3>${donut(modelCount, (x) => x + " turns")}</div>`);
  if (has("skills") && skillsUsed) cards.push(`<div class="card"><h3>skills invoked <b>${skillsUsed}</b></h3>${donut(skillCount, (x) => x + "×")}</div>`);
  // The zoom controls live under the tokens chart; with tokens not kept, under cost.
  // Per-provider breakdowns — only when the view spans more than one provider.
  if (provs.length > 1) {
    const tokByProv = {}, costByProv = {};
    for (const p of provs) { tokByProv[p] = agentStats[p].tok; costByProv[p] = agentStats[p].cost; }
    cards.push(`<div class="card span2"><h3>by agent</h3>${agentTable(v, { provs, stat: agentStats })}</div>`);
    if (has("tokens")) cards.push(`<div class="card"><h3>tokens by provider</h3>${provDonut(tokByProv, (x) => fmtTok(x))}</div>`);
    if (has("cost")) cards.push(`<div class="card"><h3>cost by provider</h3>${provDonut(costByProv, (x) => fmtUsd(x))}</div>`);
  }
  $("#charts").innerHTML = cards.join("");
  wireCharts();
}

// The days each time chart is drawing, and the totals behind them, so a pointer
// landing anywhere over a chart can say what that day held.
let CHART_DAYS = { days: {}, allKeys: [], keys: [] };

/** The slice of days a zoom window covers; every day when there is no zoom. */
function daysInZoom(allKeys, zoom) {
  if (!zoom) return allKeys;
  const within = allKeys.filter((k) => k >= zoom.from && k <= zoom.to);
  return within.length ? within : allKeys;
}

/** Which day a pointer at this fraction across a chart is pointing at. */
function dayIndexAt(count, ratio) {
  if (count < 1) return -1;
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
}

/**
 * A zoom window over two day indices. Never narrower than two days, and null
 * once it covers everything — a zoom that spans the whole range is no zoom, and
 * saying so keeps one reset path instead of two.
 */
function zoomFromIndices(allKeys, a, b) {
  if (allKeys.length < 3) return null;
  let lo = Math.max(0, Math.min(allKeys.length - 1, Math.round(Math.min(a, b))));
  let hi = Math.max(0, Math.min(allKeys.length - 1, Math.round(Math.max(a, b))));
  if (hi - lo < 1) { // a click, not a drag: open a small window around it
    lo = Math.max(0, lo - 1);
    hi = Math.min(allKeys.length - 1, lo + 2);
  }
  if (lo <= 0 && hi >= allKeys.length - 1) return null;
  return { from: allKeys[lo], to: allKeys[hi] };
}

/** Scale the window about the day under the pointer. Out far enough, and it goes. */
function zoomByFactor(allKeys, zoom, factor, ratio) {
  const shown = daysInZoom(allKeys, zoom);
  if (allKeys.length < 3 || !shown.length) return null;
  const start = allKeys.indexOf(shown[0]);
  const end = allKeys.indexOf(shown[shown.length - 1]);
  const anchor = start + dayIndexAt(shown.length, ratio);
  const span = Math.max(2, Math.round((end - start + 1) * factor));
  const before = Math.round((anchor - start) * factor);
  let lo = anchor - before;
  let hi = lo + span - 1;
  if (lo < 0) { hi -= lo; lo = 0; }
  if (hi > allKeys.length - 1) { lo -= hi - (allKeys.length - 1); hi = allKeys.length - 1; }
  return zoomFromIndices(allKeys, Math.max(0, lo), hi);
}

/** What the pointer is over, as the tooltip says it. */
function dayTooltip(key) {
  const d = CHART_DAYS.days[key];
  if (!d) return "";
  const top = Object.entries(d.models || {}).sort((a, b) => b[1] - a[1])[0];
  const rows = [
    ["turns", fmtInt(d.n)],
    has("tokens") ? ["tokens", fmtTok(d.tok)] : null,
    has("cost") ? ["cost", fmtUsd(d.cost)] : null,
    top ? ["mostly", `${top[0]} (${fmtInt(top[1])})`] : null,
  ].filter(Boolean);
  return `<b>${esc(fmtDay(key))}</b>${rows.map(([k, val]) => `<span>${esc(k)}<i>${esc(val)}</i></span>`).join("")}`;
}

function periodTooltip(key, kind) {
  const periods = CHART_DAYS.periods || [], p = periods.find((d) => d.key === key);
  if (!p) return dayTooltip(key);
  const base = kind.split(":")[0], model = chartModels[base];
  const series = has(base) ? model.series.filter((s) => !kind.includes(":") || s.id === kind) : [];
  const i = periods.indexOf(p), format = chartFormat(base);
  const top = Object.entries(p.models).sort((a, b) => b[1] - a[1])[0];
  const rows = [["turns", fmtInt(p.n)],
    has("tokens") ? ["tokens", fmtTok(p.tok)] : null,
    has("cost") ? ["cost", fmtUsd(p.cost)] : null,
    ...series.map((s) => [s.label, s.values[i] == null ? "No measurement" : format(s.values[i])]),
    top ? ["mostly", `${top[0]} (${fmtInt(top[1])})`] : null].filter(Boolean);
  if (series.length && base !== "context") {
    const total = kind.includes(":") ? series[0].values[i] : model.stack.totals[i];
    const avg = kind.includes(":") ? series[0].total / periods.length : model.average;
    rows.push(["vs visible period mean", avg ? `${comparisonFormat.format(total / avg - 1)}` : "—"]);
  }
  return `<b>${esc(fmtDay(p.from))}${p.from !== p.to ? ` – ${esc(fmtDay(p.to))}` : ""}</b>${rows.map(([label, value]) => `<span>${esc(label)}<i>${esc(value)}</i></span>`).join("")}`;
}

const fmtDay = (key) => {
  const d = new Date(`${key}T00:00:00Z`);
  return isNaN(d) ? key : dateFormatter(undefined, "full").format(d);
};
const comparisonFormat = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0, signDisplay: "always" });

/** The state of a zoom, and the two things worth doing about it. */
function zoomBar(allKeys, shown) {
  if (!allKeys.length) return "";
  const help = `<details class="chart-help"><summary>Keyboard &amp; help</summary><p>Drag to zoom · Ctrl/⌘ + scroll, pinch or +/− to scale · ←/→ to read · Home/End for endpoints · Shift+←/→ to pan · Escape or double-click to reset</p></details>`;
  if (!state.zoom) {
    return `<div class="chart-zoom"><span class="hint">Drag or Ctrl + scroll to zoom · hover or tap to read</span>${help}</div>`;
  }
  return `<div class="chart-zoom">
    <span class="range">${esc(overviewSelectionText(allKeys, shown, state.chartView.axis))}</span>
    <button type="button" class="btn ghost" data-zoom="filter">Filter to this range</button>
    <button type="button" class="btn ghost" data-zoom="reset">Show all</button>
    ${help}
  </div>`;
}

/** Wrap a time chart in the layer the pointer talks to. */
function interactive(body, keys, kind) {
  return `<div class="chart" tabindex="0" role="group" aria-label="${kind} time chart. Arrow keys read periods, plus and minus zoom, Shift with arrows pans, Escape resets. Data table follows." data-kind="${kind}" data-days="${esc(keys.join(","))}">
    ${body}
    <div class="chart-cursor" hidden></div>
    <div class="chart-brush" hidden></div>
    <div class="chart-tip" hidden></div>
  </div>`;
}

function donut(map, fmt) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return emptyChart();
  const PAL = palette();
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = entries
    .map(([k, v], i) => {
      const frac = v / total, len = frac * C, col = PAL[i % PAL.length];
      const seg = `<circle class="donut-arc" data-share="${esc(k)}" r="${R}" cx="70" cy="70" fill="none" stroke="${col}" stroke-width="16"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
        transform="rotate(-90 70 70)"><title>${esc(k)} · ${esc(fmt(v))} · ${sharePct(frac)}</title></circle>`;
      off += len; return seg;
    })
    .join("");
  const legend = entries
    .map(([k, v], i) => `<span tabindex="0" data-share="${esc(k)}" title="${esc(k)} · ${esc(fmt(v))} · ${sharePct(v / total)} of the total"><i style="background:${PAL[i % PAL.length]}"></i>${esc(k)} · ${fmt(v)}</span>`)
    .join("");
  return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <svg viewBox="0 0 140 140" style="width:128px;height:128px;flex:0 0 auto">${arcs}
      <text x="70" y="66" text-anchor="middle" fill="${cssv("--text")}" font-family="var(--display)" font-size="20" font-weight="600">${entries.length}</text>
      <text x="70" y="84" text-anchor="middle" fill="${cssv("--muted")}" font-family="var(--mono)" font-size="8" letter-spacing="1">TYPES</text>
    </svg><div class="legend" style="flex:1">${legend}</div></div>`;
}

// Donut keyed by provider, so each slice uses that provider's brand color.
// Per-agent breakdown. Work delegated to another agent — a delegate skill
// shelling out to another CLI — is spend on this project like any other, but it
// lands under a different provider and would otherwise disappear into one total.
function agentTable(rows, prepared) {
  const provs = prepared ? prepared.provs : provsIn(rows);
  if (!provs.length) return emptyChart();
  const stat = prepared ? prepared.stat : {};
  if (!prepared) for (const p of provs) stat[p] = { turns: 0, prompts: 0, tok: 0, cost: 0, ms: 0 };
  if (!prepared) for (const e of rows) {
    const s = stat[PROV(e)];
    if (!s) continue;
    s.turns += 1;
    if (!e.synthetic) s.prompts += 1;
    s.tok += T_TOTAL(e);
    s.cost += COST(e);
    s.ms += e.durationMs || 0;
  }
  const total = provs.reduce((a, p) => a + stat[p].cost, 0);
  const ordered = provs.slice().sort((a, b) => stat[b].cost - stat[a].cost);
  const body = ordered.map((p) => {
    const s = stat[p];
    const share = total > 0 ? (s.cost / total) * 100 : 0;
    return `<tr>
      <td><span class="agent-name"><span class="prov-dot" style="background:${provColor(p)}"></span>${esc(p)}</span></td>
      <td class="num">${fmtInt(s.prompts)}</td>
      ${has("tokens") ? `<td class="num">${fmtTok(s.tok)}</td>` : ""}
      ${has("timing") ? `<td class="num">${fmtDur(s.ms)}</td>` : ""}
      ${has("cost") ? `<td class="num cost-b">${fmtUsd(s.cost)}</td>` : ""}
      ${has("cost") ? `<td class="num muted">${total > 0 ? share.toFixed(0) + "%" : "—"}</td>` : ""}
    </tr>`;
  }).join("");
  return `<div class="agent-wrap"><table class="agent-table">
    <thead><tr>
      <th>agent</th><th class="num">prompts</th>
      ${has("tokens") ? `<th class="num">tokens</th>` : ""}
      ${has("timing") ? `<th class="num">active</th>` : ""}
      ${has("cost") ? `<th class="num">cost</th>` : ""}
      ${has("cost") ? `<th class="num">share</th>` : ""}
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

function provDonut(map, fmt) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return emptyChart();
  const R = 52, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = entries.map(([k, v]) => {
    const len = (v / total) * C, col = provColor(k);
    const seg = `<circle class="donut-arc" data-share="${esc(k)}" r="${R}" cx="70" cy="70" fill="none" stroke="${col}" stroke-width="16"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 70 70)"><title>${esc(k)} · ${esc(fmt(v))} · ${sharePct(v / total)}</title></circle>`;
    off += len; return seg;
  }).join("");
  const legend = entries.map(([k, v]) => `<span tabindex="0" data-share="${esc(k)}" title="${esc(k)} · ${esc(fmt(v))} · ${sharePct(v / total)} of the total"><i style="background:${provColor(k)}"></i>${esc(k)} · ${fmt(v)}</span>`).join("");
  return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <svg viewBox="0 0 140 140" style="width:128px;height:128px;flex:0 0 auto">${arcs}
      <text x="70" y="66" text-anchor="middle" fill="${cssv("--text")}" font-family="var(--display)" font-size="20" font-weight="600">${entries.length}</text>
      <text x="70" y="84" text-anchor="middle" fill="${cssv("--muted")}" font-family="var(--mono)" font-size="8" letter-spacing="1">AGENTS</text>
    </svg><div class="legend" style="flex:1">${legend}</div></div>`;
}

function histogram(buckets) {
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  const cHot = cssv("--accent"), cWarn = cssv("--amber"), cCool = cssv("--cyan"), cLabel = cssv("--faint");
  const bars = buckets
    .map((c, i) => {
      const h = (c / max) * 92, hot = i >= 8 ? cHot : i >= 5 ? cWarn : cCool;
      return `<div class="hist-bucket" tabindex="0" aria-label="${i * 10} to ${i * 10 + 10}% context, ${fmtInt(c)} turns" title="${i * 10}–${i * 10 + 10}% of the window · ${fmtInt(c)} turns · ${sharePct(c / (total || 1))}" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px">
        <div style="width:100%;height:${h}px;min-height:${c ? 2 : 0}px;background:${hot};border-radius:3px 3px 0 0"></div>
        <span style="font-family:var(--mono);font-size:8px;color:${cLabel}">${i * 10}</span></div>`;
    })
    .join("");
  return `<div class="histogram" style="display:flex;align-items:flex-end;gap:3px;height:118px">${bars}</div><p class="chart-note">Context fill % · recorded observations only</p>`;
}

const sharePct = (frac) => `${(frac * 100).toFixed(frac < 0.1 ? 1 : 0)}%`;

const emptyChart = () => `<div style="height:120px;display:grid;place-items:center;color:var(--faint);font-family:var(--mono);font-size:11px">no data in range</div>`;

// ---------- chart pointer handling ----------
// Charts are redrawn whole on every change, so each render re-attaches. Listeners
// belong to the elements they are drawn on and go with them.
function wireCharts() {
  const query = (selector) => document.querySelectorAll ? document.querySelectorAll(`#charts ${selector}`) : [];
  for (const detail of query("[data-chart-table]")) detail.addEventListener("toggle", () => {
    if (!detail.open || detail.dataset.loaded) return;
    detail.querySelector(".agent-wrap").innerHTML = chartDataTable(detail.dataset.chartTable);
    detail.dataset.loaded = "true";
  });
  for (const button of query("[data-series]")) button.addEventListener("click", () => {
    const id = button.dataset.series; toggleSeries(id);
    [...query("[data-series]")].find((node) => node.dataset.series === id)?.focus();
  });
  for (const select of query("[data-chart-option]")) select.addEventListener("change", () => {
    state.chartView[select.dataset.chartOption] = select.value;
    state.chartView = validateChartView(state.chartView);
    persist();
    renderCharts();
    [...query("[data-chart-option]")].find((node) => node.dataset.chartOption === select.dataset.chartOption)?.focus();
  });
  for (const slider of query("[data-overview]")) {
    const applySlider = () => {
      const all = CHART_DAYS.allKeys, keys = CHART_DAYS.keys;
      const from = slider.dataset.overview === "from" ? Math.min(Number(slider.value), all.indexOf(keys[keys.length - 1])) : all.indexOf(keys[0]);
      const to = slider.dataset.overview === "to" ? Math.max(Number(slider.value), all.indexOf(keys[0])) : all.indexOf(keys[keys.length - 1]);
      state.zoom = zoomFromIndices(all, from, to); renderCharts();
      [...query("[data-overview]")].find((node) => node.dataset.overview === slider.dataset.overview)?.focus?.();
    };
    slider.addEventListener("change", applySlider);
    // Native arrows/Home/End already move one day or to the ends; PageUp and
    // PageDown are widened to a full week so keyboard users cross months fast.
    slider.addEventListener("keydown", (event) => {
      const maxIndex = CHART_DAYS.allKeys.length - 1;
      if (maxIndex < 0) return;
      const current = Number(slider.value);
      const next = overviewHandleKey(current, event.key, maxIndex);
      if (next == null) return;
      event.preventDefault();
      if (next === current) return;
      slider.value = String(next);
      applySlider();
    });
  }
  // The strip behind the handles: a click on the dimmed area moves the whole
  // window there, and a press-drag inside the window pans it. Handle thumbs
  // keep their own pointer handling, so presses starting on them are ignored.
  for (const strip of query("[data-overview-strip]")) {
    const ratioOf = (event) => {
      const box = typeof strip.getBoundingClientRect === "function" ? strip.getBoundingClientRect() : null;
      if (!box || !box.width) return null;
      return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    };
    strip.addEventListener("pointerdown", (event) => {
      if (event.target && event.target !== strip && event.target.dataset && event.target.dataset.overview) return;
      const ratio = ratioOf(event);
      if (ratio == null) return;
      strip.dataset.pressRatio = String(ratio);
    });
    strip.addEventListener("pointerup", (event) => {
      if (strip.dataset.pressRatio == null) return;
      const from = Number(strip.dataset.pressRatio);
      delete strip.dataset.pressRatio;
      const ratio = ratioOf(event);
      if (ratio == null) return;
      const all = CHART_DAYS.allKeys;
      if (!all.length || !state.zoom) return;
      const startIdx = all.indexOf(CHART_DAYS.keys[0]), endIdx = all.indexOf(CHART_DAYS.keys[CHART_DAYS.keys.length - 1]);
      const upIdx = overviewIndexAt(all, ratio), downIdx = overviewIndexAt(all, from);
      const inside = (i) => i >= startIdx && i <= endIdx;
      const next = inside(upIdx) && inside(downIdx) ? overviewDragZoom(all, state.zoom, from, ratio) : overviewClickZoom(all, state.zoom, ratio);
      if (next && (next.from !== state.zoom.from || next.to !== state.zoom.to)) { state.zoom = next; renderCharts(); }
    });
  }
  for (const button of query("[data-pan]")) button.addEventListener("click", () => {
    state.zoom = panZoom(CHART_DAYS.allKeys, state.zoom, Number(button.dataset.pan) * Math.max(1, Math.floor(CHART_DAYS.keys.length / 2)));
    renderCharts();
    [...query("[data-pan]")].find((node) => node.dataset.pan === button.dataset.pan)?.focus();
  });
  for (const card of query(".card")) {
    const items = card.querySelectorAll("[data-share]");
    for (const item of items) {
      const highlight = (active) => { for (const peer of items) peer.classList.toggle("share-active", active && peer.dataset.share === item.dataset.share); };
      item.addEventListener("mouseenter", () => highlight(true));
      item.addEventListener("mouseleave", () => highlight(false));
      item.addEventListener("focus", () => highlight(true));
      item.addEventListener("blur", () => highlight(false));
    }
  }
  const charts = document.querySelectorAll ? document.querySelectorAll("#charts .chart") : [];
  for (const chart of charts) attachChart(chart);
  const buttons = document.querySelectorAll ? document.querySelectorAll("#charts [data-zoom]") : [];
  for (const button of buttons) {
    button.addEventListener("click", () => {
      if (button.dataset.zoom === "reset") { state.zoom = null; renderCharts(); return; }
      // The look becomes the filter: everything else now counts the days the chart
      // is showing — its first and last, not whatever the zoom was last set to.
      const shown = CHART_DAYS.keys;
      if (!state.zoom || !shown.length) return;
      state.filters.since = shown[0];
      state.filters.until = shown[shown.length - 1];
      state.zoom = null;
      reflect();
      apply();
    });
  }
}

function chartKeyAction(key, shift, index, count) {
  if (key === "Escape") return { reset: true };
  if (key === "+" || key === "=") return { factor: .8 };
  if (key === "-" || key === "_") return { factor: 1.25 };
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const delta = key === "ArrowLeft" ? -1 : 1;
    return shift ? { pan: delta } : { index: Math.max(0, Math.min(count - 1, index + delta)) };
  }
  if (key === "Home" || key === "End") return { index: key === "Home" ? 0 : count - 1 };
  return null;
}

function attachChart(chart) {
  const days = (chart.dataset.days || "").split(",").filter(Boolean);
  const cursor = chart.querySelector(".chart-cursor");
  const brush = chart.querySelector(".chart-brush");
  const tip = chart.querySelector(".chart-tip");
  if (!days.length || !cursor || !brush || !tip) return;
  const ratioAt = (event) => {
    const box = chart.getBoundingClientRect();
    return box.width ? Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) : 0;
  };
  let dragFrom = null;
  let selected = 0, lastTip = -1;
  const periodIndex = (ratio) => Math.max(0, Math.min(days.length - 1, Math.floor(ratio * days.length)));
  const show = (i, announce = false) => {
    selected = i;
    const at = (i + .5) / days.length * 100;
    cursor.hidden = false; cursor.style.left = `${at}%`;
    tip.hidden = false;
    tip.setAttribute("aria-live", announce ? "polite" : "off");
    if (lastTip !== i) { tip.innerHTML = periodTooltip(days[i], chart.dataset.kind); lastTip = i; }
    tip.style.left = `${Math.max(10, Math.min(90, at))}%`;
    tip.dataset.side = at > 70 ? "right" : at < 30 ? "left" : "center";
  };
  const redraw = () => {
    const kind = chart.dataset.kind; renderCharts();
    document.querySelector(`#charts .chart[data-kind="${kind}"]`)?.focus();
  };
  chart.addEventListener("focus", () => show(selected, true));
  chart.addEventListener("blur", () => { tip.hidden = true; cursor.hidden = true; });
  chart.addEventListener("keydown", (event) => {
    const action = chartKeyAction(event.key, event.shiftKey, selected, days.length);
    if (!action) return;
    event.preventDefault();
    if (action.index != null) { show(action.index, true); return; }
    if (action.reset) state.zoom = null;
    if (action.factor) state.zoom = zoomByFactor(CHART_DAYS.allKeys, state.zoom, action.factor, (selected + .5) / days.length);
    if (action.pan) state.zoom = panZoom(CHART_DAYS.allKeys, state.zoom, action.pan * Math.max(1, Math.floor(CHART_DAYS.keys.length / 2)));
    redraw();
  });

  chart.addEventListener("mousemove", (event) => {
    const ratio = ratioAt(event);
    const i = periodIndex(ratio);
    if (i < 0) return;
    const at = (i + .5) / days.length * 100;
    show(i);
    // Keep the card's edges: a tip near either end leans inward instead of
    // spilling out of the panel it belongs to.
    tip.style.left = `${Math.max(10, Math.min(90, at))}%`;
    tip.dataset.side = at > 70 ? "right" : at < 30 ? "left" : "center";
    if (dragFrom !== null) {
      const a = Math.min(dragFrom, ratio) * 100, b = Math.max(dragFrom, ratio) * 100;
      brush.hidden = false;
      brush.style.left = `${a}%`;
      brush.style.width = `${b - a}%`;
    }
  });

  chart.addEventListener("mouseleave", () => {
    cursor.hidden = true;
    tip.hidden = true;
    brush.hidden = true;
    dragFrom = null;
  });

  chart.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    dragFrom = ratioAt(event);
    event.preventDefault();
  });

  chart.addEventListener("mouseup", (event) => {
    if (dragFrom === null) return;
    const from = dragFrom, to = ratioAt(event);
    dragFrom = null;
    brush.hidden = true;
    // A drag too short to be deliberate is a click, and a click is not a zoom.
    if (Math.abs(to - from) < 0.01) return;
    const all = CHART_DAYS.allKeys;
    const periods = CHART_DAYS.periods;
    const first = periods[periodIndex(Math.min(from, to))], last = periods[periodIndex(Math.max(from, to))];
    const a = all.indexOf(first.from);
    const b = all.indexOf(last.to);
    const next = zoomFromIndices(all, a, b);
    if (next) { state.zoom = next; renderCharts(); }
  });

  chart.addEventListener("dblclick", () => {
    if (!state.zoom) return;
    state.zoom = null;
    renderCharts();
  });

  // A plain wheel scrolls the page, as it does anywhere else; Ctrl (⌘ on a Mac) zooms, the way maps do.
  // A trackpad pinch arrives as a wheel with ctrlKey set, so pinching zooms too.
  chart.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (CHART_DAYS.allKeys.length < 3) return;
    event.preventDefault();
    const next = zoomByFactor(CHART_DAYS.allKeys, state.zoom, event.deltaY < 0 ? 0.8 : 1.25, ratioAt(event));
    if (next === state.zoom) return;
    if (!next && !state.zoom) return;
    state.zoom = next;
    renderCharts();
  }, { passive: false });
  // Safari reports a trackpad pinch as gesture events carrying a scale, not as Ctrl + wheel. The pinch is
  // applied once the fingers lift: zooming mid-gesture would redraw the chart, and Safari keeps sending the
  // rest of the gesture to the element that was replaced. Taking gesturestart also stops the page zooming.
  let pinchAt = 0.5;
  chart.addEventListener("gesturestart", (event) => { event.preventDefault(); pinchAt = ratioAt(event); });
  chart.addEventListener("gesturechange", (event) => event.preventDefault());
  chart.addEventListener("gestureend", (event) => {
    event.preventDefault();
    const scale = Number(event.scale);
    if (CHART_DAYS.allKeys.length < 3 || !(scale > 0) || Math.abs(Math.log(scale)) < 0.05) return;
    const next = zoomByFactor(CHART_DAYS.allKeys, state.zoom, Math.min(5, Math.max(0.2, 1 / scale)), pinchAt);
    if (next === state.zoom || (!next && !state.zoom)) return;
    state.zoom = next;
    renderCharts();
  });
  // Touch pans the page vertically; horizontal drags select a chart window.
  // Mouse listeners remain for compatibility; pointer listeners handle touch/pen only.
  chart.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    dragFrom = ratioAt(event); chart.setPointerCapture(event.pointerId); show(periodIndex(dragFrom));
  });
  chart.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse" || dragFrom === null) return;
    const ratio = ratioAt(event); show(periodIndex(ratio));
    brush.hidden = false; brush.style.left = `${Math.min(ratio, dragFrom) * 100}%`;
    brush.style.width = `${Math.abs(ratio - dragFrom) * 100}%`;
  });
  chart.addEventListener("pointerup", (event) => {
    if (event.pointerType === "mouse" || dragFrom === null) return;
    const ratio = ratioAt(event), from = dragFrom; dragFrom = null; brush.hidden = true;
    if (Math.abs(ratio - from) < .02) return;
    const periods = CHART_DAYS.periods, all = CHART_DAYS.allKeys;
    state.zoom = zoomFromIndices(all, all.indexOf(periods[periodIndex(Math.min(from, ratio))].from), all.indexOf(periods[periodIndex(Math.max(from, ratio))].to));
    renderCharts();
  });
  chart.addEventListener("pointercancel", () => { dragFrom = null; brush.hidden = true; tip.hidden = true; cursor.hidden = true; });
}

// ---------- table ----------
function sorted() {
  const { key, dir } = state.sort;
  const accessor = { _in: T_IN, _out: T_OUT, _cost: COST, provider: PROV }[key] || ((e) => e[key]);
  return [...state.view].sort((a, b) => {
    let x = accessor(a), y = accessor(b);
    if (typeof x === "string") return x.localeCompare(y) * dir;
    return ((x || 0) - (y || 0)) * dir;
  });
}

function ctxBar(pct) {
  const cls = pct >= 80 ? "hot" : pct >= 50 ? "warn" : "";
  return `<span class="ctxbar"><span class="track"><span class="fill ${cls}" style="width:${Math.min(100, pct)}%"></span></span><b class="mono">${(pct || 0).toFixed(0)}%</b></span>`;
}

const runsOf = (e) => Array.isArray(e.subagents) ? e.subagents : [];
function allRuns(e) {
  return runsOf(e).flatMap((run) => [run, ...allRuns(run)]);
}
function sumRuns(e, group, key) {
  if (!Array.isArray(e.subagents)) return e.counts?.subagentCalls > 0 ? null : 0;
  const runs = allRuns(e);
  return runs.some((r) => r[group]?.[key] == null) ? null : runs.reduce((n, r) => n + r[group][key], 0);
}
const valueHtml = (value, fmt = String) => esc(value == null ? "—" : fmt(value));
const sessionKey = (e, sid = e.sessionId) => JSON.stringify([PROV(e), sid == null ? "" : String(sid)]);
function sessionHead(items) {
  const head = { ...items[0] };
  for (const key of ["sessionName", "sessionTitle", "slug", "branchOf", "parentSessionId", "agent"]) {
    head[key] = items.find((e) => e[key])?.[key];
  }
  return head;
}
function sessionLabel(e) {
  const label = e.sessionName || e.sessionTitle || e.slug || String(e.sessionId || "").slice(0, 8);
  return !e.sessionName && e.sessionTitle
    ? `<em class="generated-title" title="generated title">${esc(label)}</em>` : esc(label);
}
function loadedSessionLabel(e, sid) {
  const items = state.all.filter((row) => sessionKey(row) === sessionKey(e, sid));
  return items.length ? sessionLabel(sessionHead(items)) : esc(String(sid || "").slice(0, 8));
}
const turnTreeKey = (e) => "turn:" + keyOf(e);
// state.expanded holds the keys toggled away from their default: a session group
// starts open, so its turns show as before; runs and nested sessions start closed.
const isExpanded = (key) => state.expanded.includes(key) !== key.startsWith("session:");
function expander(key, label) {
  const open = isExpanded(key);
  return `<button type="button" class="tree-toggle" data-tree="${esc(key)}" aria-expanded="${esc(open)}" aria-label="${esc(label)}"><span aria-hidden="true">${open ? "▾" : "▸"}</span></button>`;
}
function runBadges(run) {
  return `<span class="tag">${valueHtml(run.status)}</span>${run.background ? ' <span class="tag">background</span>' : ""}`;
}
function rowHtml(e, depth = 0, children = false) {
  const chip = has("skills") && e.skills && e.skills.length
    ? `<span class="skill-chip" title="skills: ${esc(e.skills.join(", "))}">▸ ${e.skills.length}</span> ` : "";
  const auto = e.synthetic
    ? `<span class="skill-chip" title="Auto-continued after a context compaction — not a prompt anyone typed">⟳</span> `
    : "";
  const prov = e.provider || "claude";
  const runs = has("subagents") ? allRuns(e) : [];
  const toggle = runs.length || children ? expander(turnTreeKey(e), "Agents for turn " + e.id) : '<span class="tree-spacer"></span>';
  const agents = runs.length ? `<span class="tag">${esc(fmtInt(runs.length))} agents</span> ` : "";
  return `<tr class="row" data-id="${esc(e.id)}" data-provider="${esc(prov)}" data-session="${esc(e.sessionId == null ? "" : e.sessionId)}" style="--tree-depth:${esc(depth)}">
    <td class="mono muted col-when"><div class="tree-cell">${toggle}${fmtWhen(e.ts)}</div></td>
    <td class="col-provider"><span class="tag prov-${esc(prov)}">${esc(prov)}</span></td>
    <td class="ws col-workspace">${esc(e.workspace)}</td>
    <td class="mono col-model">${esc(shortModel(e.model))}</td>
    <td class="col-mode"><span class="tag ${esc(e.permissionMode)}">${esc(e.permissionMode)}</span></td>
    <td class="num col-in">${valueHtml(e.usage?.input, fmtTok)}</td>
    <td class="num col-out">${valueHtml(e.usage?.output, fmtTok)}</td>
    <td class="num col-context">${contextObserved(e) ? ctxBar(e.contextFillPct) : '<span class="muted" title="Context window unknown">—</span>'}</td>
    <td class="num cost-cell col-cost">${COST_ESTIMATED(e) ? `<span class="est-mark" title="${esc(estReason(e))}">≈</span>` : ""}${valueHtml(e.cost?.total, fmtUsd)}</td>
    <td class="prompt-cell col-prompt">${!state.group && e.parentSessionId ? '<span class="tag">↳ agent</span> ' : ""}${agents}${auto}${chip}${esc(e.promptPreview)}</td>
  </tr>`;
}

function runRows(e, runs, depth, path = []) {
  return runs.map((run, i) => {
    const runPath = [...path, i];
    const key = "run:" + keyOf(e) + ":" + runPath.join(".");
    const children = runsOf(run);
    const toggle = children.length ? expander(key, "Runs launched by " + (run.agentType || "agent")) : '<span class="tree-spacer"></span>';
    return `<tr class="run-row" data-id="${esc(e.id)}" data-provider="${esc(PROV(e))}" data-session="${esc(e.sessionId)}" style="--tree-depth:${esc(depth)}">
      <td class="mono muted col-when"><div class="tree-cell">${toggle}<span title="Run duration">${valueHtml(run.durationMs, fmtDur)}</span></div></td>
      <td class="col-provider"><button type="button" class="run-open" title="Open parent turn">${valueHtml(run.agentType)}</button></td>
      <td class="col-workspace muted">${runBadges(run)}</td>
      <td class="mono col-model">${valueHtml(run.model, shortModel)}</td>
      <td class="col-mode muted">—</td>
      <td class="num col-in">${valueHtml(run.usage?.input, fmtTok)}</td>
      <td class="num col-out">${valueHtml(run.usage?.output, fmtTok)}</td>
      <td class="num col-context" title="This run's own context window, not the main thread's">${has("context") && contextObserved(run) ? ctxBar(run.contextFillPct) : '<span class="muted">—</span>'}</td>
      <td class="num cost-cell col-cost">${valueHtml(run.cost?.total, fmtUsd)}</td>
      <td class="prompt-cell col-prompt" title="${esc(run.description)}">${valueHtml(run.description)}</td>
    </tr>${children.length && isExpanded(key) ? runRows(e, children, depth + 1, runPath) : ""}`;
  }).join("");
}
function turnRows(e, depth = 0, children = [], renderGroup) {
  return rowHtml(e, depth, children.length > 0) + (isExpanded(turnTreeKey(e))
    ? (has("subagents") ? runRows(e, runsOf(e), depth + 1) : "") + children.map((g) => renderGroup(g, depth + 1)).join("") : "");
}

function renderTable() {
  const rows = sorted();
  $("#empty").hidden = rows.length > 0;
  const body = $("#rows");
  if (!state.group) { body.innerHTML = rows.map((e) => turnRows(e)).join(""); markSort(); return; }

  // group by session, keep current sort order of first appearance
  const groups = new Map();
  for (const e of rows) {
    const key = sessionKey(e);
    if (!groups.has(key)) groups.set(key, { key, items: [], children: [], parent: null });
    groups.get(key).items.push(e);
  }
  for (const g of groups.values()) g.head = sessionHead(g.items);
  for (const g of groups.values()) {
    const e = g.head;
    const sid = (PROV(e) === "codex" || PROV(e) === "opencode") ? e.parentSessionId : PROV(e) === "claude" ? e.branchOf : null;
    const parent = sid && groups.get(sessionKey(e, sid));
    if (!parent) continue;
    // A malformed relationship must not hide an entire cycle of sessions.
    let ancestor = parent;
    while (ancestor && ancestor !== g) ancestor = ancestor.parent;
    if (ancestor) continue;
    g.parent = parent;
    g.childAgent = PROV(e) === "codex" || PROV(e) === "opencode";
    g.turn = g.childAgent ? parent.items.find((row) => row.spawnedAgents?.includes(e.sessionId)) : null;
    parent.children.push(g);
  }
  const agentItems = (g) => g.children.filter((child) => child.childAgent).flatMap((child) => [...child.items, ...agentItems(child)]);
  // How long the session's own turns took, summed like the active-time card: the figure a feature is estimated from.
  const sessionTime = (items) => { if (!has("timing")) return ""; const ms = items.reduce((n, e) => n + (Number(e.durationMs) || 0), 0); return ms > 0 ? `<span title="Summed turn duration">${esc(fmtDur(ms))}</span> · ` : ""; };
  const costTotal = (items) => items.some((e) => e.cost?.total == null) ? null : items.reduce((n, e) => n + e.cost.total, 0);
  const renderGroup = (g, depth = 0) => {
    const e = g.head, key = "session:" + g.key;
    const child = (PROV(e) === "codex" || PROV(e) === "opencode") && e.parentSessionId;
    const label = child ? `${esc(e.agent?.kind || "spawned")} · ${e.agent?.nickname ? esc(e.agent.nickname) : sessionLabel(e)}`
      : `${g.parent ? "branch · " : ""}${sessionLabel(e)}`;
    const orphan = !g.parent && (child || e.branchOf);
    const related = agentItems(g);
    let html = `<tr class="group" style="--tree-depth:${esc(depth)}"><td colspan="10"><div class="tree-cell">
      ${expander(key, "Session " + (e.sessionName || e.sessionTitle || e.slug || e.sessionId))}
      <b>${esc(e.workspace)}</b> · <span class="session-label">${label}</span>
      ${orphan ? `<span class="tag">${child ? "agent of" : "branched from"} ${esc(String(child || e.branchOf).slice(0, 8))}</span>` : ""}
      <span class="gstats">${esc(fmtInt(g.items.length))} turns · ${sessionTime(g.items)}${has("cost") ? `${valueHtml(costTotal(g.items), fmtUsd)} · ` : ""}session ${esc(String(e.sessionId || "").slice(0, 8))}</span>
      ${has("cost") && related.length ? `<span class="tag">+ agents ${valueHtml(costTotal(related), fmtUsd)}</span>` : ""}
    </div></td></tr>`;
    if (isExpanded(key)) {
      html += g.items.map((row) => turnRows(row, depth + 1, g.children.filter((child) => child.turn === row), renderGroup)).join("");
      html += g.children.filter((child) => !child.turn).map((child) => renderGroup(child, depth + 1)).join("");
    }
    return html;
  };
  body.innerHTML = [...groups.values()].filter((g) => !g.parent).map((g) => renderGroup(g)).join("");
  markSort();
}

function markSort() {
  document.querySelectorAll(".grid th.sortable").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort.key);
    th.classList.toggle("asc", th.dataset.sort === state.sort.key && state.sort.dir === 1);
  });
}

// ---------- markdown preview (zero-dep, XSS-safe: escape first, then format) ----------
// Inline operates on already-escaped text, so injected tags are ours only.
function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}
const splitRow = (s) => s.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

function renderMd(src) {
  if (!src || !src.trim()) return `<p class="md-empty muted">— empty —</p>`;
  const L = esc(src).replace(/\r\n?/g, "\n").split("\n");
  let html = "", i = 0;
  const isBlockStart = (s) => /^\s*(#{1,6}\s|```|>|([-*+]|\d+\.)\s)/.test(s);
  while (i < L.length) {
    const line = L[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim(); const code = []; i++;
      while (i < L.length && !/^\s*```\s*$/.test(L[i])) { code.push(L[i]); i++; }
      i++;
      html += `<pre class="md-code"${lang ? ` data-lang="${lang}"` : ""}><code>${code.join("\n")}</code></pre>`;
      continue;
    }
    // GFM table: row with pipes followed by a |---|:--| separator
    if (line.includes("|") && i + 1 < L.length && L[i + 1].includes("-") && /^[\s|:-]+$/.test(L[i + 1]) && L[i + 1].includes("|")) {
      const head = splitRow(line);
      const al = splitRow(L[i + 1]).map((c) => { c = c.trim(); const l = c.startsWith(":"), r = c.endsWith(":"); return l && r ? "center" : r ? "right" : l ? "left" : ""; });
      i += 2; const rows = [];
      while (i < L.length && L[i].includes("|") && L[i].trim() !== "") { rows.push(splitRow(L[i])); i++; }
      const cell = (c, j, tag) => `<${tag}${al[j] ? ` style="text-align:${al[j]}"` : ""}>${mdInline((c || "").trim())}</${tag}>`;
      html += `<table class="md-table"><thead><tr>${head.map((c, j) => cell(c, j, "th")).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => cell(r[j], j, "td")).join("")}</tr>`).join("")}</tbody></table>`;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lv = h[1].length; html += `<h${lv} class="md-h">${mdInline(h[2].trim())}</h${lv}>`; i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { html += `<hr class="md-hr"/>`; i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = []; while (i < L.length && /^\s*>\s?/.test(L[i])) { buf.push(L[i].replace(/^\s*>\s?/, "")); i++; }
      html += `<blockquote class="md-quote">${mdInline(buf.join(" ").trim())}</blockquote>`; continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line); const items = [];
      while (i < L.length && /^\s*([-*+]|\d+\.)\s+/.test(L[i])) { items.push(L[i].replace(/^\s*([-*+]|\d+\.)\s+/, "")); i++; }
      const tag = ordered ? "ol" : "ul";
      html += `<${tag} class="md-list">${items.map((it) => `<li>${mdInline(it.trim())}</li>`).join("")}</${tag}>`;
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [];
    while (i < L.length && L[i].trim() !== "" && !isBlockStart(L[i]) && !L[i].includes("|")) { para.push(L[i]); i++; }
    if (para.length) html += `<p class="md-p">${mdInline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`;
    else { html += `<p class="md-p">${mdInline(line)}</p>`; i++; }
  }
  return html;
}

// rendered + raw view with a toggle
function detailBlock(kind, label, chars, text) {
  return `<div class="block ${kind}">
    <div class="bh"><span>${label}</span><span class="bh-r"><button class="md-toggle" data-raw type="button">raw</button>${fmtInt(chars)} chars</span></div>
    <div class="md">${renderMd(text)}</div>
    <pre class="raw" hidden>${esc(text) || '<span class="muted">— empty —</span>'}</pre>
  </div>`;
}

// ---------- drawer ----------
function runMetrics(e, main = false) {
  const metrics = [
    ["input", e.usage?.input, fmtInt], ["output", e.usage?.output, fmtInt],
    ["cache write", e.usage?.cacheCreate, fmtInt], ["cache read", e.usage?.cacheRead, fmtInt],
    ["cost", e.cost?.total, fmtUsd],
  ];
  // Each thread's own window: a run's context is not the main thread's, and the
  // main thread's is the turn's own figure, never a sum over its runs.
  if (has("context") && contextObserved(e)) {
    metrics.push(["context", e, (t) => `${(t.contextFillPct || 0).toFixed(0)}% · ${fmtTok(t.contextTokens)} of ${fmtTok(t.contextMax)}`]);
  }
  if (!main) metrics.push(["duration", e.durationMs, fmtDur], ["api calls", e.counts?.apiCalls, fmtInt], ["tool calls", e.counts?.toolCalls, fmtInt]);
  return `<dl class="run-metrics">${metrics.map(([label, value, fmt]) => `<div><dt>${esc(label)}</dt><dd>${valueHtml(value, fmt)}</dd></div>`).join("")}</dl>`;
}
function subagentSection(e) {
  if (!has("subagents") || !runsOf(e).length) return "";
  const main = { usage: {}, cost: {}, contextTokens: e.contextTokens, contextMax: e.contextMax, contextFillPct: e.contextFillPct };
  for (const [group, keys] of [["usage", ["input", "output", "cacheCreate", "cacheRead"]], ["cost", ["total"]]]) {
    for (const key of keys) {
      const total = e[group]?.[key], agents = sumRuns(e, group, key);
      main[group][key] = total == null || agents == null ? null : Math.max(0, total - agents);
    }
  }
  const cards = (runs) => runs.map((run) => `<article class="run-card">
    <div class="run-heading"><b>${valueHtml(run.agentType)}</b>${runBadges(run)}</div>
    <p>${valueHtml(run.description)}</p><div class="muted mono">${valueHtml(run.model)}</div>
    ${runMetrics(run)}${runsOf(run).length ? `<div class="run-children">${cards(runsOf(run))}</div>` : ""}
  </article>`).join("");
  return `<section class="block"><div class="bh"><span>subagents</span><span>${esc(fmtInt(allRuns(e).length))} runs</span></div>
    <div class="main-thread"><b>main thread</b>${runMetrics(main, true)}</div>${cards(runsOf(e))}</section>`;
}
async function openDrawer(id, provider, session) {
  const drawer = $("#drawer");
  drawer.hidden = false;
  $("#drawer-panel").innerHTML = `<div class="muted mono" style="padding:40px">loading…</div>`;
  let e;
  // The same id can belong to more than one turn, so name the provider and session too.
  const scope = provider == null ? "" : `?provider=${encodeURIComponent(provider)}&session=${encodeURIComponent(session || "")}`;
  try { e = await (await fetch("/api/event/" + encodeURIComponent(id) + scope)).json(); } catch { e = null; }
  if (!e || !e.id) { $("#drawer-panel").innerHTML = `<div class="muted mono" style="padding:40px">not found</div>`; return; }
  const u = e.usage || {}, c = e.cost || {}, k = e.counts || {};
  // meta spans (omit when the `meta`/`timing` group is stripped)
  const meta = [`<span>${fmtWhen(e.ts)}</span>`, `<span>${esc(e.model)}</span>`,
    `<span class="tag ${esc(e.permissionMode)}">${esc(e.permissionMode)}</span>`];
  if (has("meta") && e.vendor) meta.push(`<span>vendor: ${esc(e.vendor)}</span>`);
  if (e.effortLevel) meta.push(`<span>effort: ${esc(e.effortLevel)}</span>`);
  if (e.durationMs != null) meta.push(`<span>${fmtDur(e.durationMs)}</span>`);
  if (e.firstResponseMs != null) meta.push(`<span>1st reply ${fmtDur(e.firstResponseMs)}</span>`);
  if (e.gitBranch) meta.push(`<span>${esc(e.gitBranch)}</span>`);
  if (e.entrypoint) meta.push(`<span title="platform the prompt was sent from">⌂ ${esc(e.entrypoint)}</span>`);
  if (e.cliVersion) meta.push(`<span>v${esc(e.cliVersion)}</span>`);
  if (e.serviceTier || e.speed) meta.push(`<span>${[e.serviceTier, e.speed].filter(Boolean).map(esc).join("/")}</span>`);
  if (e.branchOf) meta.push(`<span>branched from ${loadedSessionLabel(e, e.branchOf)}</span>`);
  if (e.agent) {
    meta.push(`<span>${valueHtml(e.agent.kind)} · ${valueHtml(e.agent.nickname)}</span>`,
      `<span>role ${valueHtml(e.agent.role)}</span>`, `<span>path ${valueHtml(e.agent.path)}</span>`,
      `<span>depth ${valueHtml(e.agent.depth, fmtInt)}</span>`,
      `<span>agent of ${e.parentSessionId ? loadedSessionLabel(e, e.parentSessionId) : "—"}</span>`);
  }
  // dgrid cells, each gated on its field group + presence
  const cells = [];
  if (has("cost") && e.cost) cells.push(`<div><div class="k">cost</div><div class="v accent">${fmtUsd(c.total)}</div></div>`);
  if (has("context") && contextObserved(e)) cells.push(`<div><div class="k">context</div><div class="v">${(e.contextFillPct||0).toFixed(1)}% <span class="muted" style="font-size:11px">${fmtTok(e.contextTokens)}/${fmtTok(e.contextMax)}</span></div></div>`);
  if (has("timing") && e.firstResponseMs != null) cells.push(`<div><div class="k">first response</div><div class="v">${fmtDur(e.firstResponseMs)}</div></div>`);
  if (has("tokens") && e.usage) {
    cells.push(
      `<div><div class="k">input</div><div class="v">${fmtInt(u.input)}</div></div>`,
      `<div><div class="k">output</div><div class="v">${fmtInt(u.output)}</div></div>`,
      `<div><div class="k">cache write</div><div class="v">${fmtInt(u.cacheCreate)}</div></div>`,
      `<div><div class="k">cache read</div><div class="v">${fmtInt(u.cacheRead)}</div></div>`);
    // OpenAI reasoning tokens (subset of output); Claude records have 0 here.
    if (u.reasoning > 0) cells.push(
      `<div><div class="k">reasoning</div><div class="v">${fmtInt(u.reasoning)} <span class="muted" style="font-size:11px">of output</span></div></div>`);
  }
  if (has("counts") && e.counts) cells.push(
    `<div><div class="k">api calls</div><div class="v">${k.apiCalls} <span class="muted" style="font-size:11px">+${k.subagentCalls} sub</span></div></div>`,
    `<div><div class="k">tools / think</div><div class="v">${k.toolCalls} / ${k.thinkingBlocks}</div></div>`);
  // Approximate for either reason: token counts we derived from text length
  // (Cursor), or a model with no listed rate, priced at its family default.
  const estTitle = estReason(e);
  const estFlag = COST_ESTIMATED(e) ? ` <span class="est-flag" title="${esc(estTitle)}">≈ estimated</span>` : "";
  const costSource = c.source || (c.estimated ? "estimated" : "legacy");
  const costBreakdown = has("cost") && e.cost
    ? `<div class="block"><div class="bh"><span>cost breakdown · USD${estFlag}</span></div><pre>input  ${fmtUsd(c.input)}
output ${fmtUsd(c.output)}
cache write ${fmtUsd(c.cacheWrite)}
cache read  ${fmtUsd(c.cacheRead)}
──────────────
total  ${fmtUsd(c.total)}
source ${esc(costSource)}</pre></div>` : "";
  $("#drawer-panel").innerHTML = `
    <div class="dhead"><span class="deyebrow">prompt detail</span><span class="dhead-actions"><button class="btn danger ddel" data-del="${esc(e.id)}" data-provider="${esc(PROV(e))}" data-session="${esc(e.sessionId)}">delete</button><button class="btn ghost dclose" data-close>✕ close</button></span></div>
    <h2>${esc(e.workspace)} <span class="drawer-session">/ ${sessionLabel(sessionHead([e, ...state.all.filter((row) => sessionKey(row) === sessionKey(e))]))}</span></h2>
    <div class="dmeta">${meta.join("")}</div>
    ${has("skills") && e.skills && e.skills.length ? `<div class="dskills"><span class="dskills-k">skills</span>${e.skills.map((s) => `<span class="skill-tag">${esc(s)}</span>`).join("")}</div>` : ""}
    ${cells.length ? `<div class="dgrid">${cells.join("")}</div>` : ""}
    ${subagentSection(e)}
    ${textBlock("prompt", "prompt", e.promptChars, e.prompt)}
    ${textBlock("response", "response", e.responseChars, e.response)}
    ${costBreakdown}`;
}
// Render a prompt/response block, or a stub when the text group is disabled.
function textBlock(kind, label, chars, text) {
  if (text != null) return detailBlock(kind, label, chars, text);
  return `<div class="block ${kind}"><div class="bh"><span>${label}</span><span>${fmtInt(chars)} chars</span></div>
    <div class="md md-empty muted">— text not stored (the “text” field group is off for this project) —</div></div>`;
}
function closeDrawer() { $("#drawer").hidden = true; flushPendingLive(); }

// ---------- settings panel (this project only) ----------
const FIELD_META = [
  ["text", "prompt & response text", "the full prompt/response (largest + most sensitive)"],
  ["tokens", "token usage", "input / output / cache token counts"],
  ["cost", "cost", "provider-reported or locally priced per-prompt USD cost"],
  ["context", "context fill", "context window occupancy %"],
  ["timing", "timing", "duration + first-response latency"],
  ["skills", "skills", "skills invoked per prompt"],
  ["counts", "tool counts", "api / subagent / tool / thinking counts"],
  ["subagents", "subagent runs", "each run's type, description, tokens, cost and time"],
  ["meta", "metadata", "vendor, session names, git branch, cli version, slug, tier, effort"],
];
function renderSettings() {
  const panel = $("#settings-panel");
  const title = (document.getElementById("proj") || {}).textContent || "this project";
  const fieldRows = FIELD_META.map(([g, name, desc]) => `<div class="set-row">
      <label class="set-toggle"><input type="checkbox" data-field="${g}" ${has(g) ? "checked" : ""} />
        <span class="set-name">${esc(name)}<small>${esc(desc)}</small></span></label>
    </div>`).join("");
  panel.innerHTML = `
    <div class="dhead"><span class="deyebrow">settings</span><button class="btn ghost" data-settings-close>✕ close</button></div>
    <h2 style="font-family:var(--display);font-weight:500;font-size:20px;margin:0 0 16px">${esc(title)}</h2>
    <section class="set-sec">
      <h3 class="set-h">tracking</h3>
      <div class="set-row">
        <label class="set-toggle"><input type="checkbox" data-enabled ${state.enabled ? "checked" : ""} />
          <span class="set-name">record this project<small>uncheck to stop recording new prompts here</small></span></label>
      </div>
    </section>
    <section class="set-sec">
      <h3 class="set-h">monthly budget</h3>
      <p class="set-note">Optional USD cap. The “this month” card turns amber at 80% and red at 100%. Leave empty to disable.</p>
      <div class="set-row">
        <label class="set-toggle" style="cursor:auto">
          <span class="set-name" style="margin-left:0">budget (USD)<small>this project’s dashboard only</small></span>
          <input type="number" min="0" step="1" data-budget placeholder="off" value="${state.budgetMonthly != null ? state.budgetMonthly : ""}"
            style="width:90px;margin-left:auto;font-family:var(--mono)" />
        </label>
      </div>
    </section>
    <section class="set-sec">
      <h3 class="set-h">stored fields</h3>
      <p class="set-note">Disabled groups are stripped before writing (smaller files, more privacy). Already-stored data is not changed; changes apply from the next prompt.</p>
      ${fieldRows}
    </section>
    <p class="set-foot mono">.ai-usage/config.json</p>`;
}
function openSettings() {
  $("#settings-drawer").hidden = false;
  renderSettings();
  loadConfig().then(renderSettings); // refresh from disk
}
function closeSettings() { $("#settings-drawer").hidden = true; flushPendingLive(); }

// ---------- theme (light / dark, persisted; default = system) ----------
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("aiui-theme", t); localStorage.setItem("cu-theme", t); } catch {}
  const b = $("#theme"); if (b) b.textContent = t === "light" ? "☾" : "☀";
  if (state.all.length) renderCharts(); // SVGs bake colors → repaint
}
function initTheme() {
  let t; try { t = localStorage.getItem("aiui-theme") || localStorage.getItem("cu-theme"); } catch {}
  setTheme(t || document.documentElement.getAttribute("data-theme") || "dark");
}

// ---------- events ----------
function bind() {
  $("#f-search").addEventListener("input", (e) => { state.filters.search = e.target.value; onSearchInput(); });
  const map = { "#f-provider": "provider", "#f-platform": "platform", "#f-workspace": "workspace", "#f-model": "model", "#f-vendor": "vendor", "#f-mode": "mode", "#f-effort": "effort", "#f-since": "since", "#f-until": "until" };
  for (const [sel, key] of Object.entries(map)) $(sel).addEventListener("change", (e) => { state.filters[key] = e.target.value; apply(); });
  $("#f-ctx").addEventListener("input", (e) => { state.filters.ctx = +e.target.value; $("#f-ctx-v").textContent = e.target.value; apply(); });
  $("#f-group").addEventListener("change", (e) => { state.group = e.target.checked; renderTable(); persist(); });
  $("#f-clear").addEventListener("click", () => {
    state.filters = { search: "", provider: "", platform: "", workspace: "", model: "", vendor: "", mode: "", effort: "", since: "", until: "", ctx: 0 };
    state.zoom = null;
    document.querySelectorAll(".ctl select").forEach((s) => (s.value = ""));
    $("#f-search").value = ""; $("#f-since").value = ""; $("#f-until").value = ""; $("#f-ctx").value = 0; $("#f-ctx-v").textContent = "0";
    apply();
  });
  $("#f-csv").addEventListener("click", () => exportRecords("csv"));
  $("#f-json").addEventListener("click", () => exportRecords("json"));
  $("#f-del").addEventListener("click", () => delEvents(state.view.map(eventKey), "prompt(s) shown"));
  $("#refresh").addEventListener("click", load);
  $("#theme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    setTheme(cur === "light" ? "dark" : "light");
  });
  $("#settings").addEventListener("click", openSettings);
  $("#settings-drawer").addEventListener("click", (e) => {
    if (e.target.dataset.settingsClose !== undefined) closeSettings();
  });
  $("#settings-drawer").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.enabled !== undefined) {
      saveConfigPatch({ tracking: { enabled: t.checked } });
    } else if (t.dataset.field !== undefined) {
      saveConfigPatch({ fields: { [t.dataset.field]: t.checked } });
    } else if (t.dataset.budget !== undefined) {
      const n = parseFloat(t.value);
      const budgetMonthly = Number.isFinite(n) && n > 0 ? n : null;
      state.budgetMonthly = budgetMonthly;
      fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ui: { budgetMonthly } }) }).catch(() => {});
      renderStats();
      toast("budget saved");
    }
  });
  document.querySelectorAll(".grid th.sortable").forEach((th) =>
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      state.sort = state.sort.key === k ? { key: k, dir: -state.sort.dir } : { key: k, dir: k === "ts" ? -1 : -1 };
      renderTable();
      persist();
    })
  );
  $("#rows").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-tree]");
    if (toggle) {
      const key = toggle.dataset.tree;
      state.expanded = state.expanded.includes(key) ? state.expanded.filter((k) => k !== key) : [...state.expanded, key];
      renderTable();
      persist();
      [...document.querySelectorAll("#rows [data-tree]")].find((button) => button.dataset.tree === key)?.focus();
      return;
    }
    const tr = e.target.closest("tr.row, tr.run-row"); if (tr) openDrawer(tr.dataset.id, tr.dataset.provider, tr.dataset.session);
  });
  $("#drawer").addEventListener("click", async (e) => {
    if (e.target.dataset.close !== undefined) return closeDrawer();
    if (e.target.dataset.del !== undefined) {
      const key = {
        provider: e.target.dataset.provider || "claude",
        sessionId: e.target.dataset.session || "",
        id: e.target.dataset.del,
      };
      closeDrawer();
      await delEvents([key], "this prompt");
      return;
    }
    if (e.target.dataset.raw !== undefined) {
      const block = e.target.closest(".block"); if (!block) return;
      const raw = block.classList.toggle("show-raw");
      e.target.textContent = raw ? "rendered" : "raw";
      block.querySelector(".md").hidden = raw;
      block.querySelector(".raw").hidden = !raw;
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeSettings(); } });
}

// ---------- live updates ----------
// The recorder writes in the background, so subscribe to the server's change
// feed instead of making the user hit refresh. Reloading is deferred while a
// drawer is open so the view never changes under the reader; the pending
// refresh is applied as soon as it closes.
let livePending = false;
function liveRefresh() {
  const busy = !$("#drawer").hidden || !$("#settings-drawer").hidden;
  if (busy) { livePending = true; return; }
  livePending = false;
  load().catch(() => {});
}
// Called whenever a drawer closes — however it was closed — so a refresh that
// arrived while it was open is applied instead of waiting for the next change.
function flushPendingLive() {
  if (livePending) setTimeout(liveRefresh, 0);
}
function initLive() {
  if (typeof EventSource !== "function") return;
  try {
    const es = new EventSource("/api/stream");
    es.addEventListener("change", liveRefresh);
  } catch {}
}

bind();
initTheme();
boot();
initLive();
