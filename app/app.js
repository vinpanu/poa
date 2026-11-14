"use strict";
// POA private website (PS-046 revision 5; Build Package M3-PK003, task R5).
// Vince signs in with his own POA account; every number comes from the POA connector's read actions,
// the same report functions the coach uses, so the website and the conversation never disagree (REQ-RPT-001).
// Each report has a Graph / Text switch over the same numbers (REQ-RPT-007). The report views themselves are in
// views.js, shared with the graph card the connector shows in the conversation (task R4). Nothing is stored here
// except view preferences in this browser and, while this tab is open, the sign-in session.
// Sign-in (design-change card POABUILD-48, 2026-11-14): this site's sign-in can only read; the connector decides
// that from the session itself (connector version 13). The session lives in this tab only (session storage), signing
// out ends this session alone, and 30 minutes without use signs out.
// Second sign-in step (POABUILD-49): once Vince has set up an authenticator (the page at #/security), signing in asks
// for its code, and the connector refuses a session without it (connector version 14, migration 029).

const SUPABASE_URL = "https://djkomeqozlulwepehoej.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_AsKogB7gcYgWDzNFwekgUw_FJXobyp0"; // public by design; opens nothing in POA
const CONNECTOR = SUPABASE_URL + "/functions/v1/poa-connector";
const AUTH_KEY = "poa-app-auth";
const IDLE_MINUTES = 30;
const client = supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_KEY,
    storage: window.sessionStorage },
});

// Earlier versions kept the session in local storage, where it outlived the tab: end it on the server, then forget it
async function endOldSession() {
  try {
    if (!localStorage.getItem(AUTH_KEY)) return;
    const old = supabase.createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: AUTH_KEY,
        storage: window.localStorage },
    });
    await old.auth.signOut({ scope: "local" });
  } catch { /* nothing to end */ }
  try { localStorage.removeItem(AUTH_KEY); } catch { /* private window */ }
}

// Signing out ends this session only, never Claude's
async function signOut(message) {
  try { await client.auth.signOut({ scope: "local" }); } catch { /* already gone */ }
  Object.keys(cache).forEach((k) => delete cache[k]);
  showSignIn(message);
}

let lastUse = Date.now();
["pointerdown", "keydown", "scroll", "touchstart"].forEach((t) => window.addEventListener(t, () => { lastUse = Date.now(); }, { passive: true }));
setInterval(async () => {
  if (Date.now() - lastUse < IDLE_MINUTES * 60000) return;
  const { data } = await client.auth.getSession();
  if (data && data.session) signOut(`Signed out after ${IDLE_MINUTES} minutes without use.`);
}, 60000);
const $ = (id) => document.getElementById(id);
const { h, seg, field, notes } = Views;
const { addDays, today } = Views.dates;

// ------------------------------------------------------------------ preferences (this browser only)

function pref(key, fallback) {
  try { const v = localStorage.getItem("poa-app-" + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function setPref(key, value) {
  try { localStorage.setItem("poa-app-" + key, JSON.stringify(value)); } catch { /* private window: keep defaults */ }
}

// ------------------------------------------------------------------ dates

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
    await signOut("Your sign-in ended. Please sign in again.");
    throw new Error("Please sign in again.");
  }
  if (res.status === 403) throw new Error("This account isn't allowed to use POA.");
  if (!res.ok) throw new Error("POA didn't answer (" + res.status + "). Try again in a moment.");
  const msg = await res.json();
  if (msg.error) throw new Error(msg.error.message);
  const text = (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) || "";
  if (msg.result && msg.result.isError && /second sign-in step/.test(text)) {
    showCode("This sign-in needs the code from your authenticator app.");
    throw new Error("Type the code from your authenticator app to go on.");
  }
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

// ------------------------------------------------------------------ controls

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

function say(text, bad) { $("message").textContent = text || ""; $("message").className = bad ? "error" : "muted"; }

const view = () => ({ view: pref("view", "graph") });

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
  Views.show.nutrition_report(body, r, { ...view(), grain });
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
  Views.show.nutrient_sources(body, r, view());
}

async function progressPage(body, rerender) {
  const list = await exercises();
  if (!list.length) { body.append(notes("No exercises logged yet.")); return; }
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), exerciseSelect(list, "exercise", rerender), viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("exercise_progress", { exercise_id: pref("exercise", list[0].exercise_id), from, to });
  Views.show.exercise_progress(body, r, { ...view(), from, to });
}

