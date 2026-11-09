"use strict";
// POA private website (PS-046 revision 5; Build Package M3-PK003, task R5).
// Vince signs in with his own POA account; every number comes from the POA connector's read actions,
// the same report functions the coach uses, so the website and the conversation never disagree (REQ-RPT-001).
// Each report has a Graph / Text switch over the same numbers (REQ-RPT-007). Nothing is stored here
// except the sign-in session and view preferences in this browser.

const SUPABASE_URL = "https://djkomeqozlulwepehoej.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_AsKogB7gcYgWDzNFwekgUw_FJXobyp0"; // public by design; opens nothing in POA
const CONNECTOR = SUPABASE_URL + "/functions/v1/poa-connector";
const client = supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "poa-app-auth" },
});
const $ = (id) => document.getElementById(id);
const fmt = Charts.fmt;

// ------------------------------------------------------------------ preferences (this browser only)

function pref(key, fallback) {
  try { const v = localStorage.getItem("poa-app-" + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem("poa-app-" + key, JSON.stringify(value)); } catch { /* private window: keep defaults */ }
}

// ------------------------------------------------------------------ dates

const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const short = (s) => { const d = parse(s); return MON[d.getMonth()] + " " + d.getDate(); };
const long = (s) => { const d = parse(s); return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate(); };
const monthName = (s) => { const d = parse(s); return MON[d.getMonth()] + " " + d.getFullYear(); };

const PERIODS = [["4w", "Last 4 weeks", 28], ["8w", "Last 8 weeks", 56], ["12w", "Last 12 weeks", 84],
  ["6m", "Last 6 months", 182], ["1y", "Last year", 365], ["custom", "Custom dates", 0]];

function period() {
  const p = pref("period", "4w");
  if (p === "custom") return { from: pref("from", addDays(today(), -27)), to: pref("to", today()) };
  const days = (PERIODS.find((x) => x[0] === p) || PERIODS[0])[2];
  return { from: addDays(today(), -(days - 1)), to: today() };
}

// ------------------------------------------------------------------ calling POA

let rpcId = 0;
async function call(name, args) {
  const { data } = await client.auth.getSession();
  const token = data && data.session && data.session.access_token;
  if (!token) { showSignIn(); throw new Error("Please sign in."); }
  const res = await fetch(CONNECTOR, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args || {} } }),
  });
  if (res.status === 401) {
    await client.auth.signOut();
    showSignIn("Your sign-in ended. Please sign in again.");
    throw new Error("Please sign in again.");
  }
  if (res.status === 403) throw new Error("This account isn't allowed to use POA.");
  if (!res.ok) throw new Error("POA didn't answer (" + res.status + "). Try again in a moment.");
  const msg = await res.json();
  if (msg.error) throw new Error(msg.error.message);
  const text = (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) || "";
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(text || "POA gave an unexpected answer."); }
  if (out && out.status === "error") throw new Error(out.message || "POA couldn't make that report.");
  return out;
}

const cache = {};
async function exercises() {
  if (!cache.exercises) {
    const r = await call("exercises", {});
    cache.exercises = (r.exercises || []).slice().sort((a, b) => (b.last_done || "").localeCompare(a.last_done || ""));
  }
  return cache.exercises;
}
async function micronutrients() {
  if (!cache.micros) {
    const r = await call("period", { from: addDays(today(), -6), to: today() });
    cache.micros = ((r.micronutrients && r.micronutrients.total) || []).map((m) => m.nutrient);
  }
  return cache.micros;
}

// ------------------------------------------------------------------ page parts

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
  return node;
}

function seg(options, value, onChange, label) {
  const box = h("div", { class: "seg", role: "group", "aria-label": label });
  for (const [v, text] of options) {
    box.append(h("button", { type: "button", "aria-pressed": String(v === value),
      onclick: () => { if (v !== value) onChange(v); } }, text));
  }
  return box;
}

