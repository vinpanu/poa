"use strict";
// POA private website: the home page (Today, then This week), the day view History shares, the food detail and the
// nutrition summary in Reports (Build Package M3-PK004, tasks P3 and P4; Jira REQ-WEB-001, 002, 005 to 010, 012 to 015).
// Page code only: every number comes from the POA connector's read actions (day, week, food_entry, nutrition_report,
// nutrient_sources, period) after Vince signs in, the same records the coach reads, so the two never disagree.
// View only (REQ-WEB-010): nothing here adds, changes or deletes an entry; a wrong entry is fixed by telling the coach.
// Styles are set through element.style, never a style attribute, so the page's content-security policy holds.
const Pages = (() => {
  const { h } = Views;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOWL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const parse = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const dayShort = (s) => { const d = parse(s); return DOW[d.getDay()] + " " + MON[d.getMonth()] + " " + d.getDate(); };
  const dayLong = (s) => { const d = parse(s); return DOWL[d.getDay()] + ", " + MON[d.getMonth()] + " " + d.getDate(); };
  const dow = (s) => DOW[parse(s).getDay()];

  // ---------------------------------------------------------------- numbers and units
  const kcal = (v) => (v === null || v === undefined ? "–" : Math.round(v).toLocaleString("en-US"));
  const grams = (v) => {
    if (v === null || v === undefined) return "–";
    const a = Math.abs(v);
    return (a >= 10 || a === 0 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString("en-US");
  };
  const UNIT = { MG: "mg", UG: "µg", G: "g", KCAL: "kcal", KJ: "kJ", IU: "IU", "MG_ATE": "mg" };
  const unit = (u) => UNIT[String(u || "").toUpperCase()] || u || "";
  function amount(v, u) {
    if (v === null || v === undefined) return h("span", { class: "na" }, "n/a");
    const a = Math.abs(v);
    const s = a >= 100 ? Math.round(v).toLocaleString("en-US") : a >= 10 ? String(Math.round(v)) : a >= 1 ? String(Math.round(v * 10) / 10) : a > 0 ? String(Math.round(v * 100) / 100) : "0";
    return s + " " + unit(u);
  }
  const width = (node, pct) => { node.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + "%"; return node; };

  // ---------------------------------------------------------------- shared parts
  function card(title, right, ...kids) {
    return h("section", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, title), right ? h("span", { class: "right" }, right) : null), ...kids);
  }
  const pill = (cls, text) => h("span", { class: "pill " + cls }, text);
  function row(summaryKids, innerKids, open) {
    return h("details", { class: "row", open: open || null }, h("summary", {}, ...summaryKids), h("div", { class: "inner" }, ...innerKids));
  }

  // The split of calories between protein, carbohydrate and fat, as one bar (REQ-WEB-015): shares of calories at
  // 4 kcal a gram for protein and carbohydrate and 9 for fat, with each macro's grams and share beside it. Never a pie.
  function macroBar(p, c, f) {
    const g = [p || 0, c || 0, f || 0];
    const k = [g[0] * 4, g[1] * 4, g[2] * 9];
    const tot = k[0] + k[1] + k[2];
    if (!tot) return null;
    const sh = k.map((x) => (x / tot) * 100);
    const names = ["Protein", "Carbs", "Fat"];
    return h("div", { class: "macro" },
      h("div", { class: "stack", role: "img", "aria-label": "Share of calories: " + names.map((n, i) => n + " " + Math.round(sh[i]) + "%").join(", ") },
        sh.map((v, i) => width(h("i", { class: "m" + i }), v))),
      h("div", { class: "legend" }, names.map((n, i) => h("span", {}, h("i", { class: "swatch m" + i }), n + " ", h("b", {}, grams(g[i]) + " g"),
        h("span", { class: "muted" }, " · " + Math.round(sh[i]) + "%")))));
  }

  // Vince's nutrient list, grouped as he reads it; each by its amount, never a % of daily value (REQ-WEB-014)
  const VITAMINS = ["vitamin a", "vitamin c", "vitamin d", "vitamin e", "vitamin k", "thiamin", "riboflavin", "niacin", "vitamin b6",
    "folate", "vitamin b12", "pantothenic acid", "biotin"];
  const MINERALS = ["sodium", "calcium", "iron", "potassium", "phosphorus", "magnesium", "zinc", "selenium", "copper", "manganese",
    "chromium", "iodine"];
  const groupOf = (n) => (VITAMINS.includes(n.toLowerCase()) ? "Vitamins" : MINERALS.includes(n.toLowerCase()) ? "Minerals" : "Other");
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  function nutrientTable(list, head, opts = {}) {
    let atLeast = false;
    const body = h("tbody", {});
    for (const g of ["Vitamins", "Minerals", "Other"]) {
      const items = (list || []).filter((n) => groupOf(n.nutrient) === g);
      if (!items.length) continue;
      body.append(h("tr", { class: "grp" }, h("th", { colspan: "2" }, g)));
      for (const n of items) {
        const al = opts.atLeast !== false && n.at_least && n.amount !== null;
        if (al) atLeast = true;
        body.append(h("tr", {}, h("td", {}, cap(n.nutrient)), h("td", { class: "num" }, al ? "≥ " : "", amount(n.amount, n.unit))));
      }
    }
    return h("div", {},
      h("div", { class: "table-wrap" }, h("table", { class: "nut" }, h("thead", {}, h("tr", {}, h("th", {}, "Nutrient"), h("th", { class: "num" }, head))), body)),
      atLeast ? h("p", { class: "tiny muted" }, "≥ at least: some foods had no value for this nutrient, so the real amount is likely higher.") : null,
      h("p", { class: "tiny muted" }, "n/a: the food data has no value for it, so it isn't counted as zero."));
  }

  // ---------------------------------------------------------------- one day (Today, and any day in History)

  const timeText = (m) => m.time_said || (m.activity_time ? to12(m.activity_time) : "time not given");
  function to12(hhmm) {
    const [H, M] = hhmm.split(":").map(Number);
    return ((H % 12) || 12) + ":" + String(M).padStart(2, "0") + " " + (H >= 12 ? "pm" : "am");
  }
  const mealKcal = (m) => (m.entries || []).reduce((s, e) => s + (e.calories || 0), 0);
  const mealMacro = (m, k) => (m.entries || []).reduce((s, e) => s + (e[k] || 0), 0);
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");

  function entryNote(e) {
    if (e.state === "pending") return "calories pending";
    if (e.state === "unavailable") return "no values";
    if (e.state === "estimate") return "your estimate";
    if (e.amount_basis === "approximate") return "about";
    return null;
  }

  function summaryCard(d, live) {
    const t = d.totals;
    const gaps = (d.not_fully_logged || []).map((g) => g.area);
    const status = !t ? pill("p-nd", "Nothing logged")
      : gaps.includes("food") ? pill("p-todo", "Not fully logged")
      : live ? pill("p-info", "So far") : pill("p-ok", "Logged");
    const title = live ? "Today" : dayLong(d.date);
    if (!t) return card(title, status, h("p", { class: "muted" }, live ? "Nothing logged yet today." : "Nothing logged this day."));
    return card(title, status,
      live ? h("p", { class: "muted small" }, dayLong(d.date)) : null,
      h("div", { class: "kcal-row" }, h("span", { class: "big" }, (t.at_least ? "≥ " : "") + kcal(t.calories)), h("span", { class: "unit" }, "kcal" + (live ? " so far" : ""))),
      macroBar(t.protein_g, t.carbohydrate_g, t.fat_g),
      t.at_least ? h("p", { class: "tiny muted" }, "At least: some foods are pending or have no value.") : null);
  }

  function mealsCard(d, openFood) {
    const meals = d.meals || [];
    if (!meals.length) return null;
    const list = h("div", { class: "list" }, meals.map((m) => {
      const n = m.meal_number;
      const foods = (m.entries || []).map((e) => {
        const note = entryNote(e);
        return h("button", { type: "button", class: "food", onclick: () => openFood(e.entry_id) },
          h("span", { class: "f-n" }, h("span", {}, cap(e.says || e.food_said)), e.matched_food ? h("span", { class: "f-s" }, e.matched_food) : null,
            h("span", { class: "f-s" }, "P " + grams(e.protein_g) + " g · C " + grams(e.carbohydrate_g) + " g · F " + grams(e.fat_g) + " g" + (note ? " · " + note : ""))),
          h("span", { class: "f-k" }, e.calories === null || e.calories === undefined ? "–" : kcal(e.calories)),
          h("span", { class: "chev", "aria-hidden": "true" }, "›"));
      });
      return row([
        h("span", { class: "s-main" }, h("span", { class: "s-title" }, "Meal " + n), h("span", { class: "s-sub" }, timeText(m) + " · " + plural((m.entries || []).length, "food"))),
        h("span", { class: "s-right" }, kcal(mealKcal(m)), h("span", { class: "tiny muted" }, " kcal")),
      ], [
        h("p", { class: "s-sub" }, "Protein " + grams(mealMacro(m, "protein_g")) + " g · Carbs " + grams(mealMacro(m, "carbohydrate_g")) + " g · Fat " + grams(mealMacro(m, "fat_g")) + " g"),
        h("div", { class: "foods" }, foods),
      ]);
    }));
    return card("Meals", h("span", { class: "muted small" }, "Numbered in the order eaten"), list,
      h("p", { class: "tiny muted" }, "Tap a meal to see its foods, and a food to see every nutrient."));
  }

  // A set's says text is the coach's read-back ("185 lb, bar included, 8 reps, 2 in reserve", and "(assumed, your
  // default)" when the reps in reserve were assumed), or since migration 066 the website's words ("185 lb, bar
  // included × 8 · 2 RIR"); add only what it lacks (CR1-D010, POABUILD-67)
  const rirText = (s) => (s.rir === null || s.rir === undefined || /in reserve|RIR/.test(s.says || "") ? ""
    : " · " + s.rir + " in reserve") + (s.rir_basis === "assumed" && !/assumed/i.test(s.says || "") ? " (assumed)" : "");
  function setLine(s, i) {
    // Since migration 066 each set carries its display: the weight's meaning, reps, reps in reserve and marks (REQ-WEB-018)
    if (s.display) return Views.setItem(s, "Set " + i);
    const kind = s.set_kind === "warm_up" ? "Warm-up" : "Set " + i;
    const tech = s.technique === "rest_pause" && !/rest/i.test(s.says || "") ? " · rest-pause" : "";
    return h("li", {}, h("span", { class: "muted" }, kind + ": "), (s.says || "") + rirText(s) + tech + (s.with_partials && !/partial/i.test(s.says || "") ? " · with partials" : ""));
  }

  // A day marked sick says so where the workout would be (REQ-WEB-002, REQ-LOG-011; CR1-D016)
  function sickLine(d) {
    return d.sick ? h("p", { class: "small" }, h("i", { class: "sm" }), " Marked sick" + (d.sick.reported_later ? ", reported later" : "")) : null;
  }

  function workoutCard(d) {
    const gaps = (d.not_fully_logged || []).map((g) => g.area);
    const ws = d.workouts || [];
    if (!ws.length) {
      return card("Workout", null, sickLine(d) || h("p", { class: "muted small" }, gaps.includes("training") ? "You said a workout this day wasn't logged." : "No workout logged."));
    }
    return card("Workout", null, sickLine(d), ws.map((w) => {
      // A time logged away from home carries its zone's name, such as "6:00 pm Pacific" (REQ-LOG-010)
      const at = w.started ? to12(w.started) : w.activity_time ? to12(w.activity_time) : null;
      const head = [w.label, at ? at + (w.zone_name ? " " + w.zone_name : "") : null,
        w.length_min ? w.length_min + " min" : null, plural(w.working_sets, "working set")].filter(Boolean).join(" · ");
      // Only a timed workout can be open, waiting for "end workout" or the coach's closing question (REQ-WKT-006, 008);
      // one logged afterwards has no clock, so it is marked as reported later instead (REQ-LOG-006; CR1-D012, POABUILD-69)
      const state = w.timed && !w.finished ? " · still open" : !w.timed && w.reported_later ? " · reported later" : "";
      return h("div", { class: "workout" }, h("p", { class: "small muted" }, head + state),
        h("div", { class: "list" }, (w.exercises || []).map((x) => {
          let n = 0;
          const working = (x.sets || []).filter((s) => s.set_kind !== "warm_up").reduce((a, s) => a + (s.counts_as || 0), 0);
          // Before it is opened, the row shows each set short, keeping the warm-up mark (REQ-WEB-018); a swap says what
          // it replaced; below the sets, a link opens the exercise's own page (REQ-WEB-017)
          return row([
            h("span", { class: "s-main" }, h("span", { class: "s-title" }, cap(x.exercise)),
              x.replaces ? h("span", { class: "s-sub" }, h("span", { class: "tag" }, "instead of " + x.replaces)) : null,
              x.short ? h("span", { class: "s-sub short" }, x.short) : null,
              x.setup ? h("span", { class: "s-sub" }, x.setup) : null),
            h("span", { class: "s-right" }, plural(working, "set")),
          ], [h("ol", { class: "sets" }, (x.sets || []).map((s) => setLine(s, s.set_kind === "warm_up" ? 0 : ++n))),
            x.page_exercise_id ? h("a", { class: "ex-link", href: Views.exHref(x.page_exercise_id) }, cap(x.exercise) + ": progress, records and every workout ›") : null]);
        })));
    }));
  }

  // The day's weigh-ins as saved (REQ-BW-006): the day's weight with its time, then the later readings, each with its
  // time and note; "No weigh-in" for a day without one, never zero; no change and no comment. (The day's sick mark is
  // in the Workout card.) A database without body weight yet sends no weigh-ins, and the card stays out.
  function weightCard(d) {
    if (!("weigh_ins" in d)) return null;
    const list = d.weigh_ins || [];
    if (!list.length) return card("Weight", null, h("p", { class: "muted small" }, d.weigh_in_says || "No weigh-in"));
    return card("Weight", list.length > 1 ? h("span", { class: "muted small" }, "The first weigh-in is the day's weight") : null,
      h("ul", { class: "plain weigh-ins" }, list.map((x) => h("li", {},
        h("b", {}, Views.reading(x)), h("span", { class: "muted" }, " · " + Views.readingTime(x)),
        x.note ? h("div", { class: "small muted" }, x.note) : null))));
  }

  // REQ-WEB-002 (Today) and REQ-WEB-007 (any past day, shown as Today showed it)
  function dayView(body, d, opts) {
    body.append(...[summaryCard(d, opts.live), weightCard(d), mealsCard(d, opts.openFood), workoutCard(d)].filter(Boolean));
    if ((d.meals || []).length) {
      body.append(h("p", { class: "hint" }, "Something wrong? Tell the coach, for example “the rice in meal 2 was 100 grams”. It fixes the entry and reads it back; refresh to see it here. Editing on this site comes in version 2."));
    }
  }

  // ---------------------------------------------------------------- the food detail (REQ-WEB-002 ex4, REQ-WEB-014)

  let sheetBack = null;
  function closeSheet() {
    const el = document.getElementById("sheet");
    if (!el) return;
    el.hidden = true;
    document.getElementById("sheetbg").hidden = true;
    el.textContent = "";
    document.removeEventListener("keydown", escClose);
    if (sheetBack) { try { sheetBack.focus(); } catch { /* gone */ } }
  }
  const escClose = (e) => { if (e.key === "Escape") closeSheet(); };
  async function foodSheet(entryId, call) {
    const el = document.getElementById("sheet");
    const bg = document.getElementById("sheetbg");
    sheetBack = document.activeElement;
    el.textContent = "";
    const close = h("button", { type: "button", class: "btn", onclick: closeSheet }, "Close");
    const inner = h("div", { class: "sheet-in" }, h("div", { class: "sheet-h" }, h("h2", { id: "sheet-h" }, "Loading..."), close));
    el.append(inner);
    el.hidden = false;
    bg.hidden = false;
    close.focus();
    document.addEventListener("keydown", escClose);
    let x;
    try {
      x = await call("food_entry", { entry_id: entryId });
    } catch (err) {
      inner.querySelector("h2").textContent = "Couldn't load this food";
      inner.append(h("p", { class: "error" }, err.message || String(err)));
      return;
    }
    inner.querySelector("h2").textContent = cap(x.matched_food || x.food_said);
    const src = x.source === "usda" ? "Values from USDA FoodData Central." : x.source === "his_values" ? "Values from your own entry (a label or MyNetDiary)."
      : x.source === "estimate" ? "Your own estimate: calories and macros only." : "";
    const raw = x.preparation === "cooked" ? "cooked weight" : "raw weight";
    // append() writes a null as the word "null", so the parts a food may lack (a note, macros) are left out (CR1-D011, POABUILD-68)
    inner.append(...[
      h("p", { class: "s-sub" }, "Meal " + x.meal_number + " · " + (x.time_said || "time not given") + " · " + dayShort(x.activity_date)),
      h("div", { class: "kcal-row" }, h("span", { class: "big" }, x.calories === null ? "–" : kcal(x.calories)), h("span", { class: "unit" }, "kcal"),
        h("span", { class: "muted small" }, cap(x.says || "") + (x.grams ? " (" + grams(x.grams) + " g, " + raw + ")" : ""))),
      h("p", { class: "tiny muted" }, src + " A value the food data doesn't have shows as n/a, never zero."),
      macroBar(x.protein_g, x.carbohydrate_g, x.fat_g),
      x.note ? h("p", { class: "small muted" }, x.note.replace(/^Vince's own/, "Your own")) : null,
      nutrientTable(x.nutrients, "Amount", { atLeast: false })].filter((n) => n !== null && n !== undefined));
    const others = x.other_nutrients || [];
    if (others.length) {
      inner.append(h("details", { class: "more" }, h("summary", {}, "Everything else in the food data (" + others.length + ")"),
        h("div", { class: "table-wrap" }, h("table", { class: "nut" }, h("tbody", {}, others.map((n) =>
          h("tr", {}, h("td", {}, n.nutrient), h("td", { class: "num" }, amount(n.amount, n.unit)))))))));
    }
    inner.append(h("p", { class: "hint" }, "View only. To fix this entry, tell the coach."));
  }

  // ---------------------------------------------------------------- This week (REQ-WEB-005, REQ-WEB-006)

  const FOOD_MARK = { logged: ["Food logged", "ok"], not_fully_logged: ["Not fully logged", "part"], nothing_logged: ["Nothing logged", "none"] };
  function vsLast(a, b, fmtFn) {
    return h("span", { class: "vs" }, h("b", {}, a === null || a === undefined ? "–" : fmtFn(a)),
      h("span", { class: "muted small" }, " · last week " + (b === null || b === undefined ? "–" : fmtFn(b))));
  }
  const span = (side) => (side.food_to ? dow(side.from) + (side.food_to !== side.from ? "–" + dow(side.food_to) : "") : "");

  function weekView(body, w) {
    const tw = w.this_week, lw = w.last_week;
    const strip = h("div", { class: "days" }, (w.days || []).map((d) => {
      const m = d.to_come ? ["To come", "come"] : FOOD_MARK[d.food] || ["", "none"];
      const label = [dow(d.date) + " " + parse(d.date).getDate(), m[0], d.workouts ? "workout logged" : null,
        d.weigh_in ? "weigh-in" : null, d.sick ? "sick" : null].filter(Boolean).join(", ");
      const kids = [h("span", { class: "dd" }, dow(d.date)), h("span", { class: "dn" }, String(parse(d.date).getDate())),
        h("span", { class: "marks" }, h("i", { class: "fm " + m[1] }), d.workouts ? h("i", { class: "wm" }) : null,
          d.weigh_in ? h("i", { class: "bm" }) : null, d.sick ? h("i", { class: "sm" }) : null)];
      return d.to_come ? h("span", { class: "day come", "aria-label": label }, ...kids)
        : h("a", { class: "day" + (d.date === w.today ? " now" : ""), href: "#/day/" + d.date, "aria-label": label + ". Open this day" }, ...kids);
    }));
    const key = h("p", { class: "tiny muted keyline" }, h("i", { class: "fm ok" }), " food logged ", h("i", { class: "fm part" }), " not fully logged ",
      h("i", { class: "wm" }), " workout", w.weight ? [" ", h("i", { class: "bm" }), " weigh-in ", h("i", { class: "sm" }), " sick"] : null, ". Tap a day to open it.");

    // Daily averages over the finished, fully logged days, beside the same days of last week
    const a = tw.averages, b = lw.averages;
    const avgDays = (side, sideDays) => h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Day", "kcal", "Protein", "Carbs", "Fat"].map((t, i) => h("th", { class: i ? "num" : null }, t)))),
      h("tbody", {}, (sideDays || []).map((d) => h("tr", {}, h("td", {}, h("a", { href: "#/day/" + d.date }, dayShort(d.date))),
        h("td", { class: "num" }, (d.at_least ? "≥ " : "") + kcal(d.calories)), h("td", { class: "num" }, grams(d.protein_g) + " g"),
        h("td", { class: "num" }, grams(d.carbohydrate_g) + " g"), h("td", { class: "num" }, grams(d.fat_g) + " g"))))));
    const leftOut = (side) => (side.left_out || []).length ? h("p", { class: "tiny muted" }, "Left out: " + side.left_out.map((x) => dow(x.date) + " (" + (x.status === "not_fully_logged" ? "not fully logged" : "nothing logged") + ")").join(", ") + ".") : null;
    const avgBody = a.days_counted
      ? [h("div", { class: "figs" },
          h("div", { class: "fig" }, h("span", { class: "label" }, "Calories"), vsLast(a.calories, b.calories, kcal)),
          h("div", { class: "fig" }, h("span", { class: "label" }, "Protein"), vsLast(a.protein_g, b.protein_g, (v) => grams(v) + " g")),
          h("div", { class: "fig" }, h("span", { class: "label" }, "Carbs"), vsLast(a.carbohydrate_g, b.carbohydrate_g, (v) => grams(v) + " g")),
          h("div", { class: "fig" }, h("span", { class: "label" }, "Fat"), vsLast(a.fat_g, b.fat_g, (v) => grams(v) + " g")))]
      : [h("p", { class: "muted small" }, tw.food_to ? "No fully logged day yet this week." : "No finished day yet this week: today joins the averages once it's over.")];
    const avgRow = row([
      h("span", { class: "s-main" }, h("span", { class: "s-title" }, "Daily average"),
        h("span", { class: "s-sub" }, a.days_counted ? plural(a.days_counted, "day") + " (" + span(tw) + "), beside last week's same days" : "Finished, fully logged days only")),
      h("span", { class: "s-right" }, a.days_counted ? kcal(a.calories) : "–", h("span", { class: "tiny muted" }, " kcal")),
    ], [...avgBody,
      a.days_counted ? h("p", { class: "small" }, h("b", {}, "This week")) : null, a.days_counted ? avgDays(tw, a.days) : null, leftOut(a),
      b.days_counted ? h("p", { class: "small" }, h("b", {}, "Last week, same days")) : null, b.days_counted ? avgDays(lw, b.days) : null, leftOut(b)]);

    // Average weight over the finished days, beside the same days of last week, opening to the readings behind each
    // (REQ-BW-007): each weighed-in day's first weigh-in; days without one are left out, never zero
    const wt = w.weight;
    const wlines = (side) => h("ul", { class: "plain" }, (side.readings || []).map((x) =>
      h("li", {}, h("a", { href: "#/day/" + x.date }, dayShort(x.date)), " · " + Views.reading(x) + " · " + Views.readingTime(x) + (x.note ? " · " + x.note : ""))));
    const hasAvg = (s) => s && s.average_lb !== null && s.average_lb !== undefined;
    // This week's own state ("No weigh-ins yet", "No finished days yet") is said once, in the row. When this week has no
    // average and last week has one, last week's still shows, in the row and above its readings, with no change
    // (REQ-BW-007 ex4); when only last week has none, the change line says so, once (ex5).
    const twAvg = wt && hasAvg(wt.this_week), lwAvg = wt && hasAvg(wt.last_week);
    const avgLb = (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(1)); // an average, to one decimal: 183.0
    const lwLine = !wt ? null
      : (wt.last_week.readings || []).length
        ? h("p", { class: "small" }, h("b", {}, "Last week, same days"), twAvg ? null : ": " + wt.last_week.says)
        : twAvg || !wt.last_week.to ? null
        : h("p", { class: "muted small" }, "Last week, same days: no weigh-ins");
    const weightRow = wt ? row([
      h("span", { class: "s-main" }, h("span", { class: "s-title" }, "Average weight"),
        h("span", { class: "s-sub" }, twAvg ? plural(wt.this_week.days, "day") + ", beside last week's same days"
          : wt.this_week.says + (lwAvg ? " · last week " + avgLb(wt.last_week.average_lb) + " lb" : ""))),
      h("span", { class: "s-right" }, twAvg ? avgLb(wt.this_week.average_lb) : "–", h("span", { class: "tiny muted" }, " lb")),
    ], [
      twAvg ? h("div", { class: "figs" }, h("div", { class: "fig" }, h("span", { class: "label" }, "Weight"),
        vsLast(wt.this_week.average_lb, wt.last_week.average_lb, (v) => avgLb(v) + " lb"))) : null,
      twAvg && wt.change_says ? h("p", { class: "small" }, wt.change_says) : null,
      (wt.this_week.readings || []).length ? h("p", { class: "small" }, h("b", {}, "This week")) : null, wlines(wt.this_week),
      lwLine, wlines(wt.last_week),
      h("p", { class: "tiny muted" }, "Each day's first weigh-in counts; today joins once it's over."),
    ]) : null;

    // Workouts
    const wlist = (side) => h("ul", { class: "plain" }, (side.workouts.list || []).map((x) =>
      h("li", {}, h("a", { href: "#/day/" + x.date }, dayShort(x.date)), " · " + [x.label, x.length_min ? x.length_min + " min" : "not timed", plural(x.working_sets, "working set")].filter(Boolean).join(" · "))));
    const woRow = row([
      h("span", { class: "s-main" }, h("span", { class: "s-title" }, "Workouts"), h("span", { class: "s-sub" }, "Last week, same days: " + lw.workouts.count)),
      h("span", { class: "s-right" }, String(tw.workouts.count)),
    ], [tw.workouts.count ? wlist(tw) : h("p", { class: "muted small" }, "None yet this week."),
      lw.workouts.count ? h("p", { class: "small" }, h("b", {}, "Last week, same days")) : null, lw.workouts.count ? wlist(lw) : null]);

    // Working sets by muscle group, each opening to every set that makes up its count
    // the exercise's name opens its page (REQ-WEB-017)
    const setList = (sets) => h("ol", { class: "sets numbered" }, (sets || []).map((s) => h("li", {},
      h("a", { href: "#/day/" + s.date }, dow(s.date)), " · ",
      s.exercise_id ? h("a", { href: Views.exHref(s.exercise_id) }, cap(s.exercise)) : cap(s.exercise), " · " + s.says
        + (s.drop_part ? " (drop " + s.drop_part + ")" : "")
        + rirText(s))));
    const groups = new Map();
    for (const g of tw.working_sets.by_muscle_group || []) groups.set(g.muscle_group, { now: g, last: null });
    for (const g of lw.working_sets.by_muscle_group || []) groups.set(g.muscle_group, { ...(groups.get(g.muscle_group) || { now: null }), last: g });
    const mgRows = [...groups.entries()].map(([name, x]) => row([
      h("span", { class: "s-main" }, h("span", { class: "s-title" }, cap(name)), h("span", { class: "s-sub" }, "Last week, same days: " + (x.last ? x.last.working_sets : 0))),
      h("span", { class: "s-right" }, String(x.now ? x.now.working_sets : 0)),
    ], [x.now ? setList(x.now.sets) : h("p", { class: "muted small" }, "None this week yet."),
      x.last ? h("details", { class: "more" }, h("summary", {}, "Last week's " + x.last.working_sets), setList(x.last.sets)) : null]));
    const un = tw.working_sets.untagged;
    if (un) {
      mgRows.push(row([h("span", { class: "s-main" }, h("span", { class: "s-title" }, "Not tagged yet"), h("span", { class: "s-sub" }, "Exercises whose muscle groups you haven't confirmed; tell the coach")),
        h("span", { class: "s-right" }, String(un.working_sets))], [setList(un.sets)]));
    }
    const setsCard = h("div", { class: "list" }, mgRows.length ? mgRows : [h("p", { class: "muted small" }, "No working sets yet this week.")]);

    body.append(card("This week", h("span", { class: "muted small" }, dayShort(w.week_start) + " – " + dayShort(w.week_end)),
      strip, key, h("div", { class: "list" }, avgRow, weightRow, woRow)),
    card("Working sets by muscle group", h("span", { class: "muted small" }, "This week · last week's same days"), setsCard,
      h("p", { class: "tiny muted" }, "Today's sets count. Warm-ups don't; each weight in a drop set counts as a set; a set counts once for each muscle group it trains.")));
  }

  // ---------------------------------------------------------------- the nutrition summary in Reports (task P4)

  async function nutritionSummary(body, p, call, view) {
    const grain = p.len <= 31 ? "day" : p.len <= 186 ? "week" : "month";
    const [nr, src, per] = await Promise.all([
      call("nutrition_report", { from: p.from, to: p.to, grain, nutrients: ["calories", "protein", "carbohydrate", "fat"] }),
      call("nutrient_sources", { nutrient: "calories", from: p.from, to: p.to, top: 8 }),
      call("period", { from: p.from, to: p.to }),
    ]);
    const sum = nr.summary || {};
    const avg = sum.average_per_full_day || {};
    const one = p.len === 1;
    if (!(nr.series || []).length || !sum.full_days && !one) {
      body.append(card("Nutrition", null, h("p", { class: "muted" }, nr.note || "No fully logged days in this period.")));
      if (!(nr.series || []).length) return;
    }
    const dayVals = one && nr.series[0] ? nr.series[0] : null;
    const kc = one ? dayVals && dayVals.values && dayVals.values.calories : avg.calories;
    const macroSrc = one ? (dayVals && dayVals.values) || {} : avg;
    const calCard = card("Calories", null,
      h("div", { class: "kcal-row" }, h("span", { class: "big" }, kc === null || kc === undefined ? "–" : kcal(kc)), h("span", { class: "unit" }, one ? "kcal" : "kcal a day")),
      one ? (dayVals && dayVals.status !== "logged" ? h("p", { class: "small muted" }, dayVals.status === "not_fully_logged" ? "Not fully logged, so longer periods leave this day out of their averages." : "Nothing logged this day.") : null)
        : h("p", { class: "small muted" }, "Average of " + plural(sum.full_days || 0, "fully logged day") + " out of " + (sum.days || p.len) + "."));
    body.append(calCard);
    if (!one) {
      const box = h("div", {});
      calCard.append(box);
      Views.show.nutrition_report(box, { ...nr, nutrients: (nr.nutrients || []).filter((n) => n.key === "calories") }, { view, grain });
    }
    body.append(card("Macros", h("span", { class: "muted small" }, one ? "The day" : "Average a day"), macroBar(macroSrc.protein_g, macroSrc.carbohydrate_g, macroSrc.fat_g) || h("p", { class: "muted small" }, "No values.")));
    const top = (src && src.top_foods) || [];
    if (top.length) {
      body.append(card("Top foods by calories", h("span", { class: "muted small" }, "Share of the period's calories"), h("div", { class: "tf" }, top.map((f) =>
        h("div", { class: "tf-r" }, h("span", {}, cap(f.food) + (f.estimate ? " (estimate)" : "")),
          h("span", { class: "tf-v" }, kcal(f.amount) + " kcal ", h("span", { class: "muted" }, "· " + f.share_pct + "%")),
          h("span", { class: "tf-bar" }, width(h("i", {}), f.share_pct)))))));
    }
    const micro = per && per.micronutrients ? (one ? per.micronutrients.total : per.micronutrients.average_per_logged_day) : null;
    if (micro) body.append(card("Nutrients", h("span", { class: "muted small" }, one ? "Day total" : "Average a day"), nutrientTable(micro, one ? "Total" : "Average")));
  }

  return { dayView, weekView, foodSheet, closeSheet, nutritionSummary, macroBar, dayShort, dayLong, cap };
})();
