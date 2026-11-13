"use strict";
// POA graph card (Build Package M3-PK003, task R4; REQ-RPT-001, REQ-RPT-005 and REQ-RPT-007; technical decision M3-TD024).
// The POA connector's show_graph action names this page as its MCP App (ui://poa/graph-card). Claude shows it in a
// sandboxed frame inside the conversation and passes it the action's result over postMessage (MCP Apps protocol
// 2026-01-26). The page draws the result with the same views as the private website, with a Graph / Text switch.
// It calls nothing, stores nothing, and loads only page code: the numbers arrive only in the message from Claude.
(() => {
  const PROTOCOL = "2026-01-26";
  const $ = (id) => document.getElementById(id);
  const { h, seg } = Views;
  const root = document.documentElement;

  // ---------------------------------------------------------------- talking to Claude (JSON-RPC over postMessage)
  let nextId = 1;
  const pending = new Map();
  const post = (msg) => window.parent.postMessage(msg, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ jsonrpc: "2.0", id, method, params });
  });
  const notify = (method, params) => post({ jsonrpc: "2.0", method, params: params || {} });
  const answer = (id, result) => post({ jsonrpc: "2.0", id, result });

  const state = { report: null, result: null, view: "graph", error: null };
  let ctx = {};

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined) { // a reply to one of our requests
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "Request failed")); else p.resolve(m.result);
      return;
    }
    switch (m.method) {
      case "ui/notifications/tool-input": onInput(m.params || {}); break;
      case "ui/notifications/tool-result": onResult(m.params || {}); break;
      case "ui/notifications/tool-cancelled": state.error = "The graph was cancelled."; render(); break;
      case "ui/notifications/host-context-changed": applyContext(m.params); render(); break;
      case "ui/resource-teardown": answer(m.id, {}); break;
      case "ping": answer(m.id, {}); break;
      default:
        if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
    }
  });

  // ---------------------------------------------------------------- Claude's look (theme, tokens, fonts, safe area)
  // Backgrounds, text and borders take Claude's tokens; the chart colors stay POA's validated palette.
  const MAP = [["--page", "--color-background-primary"], ["--surface", "--color-background-primary"],
    ["--text", "--color-text-primary"], ["--text-2", "--color-text-secondary"], ["--muted", "--color-text-tertiary"],
    ["--grid", "--color-border-tertiary"], ["--axis", "--color-border-secondary"]];
  function applyContext(c) {
    if (!c) return;
    ctx = { ...ctx, ...c };
    if (c.theme === "light" || c.theme === "dark") { root.setAttribute("data-theme", c.theme); root.style.colorScheme = c.theme; }
    const vars = c.styles && c.styles.variables;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) if (k.startsWith("--") && typeof v === "string" && v) root.style.setProperty(k, v);
      for (const [ours, theirs] of MAP) if (vars[theirs]) root.style.setProperty(ours, "var(" + theirs + ")");
      if (vars["--font-sans"]) root.style.setProperty("--card-font", "var(--font-sans)");
    }
    const fonts = c.styles && c.styles.css && c.styles.css.fonts;
    if (fonts && !$("host-fonts")) document.head.append(h("style", { id: "host-fonts" }, fonts));
    const s = c.safeAreaInsets;
    if (s) for (const side of ["top", "right", "bottom", "left"]) root.style.setProperty("--inset-" + side, (Number(s[side]) || 0) + "px");
  }

  // ---------------------------------------------------------------- the action's input and result
  function onInput(params) {
    const a = params.arguments || {};
    if (a.report && !state.report) state.report = a.report;
    if (a.view === "text" || a.view === "graph") state.view = a.view;
    render();
  }

  function onResult(params) {
    let out = params.structuredContent;
    if (!out) {
      const text = params.content && params.content[0] && params.content[0].text;
      try { out = JSON.parse(text || ""); } catch { out = null; }
    }
    if (!out || params.isError || out.status === "error" || !out.result) {
      state.error = (out && (out.message || (out.result && out.result.message))) || "POA couldn't make that graph. Ask the coach to try again.";
    } else {
      state.error = null;
      state.report = out.report;
      state.result = out.result;
      if (out.view === "text" || out.view === "graph") state.view = out.view;
    }
    render();
  }

  // ---------------------------------------------------------------- drawing
  function skeleton() {
    return h("div", { class: "skeleton", "aria-hidden": "true" }, h("div", { class: "sk-title" }), h("div", { class: "sk-plot" }));
  }

  async function toggleFull() {
    const want = ctx.displayMode === "fullscreen" ? "inline" : "fullscreen";
    try {
      const r = await request("ui/request-display-mode", { mode: want });
      if (r && r.mode) ctx.displayMode = r.mode;
    } catch { /* the host said no: stay as we are */ }
    render();
  }

  function render() {
    const main = $("card");
    main.textContent = "";
    if (state.error) { main.append(h("p", { class: "error" }, state.error)); return; }
    if (!state.result) {
      if (state.report) main.append(h("h1", {}, Views.titles[state.report] || "POA graph"));
      main.append(skeleton());
      return;
    }
    const r = state.result;
    const D = Views.dates;
    const when = r.from ? D.short(r.from) + (r.to && r.to !== r.from ? " to " + D.short(r.to) : "") : "";
    const canFull = (ctx.availableDisplayModes || []).includes("fullscreen");
    const full = ctx.displayMode === "fullscreen";
    main.append(h("div", { class: "card-head" },
      h("div", { class: "card-title" }, h("h1", {}, Views.titles[state.report] || "POA graph"), when ? h("p", { class: "sub" }, when) : null),
      h("div", { class: "card-tools" },
        seg([["graph", "Graph"], ["text", "Text"]], state.view, (v) => { state.view = v; render(); }, "Graph or text"),
        canFull ? h("button", { type: "button", class: "link", onclick: toggleFull }, full ? "Close full screen" : "Full screen") : null)));
    const body = h("div", { class: "card-body" });
    main.append(body);
    const show = Views.show[state.report];
    if (!show) { body.append(Views.notes("POA can't draw this report yet.")); return; }
    // One muscle group or exercise asked for: show its weeks rather than the average of all of them
    const names = state.report === "training_volume" ? Views.setNames(r) : [];
    show(body, r, { view: state.view, pick: names.length === 1 ? names[0] : "" });
  }

  // ---------------------------------------------------------------- telling Claude the card's height
  let lastW = 0, lastH = 0, queued = false;
  function size() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const old = root.style.height;
      root.style.height = "max-content";
      const height = Math.ceil(root.getBoundingClientRect().height);
      root.style.height = old;
      const width = Math.ceil(window.innerWidth);
      if (width !== lastW || height !== lastH) { lastW = width; lastH = height; notify("ui/notifications/size-changed", { width, height }); }
    });
  }

  // ---------------------------------------------------------------- start
  Charts.bindTips();
  render();
  request("ui/initialize", {
    appInfo: { name: "POA graph card", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: PROTOCOL,
  }).then((res) => {
    applyContext((res && res.hostContext) || {});
    notify("ui/notifications/initialized");
    render();
    size();
    const ro = new ResizeObserver(size);
    ro.observe(root);
    ro.observe(document.body);
  }).catch(() => {
    state.error = "This graph needs the Claude app. Ask the coach for the numbers as text.";
    render();
  });
})();