function field(label, control) { return h("label", { class: "field" }, h("span", {}, label), control); }

function periodControls(rerender) {
  const p = pref("period", "4w");
  const sel = h("select", { onchange: (e) => { setPref("period", e.target.value); rerender(); } },
    PERIODS.map(([v, t]) => h("option", { value: v, selected: v === p }, t)));
  const out = [field("Period", sel)];
  if (p === "custom") {
    const { from, to } = period();
    out.push(field("From", h("input", { type: "date", value: from, max: today(), onchange: (e) => { if (e.target.value) { setPref("from", e.target.value); rerender(); } } })));
    out.push(field("To", h("input", { type: "date", value: to, max: today(), onchange: (e) => { if (e.target.value) { setPref("to", e.target.value); rerender(); } } })));
  }
  return out;
}

function viewSwitch(rerender) {
  return field("Show", seg([["graph", "Graph"], ["text", "Text"]], pref("view", "graph"), (v) => { setPref("view", v); rerender(); }, "Graph or text"));
}

function exerciseSelect(list, key, rerender) {
  const current = pref(key, list[0] && list[0].exercise_id);
  return field("Exercise", h("select", { onchange: (e) => { setPref(key, e.target.value); rerender(); } },
    list.map((x) => h("option", { value: x.exercise_id, selected: x.exercise_id === current }, x.name))));
}

function table(headers, rows, opts = {}) {
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, headers.map((t, i) => h("th", { class: opts.num && opts.num.includes(i) ? "num" : null }, t)))),
    h("tbody", {}, rows.map((r) => h("tr", { class: r.cls || null }, r.cells.map((c, i) => h("td", { class: opts.num && opts.num.includes(i) ? "num" : null }, c)))))));
}

function chartBox(title, sub) {
  const plot = h("div", {});
  return { node: h("div", { class: "chart" }, h("h3", {}, title), sub ? h("p", { class: "sub" }, sub) : null, plot), plot };
}

// Report notes are written for the coach ("Vince didn't log"); on his own site they speak to him
const you = (t) => t.replace(/\bVince's\b/g, "your").replace(/\bVince\b/g, "you").replace(/\bhis\b/g, "your").replace(/\bhe\b/g, "you");
function notes(...lines) { return h("div", { class: "notes" }, lines.filter(Boolean).map((t) => h("p", {}, you(t)))); }

function key(parts) {
  const items = [];
  if (parts.includes("est")) items.push(h("span", {}, h("i", { class: "k-est" }), "estimate or approximate amount"));
  if (parts.includes("miss")) items.push(h("span", {}, h("i", { class: "k-miss" }, "*"), "missing: nothing logged, or not fully logged"));
  if (parts.includes("atleast")) items.push(h("span", {}, "≥ at least: some foods are pending or have no value"));
  return h("div", { class: "key" }, items);
}

// Draw now and again when the screen width changes
let redraw = null;
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => redraw && redraw(), 150); });
function draw(fn) { redraw = fn; fn(); }

function say(text, bad) { $("message").textContent = text || ""; $("message").className = bad ? "error" : "muted"; }

// ------------------------------------------------------------------ pages

const NUTRIENT_CHOICES = [["calories", "Calories"], ["protein", "Protein"], ["carbohydrates", "Carbs"], ["fat", "Fat"]];

