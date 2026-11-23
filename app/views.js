"use strict";
// Report views shared by POA's private website (Build Package M3-PK003, task R5) and the graph card the
// connector shows in the conversation (task R4), so a report looks the same in both places (REQ-RPT-001).
// Each view draws one report result as a graph or as text over the same numbers (REQ-RPT-007), marks missing
// days with an asterisk and estimates differently (REQ-RPT-005). No data lives here: results arrive from the
// POA connector's report actions after Vince signs in, or from the tool result Claude passes to the card.
const Views = (() => {
  const fmt = Charts.fmt;

  // ---------------------------------------------------------------- dates
  const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const today = () => ymd(new Date());
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const short = (s) => { const d = parse(s); return MON[d.getMonth()] + " " + d.getDate(); };
  const long = (s) => { const d = parse(s); return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate(); };
  const monthName = (s) => { const d = parse(s); return MON[d.getMonth()] + " " + d.getFullYear(); };

  // ---------------------------------------------------------------- page parts
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

  function table(headers, rows, opts = {}) {
    return h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, headers.map((t, i) => h("th", { class: opts.num && opts.num.includes(i) ? "num" : null }, t)))),
      h("tbody", {}, rows.map((r) => h("tr", { class: r.cls || null }, r.cells.map((c, i) => h("td", { class: opts.num && opts.num.includes(i) ? "num" : null }, c)))))));
  }

  function chartBox(title, sub) {
    const plot = h("div", {});
    return { node: h("div", { class: "chart" }, h("h3", {}, title), sub ? h("p", { class: "sub" }, sub) : null, plot), plot };
  }

  // Report notes are written for the coach ("Vince didn't log"); shown to Vince they speak to him
  const you = (t) => t.replace(/\bVince's\b/g, "your").replace(/\bVince\b/g, "you").replace(/\bhis\b/g, "your").replace(/\bhe\b/g, "you");
  function notes(...lines) { return h("div", { class: "notes" }, lines.filter(Boolean).map((t) => h("p", {}, you(t)))); }

  function key(parts) {
    const items = [];
    if (parts.includes("est")) items.push(h("span", {}, h("i", { class: "k-est" }), "estimate or approximate amount"));
    if (parts.includes("miss")) items.push(h("span", {}, h("i", { class: "k-miss" }, "*"), "missing: nothing logged, or not fully logged"));
    if (parts.includes("atleast")) items.push(h("span", {}, "≥ at least: some foods are pending or have no value"));
    return h("div", { class: "key" }, items);
  }

  // Draw now and again when the width changes (a window resize, or the card's frame changing size). A page with several
  // charts (the exercise section, an exercise's page) keeps each one's drawing; a new page starts the list again.
  let redraws = [];
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => redraws.forEach((f) => f()), 150);
  });
  function draw(fn) { redraws.push(fn); fn(); }
  function stopDraw() { redraws = []; }

  // The connector's weight meanings (load_meaning)
  const LOAD_NOTE = { bar_total: "Weight includes the bar.", per_dumbbell: "Weight is per dumbbell.", stack: "Weight is the machine's stack.",
    plates_total: "Weight is the plates on both sides together.", added_to_bodyweight: "Weight is added to body weight.",
    assistance: "Weight is assistance: less is heavier." };

  // ---------------------------------------------------------------- report views
  // Each takes (body, r, o): body is the element to fill, r the report result, o.view "graph" or "text".

  function nutrition(body, r, o) {
    stopDraw();
    const grain = r.grain || o.grain || "day";
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
    if (!series.length) { body.append(notes("Nothing logged in this period.")); return; }

    if (o.view === "graph") {
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
      const rows = series.map((s) => ({ cls: isMissing(s) ? "missing" : null, cells: [label(s) + (grain === "day" && isMissing(s) ? ": " + missingWhy(s) : "") + (grain !== "day" && s.full_days !== undefined ? " (" + s.full_days + " of " + s.days + " days)" : ""), ...nutrients.map((n) => cell(s, n))] }));
      if (sum.average_per_full_day) rows.push({ cls: null, cells: ["Average per full day", ...nutrients.map((n) => (sum.at_least && sum.at_least[n.key] ? "≥ " : "") + fmt(sum.average_per_full_day[n.key]))] });
      body.append(table([grain === "day" ? "Day" : grain === "week" ? "Week" : "Month", ...nutrients.map((n) => n.name + (n.unit ? " (" + n.unit + ")" : ""))],
        rows, { num: nutrients.map((_, i) => i + 1) }));
      body.append(key(["est", "miss", "atleast"]));
    }
    body.append(notes(sum.note, r.target_note));
  }

  function sources(body, r, o) {
    stopDraw();
    const foods = r.top_foods || [];
    const unit = r.unit === "kcal" ? " kcal" : " " + r.unit;
    if (!foods.length) { body.append(notes("Nothing logged in this period has a value for " + r.nutrient + ".")); return; }
    if (o.view === "graph") {
      const box = chartBox("Where your " + r.nutrient + " came from", "Share of the period's total of " + fmt(r.total) + unit + ", top " + foods.length + " foods");
      body.append(box.node);
      draw(() => Charts.hbars(box.plot, {
        aria: "Top foods for " + r.nutrient,
        items: foods.map((f) => ({ label: f.food, value: f.share_pct, estimate: f.estimate, valueLabel: f.share_pct + "%",
          tip: f.food + "\n" + fmt(f.amount) + unit + " (" + f.share_pct + "% of the total)\n" + f.entries + " entries" + (f.estimate ? "\nIncludes estimates" : "") })),
      }));
    } else {
      body.append(table(["Food", "Amount", "Share", "Entries"],
        foods.map((f) => ({ cells: [f.food + (f.estimate ? " (est.)" : ""), fmt(f.amount) + unit, f.share_pct + "%", String(f.entries)] })), { num: [1, 2, 3] }));
    }
    body.append(notes(r.foods_without_value ? r.foods_without_value + " food entries in this period have no value for " + r.nutrient + ", so the total is at least " + fmt(r.total) + unit + "." : null));
  }

  function progress(body, r, o) {
    stopDraw();
    const ws = r.workouts || [];
    if (!ws.length) { body.append(notes("No " + r.exercise + " in this period.", r.note)); return; }
    const from = r.from || o.from, to = r.to || o.to;
    const rirText = (b) => b.rir === null || b.rir === undefined ? "" : "\nReps in reserve " + b.rir + (b.rir_assumed ? " (assumed)" : "");
    if (o.view === "graph") {
      const a = chartBox("Best set: " + r.exercise, "The heaviest working set in each workout, more reps breaking a tie");
      const b = chartBox("Weight moved", "Weight times reps over every working set");
      body.append(a.node);
      const moved = ws.some((w) => w.weight_moved);
      if (moved) body.append(b.node);
      draw(() => {
        const missed = (r.missed_workouts || []).filter((d) => (!from || d >= from) && (!to || d <= to)).map((d) => ({ date: d, missed: true }));
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
      body.append(table(["Workout", "Best set", "Working sets", "Weight moved"],
        ws.map((w) => ({ cells: [long(w.date), w.best_set ? w.best_set.says + (w.best_set.rir_assumed ? " (reps in reserve assumed)" : "") : "", String(w.working_sets), w.weight_moved ? fmt(w.weight_moved) : ""] })), { num: [2, 3] }));
    }
    body.append(notes(LOAD_NOTE[r.load_meaning], r.best_set_rule, r.missed_workouts && r.missed_workouts.length ? "Workouts you said you didn't log: " + r.missed_workouts.map(long).join(", ") + "." : null, r.note));
  }

  function records(body, r, o) {
    stopDraw();
    const byReps = (r.by_reps || []).slice().sort((x, y) => x.reps - y.reps);
    const byLoad = (r.by_load || []).slice().sort((x, y) => y.load - x.load);
    if (!byReps.length) { body.append(notes("No working sets of " + r.exercise + " in this period.")); return; }
    if (o.view === "graph") {
      const box = chartBox("Heaviest weight for each number of reps: " + r.exercise, "Working sets only; no estimated one-rep max");
      body.append(box.node);
      draw(() => Charts.columns(box.plot, { aria: "Heaviest weight by reps",
        points: byReps.map((p) => ({ label: p.reps + " reps", short: p.reps + "", value: p.load, tip: p.says + "\nFirst done " + long(p.date) })) }));
      body.append(notes("Across the bottom: reps."));
    } else {
      body.append(h("h2", {}, "Heaviest weight for each number of reps"));
      body.append(table(["Reps", "Set", "First done"], byReps.map((p) => ({ cells: [String(p.reps), p.says, long(p.date)] })), { num: [0] }));
      body.append(h("h2", {}, "Most reps at each weight"));
      body.append(table(["Weight", "Set", "First done"], byLoad.map((p) => ({ cells: [fmt(p.load), p.says, long(p.date)] })), { num: [0] }));
    }
    body.append(notes(LOAD_NOTE[r.load_meaning], r.rule));
  }

  // The names in a training volume result (muscle groups or exercises), for a picker
  const setNames = (r) => [...new Set((r.weeks || []).flatMap((w) => (w.items || []).map((it) => it.name)))].sort();

  function sets(body, r, o) {
    stopDraw();
    const weeks = r.weeks || [];
    const by = r.by || o.by || "muscle_group";
    const names = setNames(r);
    const chosen = names.includes(o.pick) ? o.pick : "";
    const from = r.from || o.from, to = r.to || o.to;
    if (!weeks.length) { body.append(notes("No workouts in this period.")); return; }
    const setsOf = (w, n) => { const it = (w.items || []).find((x) => x.name === n); return it ? it.working_sets : 0; };
    const weekTip = (w) => w.note ? "\n" + w.note : "";
    if (o.view === "graph") {
      if (chosen) {
        const box = chartBox("Working sets per week: " + chosen, "Monday to Sunday");
        body.append(box.node);
        draw(() => Charts.columns(box.plot, { aria: "Working sets per week for " + chosen,
          points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start), value: setsOf(w, chosen),
            tip: "Week of " + short(w.week_start) + "\n" + setsOf(w, chosen) + " working sets" + weekTip(w) })) }));
      } else {
        // Only whole weeks inside the period count, so a week in progress or cut by the period doesn't pull the average down
        const whole = weeks.filter((w) => (!from || w.week_start >= from) && (!to || addDays(w.week_start, 6) <= to) && addDays(w.week_start, 6) < today());
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

  function nutritionLifts(body, r, o) {
    stopDraw();
    const weeks = r.weeks || [];
    if (!weeks.length) { body.append(notes("Nothing in this period.")); return; }
    const unit = r.unit === "kcal" ? " kcal" : " " + r.unit;
    if (o.view === "graph") {
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
      body.append(table(["Week", r.nutrient + " per full day", "Full days", "Best set"],
        weeks.map((w) => ({ cells: ["Week of " + short(w.week_start), w.full_days ? (w.at_least ? "≥ " : "") + fmt(w.nutrient_average) + unit : "*", String(w.full_days), w.best_set ? w.best_set.says : ""] })), { num: [1, 2] }));
    }
    body.append(notes(r.rule ? r.rule.replace(/ Say how sure you are.*$/, "") : null, r.training_note, ...weeks.filter((w) => w.note).map((w) => "Week of " + short(w.week_start) + ": " + w.note)));
  }

  // Body weight (REQ-BW-008, REQ-RPT-008): each day's weight, each week's average and every reading. A day without a
  // weigh-in is a gap, never zero, and isn't missing data, so nothing here carries an asterisk (REQ-RPT-005 r3).
  const lb = (v) => (v === null || v === undefined ? "–" : String(Number(v)));
  // A weight as he said it ("184.0 lb"), from the database's weight_said (migration 069; CR1-D017)
  const reading = (x) => (x.approximate ? "about " : "") + (x.weight_said || lb(x.weight_lb)) + " lb"
    + (x.kg ? " (" + (x.said && / kg$/.test(x.said) ? x.said : lb(x.kg) + " kg") + ")" : "");
  const readingTime = (x) => (x.time_said || "no time") + (x.zone_name ? " " + x.zone_name : "") + (x.reported_later ? ", reported later" : "");
  function bodyWeight(body, r, o) {
    stopDraw();
    const days = r.days || [];
    if (r.status === "no_weigh_ins" || !days.length) { body.append(notes(r.says || "No weigh-ins in this period.")); return; }
    const byDay = new Map(days.map((d) => [d.date, d]));
    const all = [];
    for (let s = r.from; s <= r.to; s = addDays(s, 1)) all.push(s);
    const weeks = r.weeks || [];
    const wk = (w) => "Week of " + short(w.week_start) + (w.label ? " (" + w.label + ")" : "");
    const based = (n) => "based on " + n + " day" + (n === 1 ? "" : "s");
    const approxKey = h("div", { class: "key" }, h("span", {}, h("i", { class: "k-est" }), "approximate reading (\"about\")"));
    if (o.view === "graph") {
      const a = chartBox("Weight (lb)", "Each day's first weigh-in; a day without one is a gap");
      // Weight against calories on one graph (REQ-RPT-008 example 1; CR1-D019)
      const b = chartBox("Average weight and calories each week", "Line: average weight (lb, left), over the days weighed. Bars: calories per full day (right). Monday to Sunday");
      body.append(a.node, b.node, approxKey);
      draw(() => {
        Charts.line(a.plot, { aria: "Weight by day", points: all.map((s) => {
          const d = byDay.get(s);
          return { label: long(s), short: short(s), value: d ? d.weight_lb : null, estimate: !!(d && d.approximate),
            tip: long(s) + "\n" + (d ? (d.approximate ? "about " : "") + lb(d.weight_lb) + " lb" + (d.readings > 1 ? "\n" + d.readings + " weigh-ins that day; the first counts" : "") : "No weigh-in") };
        }) });
        Charts.pair(b.plot, { aria: "Average weight and calories per full day by week", points: weeks.map((w) => ({ label: wk(w), short: short(w.week_start),
          value: w.average_lb, bar: w.calorie_days ? w.calories_average : null, barMissing: !w.calorie_days,
          tip: wk(w) + "\n" + (w.average_lb !== null && w.average_lb !== undefined ? lb(w.average_lb) + " lb, " + based(w.days) : "No weigh-ins")
               + "\n" + (w.calorie_days ? fmt(w.calories_average) + " kcal per full day, " + based(w.calorie_days) : "No full days") })) });
      });
    } else {
      body.append(table(["Day", "Time", "Weight", "Note"], (r.readings || []).map((x) => ({ cells: [long(x.date), readingTime(x), reading(x), x.note || ""] })), { num: [2] }));
      body.append(table(["Week", "Average weight", "Days weighed", "Calories per full day"],
        weeks.map((w) => ({ cells: [wk(w), w.average_lb !== null && w.average_lb !== undefined ? lb(w.average_lb) + " lb" : "No weigh-ins", String(w.days),
          w.calorie_days ? fmt(w.calories_average) + " (" + w.calorie_days + " days)" : "–"] })), { num: [1, 2, 3] }));
      body.append(approxKey);
    }
    body.append(notes(r.since_start ? "Since the start: " + r.since_start.says : null,
      "Each day's weight is its first weigh-in. A day without a weigh-in is a gap, never zero."));
  }

  // ---------------------------------------------------------------- the exercise pages (REQ-WEB-016 to 021)
  // Every set is shown as the database words it (REQ-WEB-018): the weight with its meaning, the reps and the reps in
  // reserve, an assumed value drawn differently (REQ-LOG-007), each weight of a drop set on its own line, and marks.
  // The counting rules are the database's (migration 065); these views only show what the reads give.

  const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  const dayComma = (s) => { const d = parse(s); return DOW[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate(); };
  const exHref = (id) => "#/ex/" + id;
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  // A week's label: "Nov 2–8", or with its days when the period's edge cuts it, "Nov 14–15 (2 days)"
  function weekLabel(w) {
    const a = parse(w.from || w.week_start), b = parse(w.to || addDays(w.week_start, 6));
    const span = a.getTime() === b.getTime() ? short(w.from) : a.getMonth() === b.getMonth()
      ? MON[a.getMonth()] + " " + a.getDate() + "–" + b.getDate() : short(w.from) + "–" + short(w.to);
    const days = w.days || 7;
    return span + (days < 7 ? " (" + plural(days, "day") + ")" : "");
  }
  const star = (w) => (w.note ? " *" : "");

  // One logged set (label "Set 2", or "Warm-up"); s is a set with its display, or a display itself
  function setItem(s, label) {
    const d = s.display || s;
    const lines = d.lines || [];
    const rir = d.rir ? h("span", { class: d.rir_assumed ? "assumed" : null }, " · " + d.rir) : null;
    const tags = (d.marks || []).filter((m) => m !== "warm-up").map((m) => h("span", { class: "tag" }, m));
    const lab = h("span", { class: "muted" }, (d.warm_up ? "Warm-up" : label) + ": ");
    if (lines.length > 1) {
      return h("li", {}, lab, h("ul", { class: "drops" }, lines.map((l, k) => h("li", {}, l.text, k === lines.length - 1 ? rir : null,
        l.mark ? h("span", { class: "tag" }, l.mark) : null))), ...tags);
    }
    return h("li", {}, lab, lines.length ? lines[0].text : "", rir, ...tags);
  }
  // Every set of an exercise in a workout, numbered among the working sets
  function setList(sets) {
    let n = 0;
    return h("ol", { class: "sets" }, (sets || []).map((s) => setItem(s, "Set " + ((s.display || s).warm_up ? 0 : ++n))));
  }
  const nothing = () => h("p", { class: "muted small" }, "Nothing logged in this period.");

  // Exercises (REQ-WEB-016): every exercise he has logged, the most recently done first
  function exerciseList(body, r) {
    const xs = r.exercises || [];
    if (!xs.length) { body.append(notes("No exercises logged yet.")); return; }
    body.append(h("div", { class: "list" }, xs.map((x) => h("a", { class: "row-link", href: exHref(x.exercise_id) },
      h("span", { class: "s-main" }, h("span", { class: "s-title" }, cap(x.exercise)),
        h("span", { class: "s-sub" }, [x.muscle_groups && x.muscle_groups.length ? x.muscle_groups.map(cap).join(", ") : "Muscle groups not confirmed yet",
          "last done " + dayComma(x.last_done), plural(x.workouts_in_period, "workout") + " in this period"].join(" · "))),
      h("span", { class: "s-right" }, "›")))));
  }

  // Personal records across all his exercises (REQ-WEB-016): newest first, each opening its exercise's page
  function recordsList(body, r) {
    const rs = r.records || [];
    if (!rs.length) { body.append(h("p", { class: "muted small" }, "No new records in this period.")); return; }
    body.append(h("div", { class: "list" }, rs.slice(0, 12).map((x) => h("a", { class: "row-link", href: exHref(x.exercise_id) },
      h("span", { class: "s-main" }, h("span", { class: "s-title" }, cap(x.exercise)),
        h("span", { class: "s-sub" }, x.says + " · " + dayComma(x.date) + " · " + (x.heavier_for_reps ? "heaviest for " + x.reps + " reps" : "most reps at this weight"))),
      h("span", { class: "s-right" }, "›")))));
    if (rs.length > 12) body.append(h("p", { class: "tiny muted" }, (rs.length - 12) + " more in this period."));
    body.append(notes(r.rule));
  }

  // Working sets by muscle group (REQ-WEB-020): the group picked, each week's count opening to every set, numbered
  function muscleGroupSets(body, r, o) {
    const weeks = r.weeks || [];
    if (o.onPick) {
      body.append(h("div", { class: "mg-pick", role: "group", "aria-label": "Muscle group" }, (r.groups || []).map((g) =>
        h("button", { type: "button", class: "btn", "aria-pressed": String(g === r.muscle_group), onclick: () => { if (g !== r.muscle_group) o.onPick(g); } }, cap(g)))));
    }
    const total = weeks.reduce((a, w) => a + w.working_sets, 0);
    if (o.view === "graph") {
      if (!total) { body.append(nothing()); } else {
        const box = chartBox(cap(r.muscle_group) + ": working sets per week", "Monday to Sunday");
        body.append(box.node);
        draw(() => Charts.columns(box.plot, { aria: "Working sets per week for " + r.muscle_group,
          points: weeks.map((w) => ({ label: weekLabel(w), short: short(w.from), value: w.working_sets,
            tip: weekLabel(w) + "\n" + plural(w.working_sets, "working set") + (w.note ? "\n" + w.note : "") })) }));
      }
    } else {
      body.append(h("div", { class: "list" }, weeks.slice().reverse().map((w) => h("details", { class: "row" },
        h("summary", {}, h("span", { class: "s-main" }, h("span", { class: "s-title" }, weekLabel(w))), h("span", { class: "s-right" }, String(w.working_sets) + star(w))),
        h("div", { class: "inner" }, w.sets.length
          ? h("ol", { class: "sets numbered" }, w.sets.map((s) => h("li", {}, h("a", { href: "#/day/" + s.date }, dayComma(s.date)), " · ",
              h("a", { href: exHref(s.exercise_id) }, cap(s.exercise)), " · " + s.says + (s.drop_part ? " (drop " + s.drop_part + ")" : ""))))
          : h("p", { class: "muted small" }, "No " + r.muscle_group + " sets this week."))))));
    }
    body.append(notes(...weeks.filter((w) => w.note).map((w) => weekLabel(w) + ": " + w.note), r.rule));
  }

  // Workouts (REQ-WEB-021): how many each week and how long each took; open and not-timed workouts aren't averaged
  const lengthText = (x) => (x.timing === "open" ? "open" : x.length_min !== null && x.length_min !== undefined ? x.length_min + " min" : "not timed");
  function workouts(body, r, o) {
    const weeks = r.weeks || [];
    const total = weeks.reduce((a, w) => a + w.workouts, 0);
    const avgText = (w) => (w.average_min !== null && w.average_min !== undefined ? "average " + w.average_min + " min" : "no timed workout");
    if (o.view === "graph") {
      if (!total) { body.append(nothing()); } else {
        const a = chartBox("Workouts per week", "Monday to Sunday");
        body.append(a.node);
        draw(() => Charts.columns(a.plot, { aria: "Workouts per week", points: weeks.map((w) => ({ label: weekLabel(w), short: short(w.from || w.week_start),
          value: w.workouts, tip: weekLabel(w) + "\n" + plural(w.workouts, "workout") + ", " + avgText(w) + (w.note ? "\n" + w.note : "") })) }));
      }
    } else {
      body.append(h("div", { class: "list" }, weeks.slice().reverse().map((w) => h("details", { class: "row" },
        h("summary", {}, h("span", { class: "s-main" }, h("span", { class: "s-title" }, weekLabel(w)), h("span", { class: "s-sub" }, cap(avgText(w)))),
          h("span", { class: "s-right" }, String(w.workouts) + star(w))),
        h("div", { class: "inner" }, (w.list || []).length
          ? (w.list || []).map((x) => h("div", { class: "wo" }, h("a", { href: "#/day/" + x.date }, dayComma(x.date)),
              h("span", { class: "muted small" }, " · " + lengthText(x) + " · " + plural(x.working_sets, "working set"))))
          : h("p", { class: "muted small" }, "No workouts this week."))))));
    }
    body.append(notes(...weeks.filter((w) => w.note).map((w) => weekLabel(w) + ": " + w.note), r.rule));
  }

  // One exercise's page (REQ-WEB-017): Progress, Personal records, Working sets per week, Every workout
  function exercisePage(body, r, o) {
    const sec = (title, sub, ...kids) => { const s = h("section", { class: "card report" }, h("h2", {}, title), sub ? h("p", { class: "muted small" }, sub) : null, ...kids); body.append(s); return s; };
    const lastDone = r.last_done ? "Last done " + dayComma(r.last_done) + "." : "";
    const none = h("p", { class: "muted small" }, "Nothing logged in this period. " + lastDone);
    const prog = (r.progress || []).filter((w) => w.best_set);
    const s1 = sec("Progress", "The best set of each workout: the heaviest working set, more reps breaking a tie; and the weight moved");
    if (!prog.length) s1.append(none.cloneNode(true));
    else if (o.view === "graph") {
      const a = chartBox("Best set: " + r.exercise, null);
      const moved = prog.some((w) => w.weight_moved);
      const b = chartBox("Weight moved", "Every working rep at its weight");
      s1.append(a.node);
      if (moved) s1.append(b.node);
      draw(() => {
        Charts.line(a.plot, { aria: "Best set of " + r.exercise + " by workout", points: prog.map((w) => ({ label: dayComma(w.date), short: short(w.date),
          value: w.best_set.load, tip: dayComma(w.date) + "\n" + w.best_set.says + "\n" + plural(w.working_sets, "working set") })) });
        if (moved) Charts.columns(b.plot, { aria: "Weight moved by workout", points: prog.map((w) => ({ label: dayComma(w.date), short: short(w.date),
          value: w.weight_moved, tip: dayComma(w.date) + "\n" + fmt(w.weight_moved) + " lb moved" })) });
      });
    } else {
      s1.append(table(["Workout", "Best set", "Working sets", "Weight moved"], prog.slice().reverse().map((w) => ({
        cells: [dayComma(w.date), w.best_set.says, String(w.working_sets), w.weight_moved !== null && w.weight_moved !== undefined ? fmt(w.weight_moved) + " lb" : "–"] })), { num: [2, 3] }));
    }
    const rec = r.records || {};
    const byReps = (rec.by_reps || []).slice().sort((x, y) => x.reps - y.reps);
    const byLoad = (rec.by_load || []).slice();
    sec("Personal records", "In the period chosen, with the day each was first set. Working sets only; no estimated one-rep max.",
      byReps.length ? [h("h3", {}, "Heaviest weight for each number of reps"),
        table(["Reps", "Heaviest", "Day"], byReps.map((x) => ({ cells: [String(x.reps), x.says, dayComma(x.date)] })), { num: [0] }),
        h("h3", {}, "Most reps at each weight"),
        table(["Weight", "Most reps", "Day"], byLoad.map((x) => ({ cells: [x.says.replace(/ × \d+$/, ""), String(x.reps), dayComma(x.date)] })), { num: [1] })]
        : none.cloneNode(true));
    const weeks = r.weeks || [];
    const s3 = sec("Working sets per week", "Monday to Sunday; a week cut by the period's edge says how many days it covers");
    if (o.view === "graph") {
      if (!weeks.some((w) => w.working_sets)) s3.append(none.cloneNode(true));
      else {
        const c = chartBox("Working sets of " + r.exercise + " per week", null);
        s3.append(c.node);
        draw(() => Charts.columns(c.plot, { aria: "Working sets per week", points: weeks.map((w) => ({ label: weekLabel(w), short: short(w.from),
          value: w.working_sets, tip: weekLabel(w) + "\n" + plural(w.working_sets, "working set") + (w.note ? "\n" + w.note : "") })) }));
      }
    } else {
      s3.append(table(["Week", "Working sets"], weeks.map((w) => ({ cells: [weekLabel(w), String(w.working_sets) + star(w)] })), { num: [1] }));
    }
    const ws = r.workouts || [];
    const s4 = sec("Every workout", "Newest first, back to the start of the period; tap a workout for its sets");
    if (!ws.length) s4.append(none.cloneNode(true));
    else {
      s4.append(h("div", { class: "list" }, ws.map((w) => h("details", { class: "row" },
        h("summary", {}, h("span", { class: "s-main" }, h("span", { class: "s-title" }, dayComma(w.date)),
          h("span", { class: "s-sub short" }, (w.entries || []).map((e) => e.short).join(", "))),
          h("span", { class: "s-right" }, plural(w.working_sets, "set"))),
        h("div", { class: "inner" },
          (w.entries || []).flatMap((e) => [e.replaces ? h("p", { class: "small" }, h("span", { class: "tag" }, "instead of " + e.replaces)) : null, setList(e.sets)]),
          w.best_set ? h("p", { class: "small muted" }, "Best set: " + w.best_set) : h("p", { class: "small muted" }, "No best set: warm-ups only"),
          h("a", { class: "ex-link", href: "#/day/" + w.date }, "Open the day ›"))))));
      if (r.more_before && o.more) s4.append(h("button", { type: "button", class: "btn", onclick: o.more }, "Show earlier workouts"));
      else s4.append(h("p", { class: "tiny muted" }, "That's every workout back to the start of the period."));
    }
    body.append(notes(LOAD_NOTE[r.load_meaning], r.note));
  }


  // ---------------------------------------------------------------- the coach's plan (REQ-OBJ-006, REQ-WEB-023)
  // Drawn from plan (migration 052): what the database returns and nothing else, so no picture without a plan, a
  // planned mesocycle is an outline, and how sure the coach is shows as the number only (REQ-OBJ-004).
  const sure = (f) => (!f ? "no forecast yet" : f.state === "scored" ? f.score + " out of 100" : f.says);
  const objWords = { build: "build", cut: "cut", maintain: "maintenance phase" };
  const span = (a, b) => short(a) + " – " + short(b);
  const goalLines = (goals) => (goals || []).map((g) => h("p", { class: "small" }, g.goal_said + (g.is_limit ? " (a limit)" : "")
    + (g.progress && g.progress.calculated && g.progress.says ? ": " + g.progress.says : "")
    + (g.forecast ? " How sure the coach is: " + sure(g.forecast) + "." : "")));
  // The week a path entry is for: its week_start, or else its week number counted from the forecast's week
  const mondayOf = (s) => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
  function pathWeeks(path) {
    if (!path || !Array.isArray(path.path)) return [];
    const base = path.as_of ? mondayOf(String(path.as_of).slice(0, 10)) : null;
    return path.path.map((x) => ({ week_start: x.week_start || (base && x.week ? addDays(base, 7 * (x.week - 1)) : null), low: x.low, high: x.high }))
      .filter((x) => x.week_start && typeof x.low === "number" && typeof x.high === "number");
  }

  function planBar(r) {
    const segs = (r.mesocycles || []).map((m) => ({ kind: m.status === "done" ? "done" : m.status === "upcoming" ? "upcoming" : "current", weeks: m.weeks || m.length_weeks, m }))
      .concat((r.outline || []).map((b) => ({ kind: "planned", weeks: b.length_weeks, b })));
    const cur = (r.mesocycles || []).find((m) => m.status === "current");
    const bar = h("div", { class: "plan-bar", role: "img", "aria-label": "Mesocycles: "
      + segs.map((s) => s.kind === "planned" ? "planned" : s.kind + (s.m.number ? " mesocycle " + s.m.number : "")).join(", ") });
    for (const s of segs) {
      const box = h("span", { class: "m-" + s.kind, style: "flex-grow:" + s.weeks,
        title: s.m ? (s.m.number ? "Mesocycle " + s.m.number + ": " : "") + objWords[s.m.objective] + ", " + span(s.m.start_date, s.m.end_date)
                   : "Planned: " + objWords[s.b.objective] + ", " + s.b.length_weeks + " weeks" },
        s.kind === "current" && s.m.weeks_on_day ? "Week " + s.m.weeks_on_day.week_number + " of " + s.m.weeks_on_day.total : String(s.weeks) + " wk");
      if (s.kind === "current" && s.m.weeks_on_day) {
        const days = (parse(r.date) - parse(s.m.start_date)) / 86400000 + 0.5;
        box.append(h("i", { class: "now", style: "left:" + Math.min(100, Math.max(0, (100 * days) / (7 * s.weeks))).toFixed(1) + "%", "aria-hidden": "true" }));
      }
      bar.append(box);
    }
    const done = segs.filter((s) => s.kind === "done").length, planned = segs.filter((s) => s.kind === "planned" || s.kind === "upcoming").length;
    const caption = [done ? done + " done" : null,
      cur ? "now " + (cur.number ? "mesocycle " + cur.number + ", " : "") + objWords[cur.objective] + ", week " + cur.weeks_on_day.week_number + " of " + cur.weeks_on_day.total : "none current",
      planned ? planned + " planned" : null].filter(Boolean).join(" · ");
    return [bar, h("p", { class: "small muted" }, caption)];
  }

  function planList(r) {
    const items = (r.mesocycles || []).map((m) => {
      const head = (m.number ? "Mesocycle " + m.number + ": " : "") + cap(objWords[m.objective]) + ", " + m.weeks + " weeks, " + span(m.start_date, m.end_date);
      const kids = [h("p", {}, h("strong", {}, head))];
      if (m.status === "done") {
        kids.push(...goalLines((m.goals || []).map((g) => ({ ...g, progress: null, forecast: null }))));
        kids.push(m.review ? h("p", { class: "small" }, "Result: " + m.review.result + ". Ratings: the coach's " + m.review.coach_rating
          + ", yours " + (m.review.vince_rating || "not given")) : h("p", { class: "small muted" }, "Not reviewed yet"));
      } else if (m.status === "current") {
        kids.push(h("p", { class: "small" }, m.weeks_on_day.says + "."), ...goalLines(m.goals));
      } else kids.push(h("p", { class: "small" }, "Starts " + long(m.start_date) + "."), ...goalLines((m.goals || []).map((g) => ({ ...g, progress: null }))));
      return h("li", {}, kids);
    }).concat((r.outline || []).map((b) => h("li", {}, h("p", {}, h("strong", {}, "Planned: " + cap(objWords[b.objective]) + ", " + b.length_weeks + " weeks")),
      h("p", { class: "small" }, b.goal_summary + ". An outline, agreed when it comes up."))));
    return h("ul", { class: "plan-list" }, items);
  }

  function weightLine(r, o) {
    const wl = r.weight_line;
    if (!wl) return notes(r.weight_line_says || "No weigh-ins yet.");
    const weeks = wl.weeks || [];
    const path = pathWeeks(wl.path);
    const starts = [...new Set(weeks.map((w) => w.week_start).concat(path.map((x) => x.week_start)))].sort();
    const byW = new Map(weeks.map((w) => [w.week_start, w]));
    const byP = new Map(path.map((x) => [x.week_start, x]));
    const pts = starts.map((s) => {
      const w = byW.get(s), p = byP.get(s);
      return { label: "Week of " + short(s), short: short(s), value: w ? w.average_lb : null, low: p ? p.low : null, high: p ? p.high : null,
        tip: "Week of " + short(s) + "\n" + (w ? lb(w.average_lb) + " lb average, " + w.days + " day" + (w.days === 1 ? "" : "s") + " weighed" : "No weigh-ins")
             + (p ? "\nPlan's path: " + lb(p.low) + " to " + lb(p.high) + " lb" : "") };
    });
    const box = h("div", {});
    if (o.view === "graph") {
      const c = chartBox("Weight against the plan's path (lb)", "Your weekly average weight; the shaded band is the coach's latest forecast path");
      box.append(c.node);
      draw(() => Charts.line(c.plot, { aria: "Weekly average weight against the plan's path", points: pts }));
    } else {
      box.append(table(["Week", "Average weight", "Plan's path"], pts.map((p) => ({ cells: [p.label,
        p.value !== null ? lb(p.value) + " lb" : "No weigh-ins", p.low !== null ? lb(p.low) + " to " + lb(p.high) + " lb" : "–"] })), { num: [1, 2] }));
    }
    box.append(notes(!weeks.length ? "No weigh-ins yet: only the plan's path is shown." : null,
      !path.length ? "No forecast path yet: only your weekly averages are shown." : null));
    return box;
  }

  function planView(body, r, o) {
    stopDraw();
    if (!r || r.status !== "ok") { body.append(notes((r && r.says) || "No plan yet.")); return; }
    const g = r.long_term_goal;
    if (g) body.append(h("div", { class: "plan-goal" }, h("p", {}, h("strong", {}, "Long-term goal: "), g.goal_said),
      g.progress && g.progress.says ? h("p", { class: "small" }, g.progress.says) : null,
      h("p", { class: "small" }, "How sure the coach is: " + sure(g.forecast))));
    body.append(...planBar(r));
    const list = planList(r);
    list.hidden = !o.list;
    const btn = h("button", { type: "button", class: "link", "aria-expanded": String(!!o.list) }, o.list ? "Hide the list" : "List each mesocycle");
    btn.addEventListener("click", () => { list.hidden = !list.hidden; btn.textContent = list.hidden ? "List each mesocycle" : "Hide the list";
      btn.setAttribute("aria-expanded", String(!list.hidden)); });
    body.append(btn, list, weightLine(r, o));
  }

  // One progress check (REQ-OBJ-004), from progress_check: each part's value or what it waits for, and the coach's note
  const CHECK_TITLES = { day: "Today", week: "This week", month: "The last four weeks", mesocycle: "This mesocycle" };
  function progressCheck(body, r) {
    stopDraw();
    if (!r || r.status !== "ok") { body.append(notes((r && r.says) || "No check yet.")); return; }
    const p = r.parts || {};
    const line = (label, text) => h("p", { class: "small" }, h("strong", {}, label + ": "), text);
    const kids = [];
    if (r.kind === "day") {
      kids.push(line("Meals", p.meals.says), line("Weight", p.weight ? p.weight.says : p.weight_says),
        line("Sets", p.sets.says + " (planned: " + p.sets.planned_says.toLowerCase() + ")"), line("Photo", p.photo_says.toLowerCase()));
      kids.push(...goalLines(p.goals));
    } else if (r.kind === "week") {
      const w = p.weight.this_week;
      kids.push(line("Average weight", w.average_lb !== null && w.average_lb !== undefined ? w.says + (p.weight.change_says ? ", " + p.weight.change_says.toLowerCase() + " on the week before" : "") : w.says),
        line("Days weighed in", String(p.days_weighed_in.count)), line("Workouts", String(p.workouts.count)),
        line("Calories and protein", p.averages.days_counted ? fmt(p.averages.calories) + " kcal and " + fmt(p.averages.protein_g) + " g protein a day, over "
          + p.averages.days_counted + " full day" + (p.averages.days_counted === 1 ? "" : "s") : "No full days yet"),
        line("Sets on target", p.sets_on_target_says.toLowerCase()));
    } else if (r.kind === "month") {
      kids.push(line("Four-week change", p.weight_change.change_says || "Not enough weigh-ins"),
        line("Long-term goal", p.long_term_goal && p.long_term_goal.progress ? p.long_term_goal.progress.says : "No long-term goal"),
        line("Workouts", String(p.workouts.count)), line("Days of cardio", p.cardio_says.toLowerCase()));
    } else {
      kids.push(line("Weeks", p.weeks.says), ...goalLines(p.goals), line("Next", p.next.says));
    }
    kids.push(r.note ? line("The coach's note, " + short(r.note.noted_on), r.note.on_track.replace("_", " ") + ". " + r.note.note)
      : h("p", { class: "small muted" }, "No note from the coach for this period yet."));
    body.append(h("section", {}, h("h3", {}, CHECK_TITLES[r.kind] || "Check"), kids));
  }

  // Keyed by the connector's report action names
  const show = {
    nutrition_report: nutrition,
    nutrient_sources: sources,
    exercise_progress: progress,
    personal_records: records,
    training_volume: sets,
    workout_frequency: workouts,
    nutrition_vs_performance: nutritionLifts,
    body_weight_report: bodyWeight,
    exercise_list: exerciseList,
    records_report: recordsList,
    muscle_group_sets: muscleGroupSets,
    exercise_page: exercisePage,
    plan: planView,
    progress_check: progressCheck,
  };
  const titles = {
    nutrition_report: "Nutrition",
    nutrient_sources: "Where it comes from",
    exercise_progress: "Lift progress",
    personal_records: "Personal records",
    training_volume: "Weekly sets",
    workout_frequency: "Workouts",
    nutrition_vs_performance: "Calories and macros against performance",
    body_weight_report: "Body weight",
    exercise_list: "Exercises",
    records_report: "Personal records",
    muscle_group_sets: "Working sets by muscle group",
    exercise_page: "Exercise",
    plan: "Your plan",
    progress_check: "Progress check",
  };

  return { fmt, h, seg, field, table, notes, draw, stopDraw, setNames, show, titles, reading, readingTime, lb, setItem, setList, dayComma, exHref,
    dates: { ymd, parse, addDays, today, short, long, monthName, MON } };
})();
