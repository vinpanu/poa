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

  // Draw now and again when the width changes (a window resize, or the card's frame changing size)
  let redraw = null;
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => redraw && redraw(), 150);
  });
  function draw(fn) { redraw = fn; fn(); }
  function stopDraw() { redraw = null; }

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

  function workouts(body, r, o) {
    stopDraw();
    const weeks = r.weeks || [];
    if (!weeks.length) { body.append(notes("No workouts in this period.")); return; }
    const listText = (w) => (w.list || []).map((x) => long(x.date) + (x.label ? ", " + x.label : "") + (x.length_min ? ", " + x.length_min + " min" : "") + ", " + x.working_sets + " sets").join("\n");
    if (o.view === "graph") {
      const a = chartBox("Workouts per week", "Monday to Sunday");
      const b = chartBox("Minutes trained per week", "Timed workouts only");
      body.append(a.node);
      const timed = weeks.some((w) => w.timed_minutes);
      if (timed) body.append(b.node);
      draw(() => {
        Charts.columns(a.plot, { aria: "Workouts per week", points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start), value: w.workouts,
          tip: "Week of " + short(w.week_start) + "\n" + listText(w) + (w.note ? "\n" + w.note : "") })) });
        // A week without timed workouts is zero minutes, never missing data (REQ-RPT-005 example 5)
        if (timed) Charts.columns(b.plot, { aria: "Minutes trained per week", points: weeks.map((w) => ({ label: "Week of " + short(w.week_start), short: short(w.week_start), value: w.timed_minutes || 0,
          tip: "Week of " + short(w.week_start) + "\n" + (w.timed_minutes || 0) + " minutes timed" })) });
      });
    } else {
      body.append(table(["Week", "Workouts", "Minutes", "Each workout"],
        weeks.map((w) => ({ cells: ["Week of " + short(w.week_start), String(w.workouts), w.timed_minutes ? String(w.timed_minutes) : "", h("span", { class: "small" }, ...listText(w).split("\n").flatMap((l, i) => i ? [h("br"), l] : [l]))] })), { num: [1, 2] }));
    }
    body.append(notes(...weeks.filter((w) => w.note).map((w) => "Week of " + short(w.week_start) + ": " + w.note), r.rule));
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

  // Keyed by the connector's report action names
  const show = {
    nutrition_report: nutrition,
    nutrient_sources: sources,
    exercise_progress: progress,
    personal_records: records,
    training_volume: sets,
    workout_frequency: workouts,
    nutrition_vs_performance: nutritionLifts,
  };
  const titles = {
    nutrition_report: "Nutrition",
    nutrient_sources: "Where it comes from",
    exercise_progress: "Lift progress",
    personal_records: "Personal records",
    training_volume: "Weekly sets",
    workout_frequency: "Workouts",
    nutrition_vs_performance: "Nutrition and lifts",
  };

  return { fmt, h, seg, field, table, notes, draw, stopDraw, setNames, show, titles,
    dates: { ymd, parse, addDays, today, short, long, monthName, MON } };
})();