async function nutritionPage(body, rerender) {
  const grain = pref("grain", "day");
  const chosen = pref("nutrients", ["calories", "protein"]);
  const micros = await micronutrients();
  const toggle = (n) => { const next = chosen.includes(n) ? chosen.filter((x) => x !== n) : [...chosen, n]; setPref("nutrients", next.length ? next : ["calories"]); rerender(); };
  const chips = h("div", { class: "chips" },
    NUTRIENT_CHOICES.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(chosen.includes(v)), onclick: () => toggle(v) }, t)),
    chosen.filter((n) => !NUTRIENT_CHOICES.some(([v]) => v === n)).map((n) => h("button", { type: "button", "aria-pressed": "true", onclick: () => toggle(n), title: "Remove" }, n + " ×")));
  const add = h("select", { onchange: (e) => { if (e.target.value) toggle(e.target.value); } },
    h("option", { value: "" }, "Add a micronutrient"), micros.filter((m) => !chosen.includes(m)).map((m) => h("option", { value: m }, m)));
  body.append(h("div", { class: "controls" }, ...periodControls(rerender),
    field("By", seg([["day", "Day"], ["week", "Week"], ["month", "Month"]], grain, (v) => { setPref("grain", v); rerender(); }, "Day, week or month")),
    viewSwitch(rerender)));
  body.append(h("div", { class: "controls" }, chips, add));

  const { from, to } = period();
  const r = await call("nutrition_report", { from, to, grain, nutrients: chosen });
  const nutrients = r.nutrients || [];
  const series = r.series || [];
  const sum = r.summary || {};
  const unitOf = (n) => (n.unit === "kcal" ? "" : " " + n.unit);
  const label = (s) => grain === "day" ? long(s.date) : grain === "week" ? "Week of " + short(s.period) : monthName(s.period);
  const shortLabel = (s) => grain === "day" ? short(s.date) : grain === "week" ? short(s.period) : MON[parse(s.period).getMonth()];
  const isMissing = (s) => grain === "day" ? s.status !== "logged" : !s.full_days;
  const isEstimate = (s) => grain === "day" ? (s.flags && (s.flags.estimated > 0 || s.flags.approximate > 0)) : (s.estimated_entries > 0 || s.approximate_entries > 0);
  const missingWhy = (s) => s.status === "not_fully_logged" ? "not fully logged" : "nothing logged";
  const cell = (s, n) => {
    const v = s.values && s.values[n.key];
    if (isMissing(s) || v === null || v === undefined) {
      if (grain !== "day") return "*";
      const part = s.partial_values && s.partial_values[n.key];
      return "*" + (part !== null && part !== undefined ? " (" + fmt(part) + " so far)" : "");
    }
    return (s.at_least && s.at_least[n.key] ? "≥ " : "") + fmt(v) + (isEstimate(s) ? " est." : "");
  };

  if (pref("view", "graph") === "graph") {
    const boxes = nutrients.map((n) => {
      const avg = sum.average_per_full_day && sum.average_per_full_day[n.key];
      const box = chartBox(n.name.charAt(0).toUpperCase() + n.name.slice(1) + (n.unit ? " (" + n.unit + ")" : ""),
        (grain === "day" ? "Each day" : grain === "week" ? "Average per full day, each week (Monday to Sunday)" : "Average per full day, each month") +
        (avg !== null && avg !== undefined ? " · period average per full day " + (sum.at_least && sum.at_least[n.key] ? "≥ " : "") + fmt(avg) + unitOf(n) : ""));
      body.append(box.node);
      return { n, box, avg };
    });
    body.append(key(["est", "miss", "atleast"]));
    draw(() => boxes.forEach(({ n, box, avg }) => Charts.columns(box.plot, {
      aria: n.name + " " + (grain === "day" ? "by day" : "average per full day by " + grain),
      avg: avg !== null && avg !== undefined ? { value: avg, label: "avg " + fmt(avg) } : null,
      points: series.map((s) => {
        const v = s.values ? s.values[n.key] : null;
        const missing = isMissing(s) || v === null || v === undefined;
        let tip = label(s) + "\n";
        if (missing) tip += grain === "day" ? "Missing: " + missingWhy(s) : "No full days";
        else tip += (s.at_least && s.at_least[n.key] ? "at least " : "") + fmt(v) + unitOf(n) + (isEstimate(s) ? " (includes estimates)" : "");
        if (grain !== "day" && s.full_days !== undefined) tip += "\nBased on " + s.full_days + " of " + s.days + " days";
        if (s.note) tip += "\n" + s.note;
        return { label: label(s), short: shortLabel(s), value: missing ? null : v, missing, estimate: isEstimate(s), tip };
      }),
    })));
  } else {
    redraw = null;
    const rows = series.map((s) => ({ cls: isMissing(s) ? "missing" : null, cells: [label(s) + (grain === "day" && isMissing(s) ? ": " + missingWhy(s) : "") + (grain !== "day" && s.full_days !== undefined ? " (" + s.full_days + " of " + s.days + " days)" : ""), ...nutrients.map((n) => cell(s, n))] }));
    if (sum.average_per_full_day) rows.push({ cls: null, cells: ["Average per full day", ...nutrients.map((n) => (sum.at_least && sum.at_least[n.key] ? "≥ " : "") + fmt(sum.average_per_full_day[n.key]))] });
    body.append(table([grain === "day" ? "Day" : grain === "week" ? "Week" : "Month", ...nutrients.map((n) => n.name + (n.unit ? " (" + n.unit + ")" : ""))],
      rows, { num: nutrients.map((_, i) => i + 1) }));
    body.append(key(["est", "miss", "atleast"]));
  }
  body.append(notes(sum.note, r.target_note));
}