async function recordsPage(body, rerender) {
  const list = await exercises();
  if (!list.length) { body.append(notes("No exercises logged yet.")); return; }
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), exerciseSelect(list, "exercise", rerender), viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("personal_records", { exercise_id: pref("exercise", list[0].exercise_id), from, to });
  Views.show.personal_records(body, r, view());
}

async function setsPage(body, rerender) {
  const by = pref("setsBy", "muscle_group");
  const pick = pref("setsPick", "");
  const { from, to } = period();
  const r = await call("training_volume", { by, from, to });
  const names = Views.setNames(r);
  const chosen = names.includes(pick) ? pick : "";
  body.append(h("div", { class: "controls" }, ...periodControls(rerender),
    field("By", seg([["muscle_group", "Muscle group"], ["exercise", "Exercise"]], by, (v) => { setPref("setsBy", v); setPref("setsPick", ""); rerender(); }, "By muscle group or exercise")),
    field(by === "muscle_group" ? "Muscle group" : "Exercise", h("select", { onchange: (e) => { setPref("setsPick", e.target.value); rerender(); } },
      h("option", { value: "", selected: !chosen }, "All"), names.map((n) => h("option", { value: n, selected: n === chosen }, n)))),
    viewSwitch(rerender)));
  Views.show.training_volume(body, r, { ...view(), by, pick: chosen, from, to });
}

async function workoutsPage(body, rerender) {
  body.append(h("div", { class: "controls" }, ...periodControls(rerender), viewSwitch(rerender)));
  const { from, to } = period();
  const r = await call("workout_frequency", { from, to });
  Views.show.workout_frequency(body, r, view());
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
  Views.show.nutrition_vs_performance(body, r, view());
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
  Views.stopDraw();
  const secured = h("p", { class: "muted" });
  body.append(h("h1", {}, "Your POA"),
    h("p", { class: "muted" }, "Your reports, from the same records your coach uses. Your plan, today's log and cardio join this site as each part of POA is built."),
    h("div", { class: "tiles" }, PAGES.map((p) => h("a", { class: "tile", href: "#/" + p.path }, h("strong", {}, p.title), h("span", {}, p.blurb)))),
    secured);
  secondStepOn().then((on) => {
    if (on === null) return;
    secured.append(on ? "Second sign-in step: on. " : "Second sign-in step: not set up yet. ",
      h("a", { href: "#/security" }, on ? "Details" : "Set it up"));
  });
}

// ------------------------------------------------------------------ second sign-in step (POABUILD-49)
// Supabase adds an authenticator to a POA account only through the app's own steps (enroll, then challenge and
// verify), so this page is where Vince sets his up. Agents never see the key, the QR code or a code. Once one is
// verified, every sign-in needs a code (the connector refuses a session without it, migration 029).

async function secondStepOn() {
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    return error ? null : (data.totp || []).length > 0;
  } catch { return null; }
}

async function needsCode() {
  try {
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    return !error && data && data.nextLevel === "aal2" && data.currentLevel !== "aal2";
  } catch { return false; }
}

async function enter() {
  if (await needsCode()) showCode(); else showSite();
}

function showCode(text) {
  $("signin").hidden = true;
  $("code").hidden = false;
  $("page").textContent = "";
  $("nav").hidden = true;
  $("signout").hidden = false;
  say(text || "", Boolean(text));
  $("code-input").value = "";
  $("code-input").focus();
}