async function sourcesPage(body, rerender) {
  const micros = await micronutrients();
  const nutrient = pref("sourceNutrient", "protein");
  const options = [...NUTRIENT_CHOICES, ...micros.map((m) => [m, m])];
  body.append(h("div", { class: "controls" }, ...periodControls(rerender),
    field("Nutrient", h("select", { onchange: (e) => { setPref("sourceNutrient", e.target.value); rerender(); } },
      options.map(([v, t]) => h("option", { value: v, selected: v === nutrient }, t)))),
    viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("nutrient_sources", { nutrient, from, to, top: 10 });
  const foods = r.top_foods || [];
  const unit = r.unit === "kcal" ? " kcal" : " " + r.unit;
  if (!foods.length) { body.append(notes("Nothing logged in this period has a value for " + r.nutrient + ".")); return; }
  if (pref("view", "graph") === "graph") {
    const box = chartBox("Where your " + r.nutrient + " came from", "Share of the period's total of " + fmt(r.total) + unit + ", top " + foods.length + " foods");
    body.append(box.node);
    draw(() => Charts.hbars(box.plot, {
      aria: "Top foods for " + r.nutrient,
      items: foods.map((f) => ({ label: f.food, value: f.share_pct, estimate: f.estimate, valueLabel: f.share_pct + "%",
        tip: f.food + "\n" + fmt(f.amount) + unit + " (" + f.share_pct + "% of the total)\n" + f.entries + " entries" + (f.estimate ? "\nIncludes estimates" : "") })),
    }));
  } else {
    redraw = null;
    body.append(table(["Food", "Amount", "Share", "Entries"],
      foods.map((f) => ({ cells: [f.food + (f.estimate ? " (est.)" : ""), fmt(f.amount) + unit, f.share_pct + "%", String(f.entries)] })), { num: [1, 2, 3] }));
  }
  body.append(notes(r.foods_without_value ? r.foods_without_value + " food entries in this period have no value for " + r.nutrient + ", so the total is at least " + fmt(r.total) + unit + "." : null));
}

const LOAD_NOTE = { bar_total: "Weight includes the bar.", per_dumbbell: "Weight is per dumbbell.", stack: "Weight is the machine's stack or plates.",
  added: "Weight is added to body weight.", assistance: "Weight is assistance: less is heavier." };

async function progressPage(body, rerender) {
  const list = await exercises();
  if (!list.length) { body.append(notes("No exercises logged yet.")); return; }
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), exerciseSelect(list, "exercise", rerender), viewSwitch(rerender)));
  const { from, to } = period();
  const id = pref("exercise", list[0].exercise_id);
  const r = await call("exercise_progress", { exercise_id: id, from, to });
  const ws = r.workouts || [];
  if (!ws.length) { body.append(notes("No " + r.exercise + " in this period.", r.note)); return; }
  const rirText = (b) => b.rir === null || b.rir === undefined ? "" : "\nReps in reserve " + b.rir + (b.rir_assumed ? " (assumed)" : "");
  if (pref("view", "graph") === "graph") {
    const a = chartBox("Best set: " + r.exercise, "The heaviest working set in each workout, more reps breaking a tie");
    const b = chartBox("Weight moved", "Weight times reps over every working set");
    body.append(a.node);
    const moved = ws.some((w) => w.weight_moved);
    if (moved) body.append(b.node);
    draw(() => {
      const missed = (r.missed_workouts || []).filter((d) => d >= from && d <= to).map((d) => ({ date: d, missed: true }));
      const rows = [...ws, ...missed].sort((x, y) => x.date.localeCompare(y.date));
      Charts.line(a.plot, { aria: "Best set of " + r.exercise + " by workout",
        points: rows.map((w) => w.missed
          ? { label: long(w.date), short: short(w.date), value: null, missing: true, tip: long(w.date) + "\nA workout you didn't log" }
          : { label: long(w.date), short: short(w.date), value: w.best_set ? w.best_set.load : null, estimate: w.best_set && w.best_set.rir_assumed,
              tip: long(w.date) + "\n" + (w.best_set ? w.best_set.says + rirText(w.best_set) : "No working set") + "\n" + w.working_sets + " working sets" }) });
      if (moved) Charts.columns(b.plot, { aria: "Weight moved by workout",
        points: ws.map((w) => ({ label: long(w.date), short: short(w.date), value: w.weight_moved, tip: long(w.date) + "\n" + fmt(w.weight_moved) + " lb moved" })) });
    });
  } else {
    redraw = null;
    body.append(table(["Workout", "Best set", "Working sets", "Weight moved"],
      ws.map((w) => ({ cells: [long(w.date), w.best_set ? w.best_set.says + (w.best_set.rir_assumed ? " (reps in reserve assumed)" : "") : "", String(w.working_sets), w.weight_moved ? fmt(w.weight_moved) : ""] })), { num: [2, 3] }));
  }
  body.append(notes(LOAD_NOTE[r.load_meaning], r.best_set_rule, r.missed_workouts && r.missed_workouts.length ? "Workouts you said you didn't log: " + r.missed_workouts.map(long).join(", ") + "." : null, r.note));
}

async function recordsPage(body, rerender) {
  const list = await exercises();
  if (!list.length) { body.append(notes("No exercises logged yet.")); return; }
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), exerciseSelect(list, "exercise", rerender), viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("personal_records", { exercise_id: pref("exercise", list[0].exercise_id), from, to });
  const byReps = (r.by_reps || []).slice().sort((x, y) => x.reps - y.reps);
  const byLoad = (r.by_load || []).slice().sort((x, y) => y.load - x.load);
  if (!byReps.length) { body.append(notes("No working sets of " + r.exercise + " in this period.")); return; }
  if (pref("view", "graph") === "graph") {
    const box = chartBox("Heaviest weight for each number of reps: " + r.exercise, "Working sets only; no estimated one-rep max");
    body.append(box.node);
    draw(() => Charts.columns(box.plot, { aria: "Heaviest weight by reps",
      points: byReps.map((p) => ({ label: p.reps + " reps", short: p.reps + "", value: p.load, tip: p.says + "\nFirst done " + long(p.date) })) }));
    body.append(notes("Across the bottom: reps."));
  } else {
    redraw = null;
    body.append(h("h2", {}, "Heaviest weight for each number of reps"));
    body.append(table(["Reps", "Set", "First done"], byReps.map((p) => ({ cells: [String(p.reps), p.says, long(p.date)] })), { num: [0] }));
    body.append(h("h2", {}, "Most reps at each weight"));
    body.append(table(["Weight", "Set", "First done"], byLoad.map((p) => ({ cells: [fmt(p.load), p.says, long(p.date)] })), { num: [0] }));
  }
  body.append(notes(LOAD_NOTE[r.load_meaning], r.rule));
}