async function securityPage(body) {
  const { data, error } = await client.auth.mfa.listFactors();
  if (error) throw new Error("Couldn't check your sign-in steps: " + error.message);
  if ((data.totp || []).length) {
    body.append(h("p", {}, "On. POA asks for the 6-digit code from your authenticator app each time you sign in, here and when you connect Claude."));
    return;
  }
  body.append(
    h("p", {}, "Today one password opens POA. With this step, signing in also needs a 6-digit code from an authenticator app on your phone, such as Google Authenticator or Microsoft Authenticator. It takes about 5 minutes; at your computer is easiest."),
    h("p", { class: "muted" }, "Nobody else sees the key or the codes, agents included."));
  const start = h("button", { class: "primary", type: "button" }, "Start");
  body.append(start);
  start.addEventListener("click", async () => {
    start.disabled = true;
    say("Preparing...");
    // An unfinished set-up from an earlier try can't be used: clear it before starting again
    for (const f of (data.all || []).filter((x) => x.factor_type === "totp" && x.status !== "verified")) {
      await client.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data: en, error: e2 } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "POA authenticator", issuer: "POA" });
    if (e2 || !en) { start.disabled = false; return say("Couldn't start: " + ((e2 && e2.message) || "no answer") + ". Try again.", true); }
    say("");
    start.remove();
    const code = h("input", { id: "setup-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}", required: true });
    const form = h("form", {}, h("label", { for: "setup-code" }, "3. Type the 6-digit code your app now shows for POA"), code,
      h("button", { class: "primary", type: "submit" }, "Turn it on"));
    body.append(
      h("ol", { class: "steps" },
        h("li", {}, "Open your authenticator app and choose to add an account."),
        h("li", {}, "At your computer, scan this square with your phone. On your phone instead, tap ",
          h("a", { href: en.totp.uri }, "add to my authenticator app"), ", or type this key into the app: ", h("code", { class: "key" }, en.totp.secret))),
      h("img", { class: "qr", src: en.totp.qr_code, alt: "Square code for your authenticator app", width: "200", height: "200" }),
      form);
    code.focus();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      say("Checking...");
      const { error: e3 } = await client.auth.mfa.challengeAndVerify({ factorId: en.id, code: code.value.trim() });
      if (e3) return say("That code didn't work (" + e3.message + "). Type the next code your app shows.", true);
      body.textContent = "";
      body.append(
        h("p", {}, "It's on. From now on POA asks for a code from your authenticator app each time you sign in."),
        h("p", {}, "One more step, in the Claude app: open Customize, then Connectors, then POA; disconnect it and connect it again, and sign in with your password and a code. Until you do, your coach can't read or save."));
      say("");
    });
  });
}
const SECURITY = { path: "security", title: "Second sign-in step", render: securityPage };

// ------------------------------------------------------------------ routing and sign-in

let renderToken = 0;
async function route() {
  const path = location.hash.replace(/^#\/?/, "");
  const page = PAGES.find((p) => p.path === path) || (path === SECURITY.path ? SECURITY : null);
  for (const a of $("nav").querySelectorAll("a")) {
    const here = a.getAttribute("href") === "#/" + path;
    a.setAttribute("aria-current", here ? "page" : "false");
    if (here) a.scrollIntoView({ block: "nearest", inline: "center" });
  }
  const body = $("page");
  body.textContent = "";
  say("");
  if (!page) return homePage(body);
  Views.stopDraw();
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
  $("code").hidden = true;
  $("signin").hidden = false;
  $("page").textContent = "";
  $("nav").hidden = true;
  $("signout").hidden = true;
  say(text || "", Boolean(text));
}

function showSite() {
  $("code").hidden = true;
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
  await enter();
});
$("code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  say("Checking...");
  try {
    const { data, error } = await client.auth.mfa.listFactors();
    const factor = !error && data && (data.totp || [])[0];
    if (!factor) return say("No authenticator is set up on this account.", true);
    const { error: e2 } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: $("code-input").value.trim() });
    if (e2) return say("That code didn't work (" + e2.message + "). Type the next code your app shows.", true);
    showSite();
  } finally {
    button.disabled = false;
  }
});
$("signout").addEventListener("click", () => signOut("Signed out."));
window.addEventListener("hashchange", () => { if ($("signin").hidden) route(); });

buildNav();
Charts.bindTips();
endOldSession().then(() => client.auth.getSession())
  .then(({ data }) => (data && data.session ? enter() : showSignIn()));