async function setsPage(body, rerender) {
  const by = pref("setsBy", "muscle_group");
  const pick = pref("setsPick", "");
  const { from, to } = period();
  const r = await call("training_volume", { by, from, to });
  const weeks = r.weeks || [];
  const names = [...new Set(weeks.flatMap((w) => (w.items || []).map((it) => it.name)))].sort();
  const chosen = names.includes(pick) ? pick : "";
  body.append(h("div", { class: "controls" }, ...periodControls(rerender),
    field("By", seg([["muscle_group", "Muscle group"], ["exercise", "Exercise"]], by, (v) => { setPref("setsBy", v); setPref("setsPick", ""); rerender(); }, "By muscle group or exercise")),
    field(by === "muscle_group" ? "Muscle group" : "Exercise", h("select", { onchange: (e) => { setPref("setsPick", e.target.value); rerender(); } },
      h("option", { value: "", selected: !chosen }, "All"), names.map((n) => h("option", { value: n, selected: n === chosen }, n)))),
    viewSwitch(rerender)));
  if (!weeks.length) { body.append(notes("No workouts in this period.")); return; }
  const setsOf = (w, n) => { const it = (w.items || []).find((x) => x.name === n); return it ? it.working_sets : 0; };
  const weekTip = (w) => w.note ? "\n" + w.note : "";
  if (pref("view", "graph") === "graph") {
    if (chosen) {
      const box = chartBox("Working sets per week: " + chosen, "Monday to Sunday");
      body.append(box.node);
      draw(() => Charts.columns(box.plot, { aria: "Working sets per week for " + chosen,
        points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start), value: setsOf(w, chosen),
          tip: "Week of " + short(w.week_start) + "\n" + setsOf(w, chosen) + " working sets" + weekTip(w) })) }));
    } else {
      // Only whole weeks inside the period count, so a week in progress or cut by the period doesn't pull the average down
      const whole = weeks.filter((w) => w.week_start >= from && addDays(w.week_start, 6) <= to && addDays(w.week_start, 6) < today());
      const base = whole.length ? whole : weeks;
      const avg = names.map((n) => ({ n, total: base.reduce((s, w) => s + setsOf(w, n), 0) }))
        .map((x) => ({ ...x, avg: x.total / base.length })).sort((a, b) => b.avg - a.avg);
      const box = chartBox("Average working sets per week", (whole.length ? "Over the " + whole.length + " whole weeks in the period" : "Over " + weeks.length + " weeks") + ", Monday to Sunday");
      body.append(box.node);
      draw(() => Charts.hbars(box.plot, { aria: "Average working sets per week",
        items: avg.map((x) => ({ label: x.n, value: x.avg, valueLabel: fmt(x.avg),
          tip: x.n + "\n" + weeks.map((w) => short(w.week_start) + ": " + setsOf(w, x.n)).join("\n") })) }));
    }
  } else {
    redraw = null;
    const shown = chosen ? [chosen] : names;
    body.append(table([by === "muscle_group" ? "Muscle group" : "Exercise", ...weeks.map((w) => short(w.week_start) + (w.missed_workouts && w.missed_workouts.length ? " *" : ""))],
      shown.map((n) => ({ cells: [n, ...weeks.map((w) => String(setsOf(w, n)))] })), { num: weeks.map((_, i) => i + 1) }));
  }
  const untagged = r.untagged_exercises || [];
  body.append(notes(
    by === "muscle_group" && untagged.length ? "Not counted by muscle group until you confirm their groups: " + untagged.join(", ") + "." : null,
    ...weeks.filter((w) => w.note).map((w) => "Week of " + short(w.week_start) + ": " + w.note),
    r.counting));
}

async function workoutsPage(body, rerender) {
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("workout_frequency", { from, to });
  const weeks = r.weeks || [];
  if (!weeks.length) { body.append(notes("No workouts in this period.")); return; }
  const listText = (w) => (w.list || []).map((x) => long(x.date) + (x.label ? ", " + x.label : "") + (x.length_min ? ", " + x.length_min + " min" : "") + ", " + x.working_sets + " sets").join("\n");
  if (pref("view", "graph") === "graph") {
    const a = chartBox("Workouts per week", "Monday to Sunday");
    const b = chartBox("Minutes trained per week", "Timed workouts only");
    body.append(a.node);
    const timed = weeks.some((w) => w.timed_minutes);
    if (timed) body.append(b.node);
    draw(() => {
      Charts.columns(a.plot, { aria: "Workouts per week", points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start), value: w.workouts,
        tip: "Week of " + short(w.week_start) + "\n" + listText(w) + (w.note ? "\n" + w.note : "") })) });
      if (timed) Charts.columns(b.plot, { aria: "Minutes trained per week", points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start), value: w.timed_minutes,
        tip: "Week of " + short(w.week_start) + "\n" + (w.timed_minutes || 0) + " minutes timed" })) });
    });
  } else {
    redraw = null;
    body.append(table(["Week", "Workouts", "Minutes", "Each workout"],
      weeks.map((w) => ({ cells: ["Week of " + short(w.week_start), String(w.workouts), w.timed_minutes ? String(w.timed_minutes) : "", h("span", { class: "small" }, ...listText(w).split("\n").flatMap((l, i) => i ? [h("br"), l] : [l]))] })), { num: [1, 2] }));
  }
  body.append(notes(...weeks.filter((w) => w.note).map((w) => "Week of " + short(w.week_start) + ": " + w.note), r.rule));
}

async function nutritionLiftsPage(body, rerender) {
  const list = await exercises();
  if (!list.length) { body.append(notes("No exercises logged yet.")); return; }
  const micros = await micronutrients();
  const nutrient = pref("nlNutrient", "protein");
  const options = [...NUTRIENT_CHOICES, ...micros.map((m) => [m, m])];
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), exerciseSelect(list, "exercise", rerender),
    field("Nutrient", h("select", { onchange: (e) => { setPref("nlNutrient", e.target.value); rerender(); } },
      options.map(([v, t]) => h("option", { value: v, selected: v === nutrient }, t)))),
    viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("nutrition_vs_performance", { exercise_id: pref("exercise", list[0].exercise_id), nutrient, from, to });
  const weeks = r.weeks || [];
  if (!weeks.length) { body.append(notes("Nothing in this period.")); return; }
  const unit = r.unit === "kcal" ? " kcal" : " " + r.unit;
  if (pref("view", "graph") === "graph") {
    const a = chartBox(r.nutrient.charAt(0).toUpperCase() + r.nutrient.slice(1) + ": average per full day, each week", "Monday to Sunday; missing days left out");
    const b = chartBox("Best set each week: " + r.exercise, "Heaviest working set, more reps breaking a tie");
    body.append(a.node, b.node);
    draw(() => {
      Charts.columns(a.plot, { aria: r.nutrient + " weekly average", points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start),
        value: w.full_days ? w.nutrient_average : null, missing: !w.full_days,
        tip: "Week of " + short(w.week_start) + "\n" + (w.full_days ? (w.at_least ? "at least " : "") + fmt(w.nutrient_average) + unit + "\nBased on " + w.full_days + " full days" : "No full days") + (w.note ? "\n" + w.note : "") })) });
      Charts.line(b.plot, { aria: "Best set by week", points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start),
        value: w.best_set ? w.best_set.load : null, tip: "Week of " + short(w.week_start) + "\n" + (w.best_set ? w.best_set.says + "\n" + long(w.best_set.date) : "No " + r.exercise + " this week") })) });
    });
    body.append(key(["miss", "atleast"]));
  } else {
    redraw = null;
    body.append(table(["Week", r.nutrient + " per full day", "Full days", "Best set"],
      weeks.map((w) => ({ cells: ["Week of " + short(w.week_start), w.full_days ? (w.at_least ? "≥ " : "") + fmt(w.nutrient_average) + unit : "*", String(w.full_days), w.best_set ? w.best_set.says : ""] })), { num: [1, 2] }));
  }
  body.append(notes(r.rule ? r.rule.replace(/ Say how sure you are.*$/, "") : null, r.training_note, ...weeks.filter((w) => w.note).map((w) => "Week of " + short(w.week_start) + ": " + w.note)));
}

const PAGES = [
  { path: "nutrition", title: "Nutrition", blurb: "Calories, protein, carbs, fat and any micronutrient, by day, week or month", render: nutritionPage },
  { path: "sources", title: "Where it comes from", blurb: "The foods that gave you the most of a nutrient", render: sourcesPage },
  { path: "progress", title: "Lift progress", blurb: "Your best set in each workout, and weight moved", render: progressPage },
  { path: "records", title: "Personal records", blurb: "Heaviest weight for each number of reps, and most reps at each weight", render: recordsPage },
  { path: "sets", title: "Weekly sets", blurb: "Working sets per week by muscle group or exercise", render: setsPage },
  { path: "workouts", title: "Workouts", blurb: "Workouts per week and how long they took", render: workoutsPage },
  { path: "nutrition-lifts", title: "Nutrition and lifts", blurb: "A nutrient's weekly average beside your best set", render: nutritionLiftsPage },
];

function homePage(body) {
  redraw = null;
  body.append(h("h1", {}, "Your POA"),
    h("p", { class: "muted" }, "Your reports, from the same records your coach uses. Your plan, today's log and cardio join this site as each part of POA is built."),
    h("div", { class: "tiles" }, PAGES.map((p) => h("a", { class: "tile", href: "#/" + p.path }, h("strong", {}, p.title), h("span", {}, p.blurb)))));
}

// ------------------------------------------------------------------ routing and sign-in

let renderToken = 0;
async function route() {
  const path = location.hash.replace(/^#\/?/, "");
  const page = PAGES.find((p) => p.path === path);
  for (const a of $("nav").querySelectorAll("a")) {
    const here = a.getAttribute("href") === "#/" + path;
    a.setAttribute("aria-current", here ? "page" : "false");
    if (here) a.scrollIntoView({ block: "nearest", inline: "center" });
  }
  const body = $("page");
  body.textContent = "";
  say("");
  if (!page) return homePage(body);
  const mine = ++renderToken;
  const inner = h("div", {});
  const rerender = () => route();
  body.append(h("h1", {}, page.title), inner);
  say("Loading...");
  try {
    await page.render(inner, rerender);
    if (mine === renderToken) say("");
  } catch (err) {
    if (mine === renderToken) say(err.message || String(err), true);
  }
}

function showSignIn(text) {
  $("signin").hidden = false;
  $("page").textContent = "";
  $("nav").hidden = true;
  $("signout").hidden = true;
  say(text || "", Boolean(text));
}

function showSite() {
  $("signin").hidden = true;
  $("nav").hidden = false;
  $("signout").hidden = false;
  route();
}

function buildNav() {
  $("nav").append(...PAGES.map((p) => h("a", { href: "#/" + p.path }, p.title)));
}

$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  say("Signing in...");
  const { error } = await client.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
  $("password").value = "";
  button.disabled = false;
  if (error) return say("Sign-in failed: " + error.message, true);
  showSite();
});
$("signout").addEventListener("click", async () => { await client.auth.signOut(); Object.keys(cache).forEach((k) => delete cache[k]); showSignIn("Signed out."); });
window.addEventListener("hashchange", () => { if ($("signin").hidden) route(); });

buildNav();
Charts.bindTips();
client.auth.getSession().then(({ data }) => (data && data.session ? showSite() : showSignIn()));
