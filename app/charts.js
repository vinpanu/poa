"use strict";
// Small SVG charts for POA's private website: columns, a line and horizontal bars.
// Marks follow the dataviz specs: bars at most 24px wide with 4px rounded ends square at the baseline,
// 2px lines, 8px dots with a surface ring, hairline gridlines, one axis per chart, selective labels.
// Missing days are an asterisk at the baseline (never a low value); estimates are hatched or hollow.
// Every mark carries its numbers in a tooltip, and every chart has a text view on the page.
const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent, text) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  function fmt(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "";
    const a = Math.abs(v);
    if (a >= 10000) return (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "K";
    return v.toLocaleString(undefined, { maximumFractionDigits: a < 10 ? 1 : 0 });
  }

  // Round tick steps (1, 2, 2.5, 5 x 10^n) covering lo..hi
  function ticks(lo, hi, count = 4) {
    if (!(hi > lo)) hi = lo + 1;
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const out = [];
    for (let t = start; t <= end + step / 2; t += step) out.push(Math.round(t * 1e6) / 1e6);
    return out;
  }

  function frame(container, height, aria) {
    container.textContent = "";
    const width = Math.max(280, Math.floor(container.clientWidth || 320));
    const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": aria, width, height }, container);
    const defs = el("defs", {}, svg);
    const pat = el("pattern", { id: "hatch", patternUnits: "userSpaceOnUse", width: 5, height: 5, patternTransform: "rotate(45)" }, defs);
    el("rect", { class: "hatch-bg", width: 5, height: 5 }, pat);
    el("line", { class: "hatch-line", x1: 0, y1: 0, x2: 0, y2: 5 }, pat);
    return { svg, width, height };
  }

  function yAxis(svg, tickVals, y, x0, x1) {
    const g = el("g", { class: "grid" }, svg);
    for (const t of tickVals) {
      el("line", { x1: x0, x2: x1, y1: y(t), y2: y(t) }, g);
      el("text", { class: "tick", x: x0 - 6, y: y(t) + 4, "text-anchor": "end" }, svg, fmt(t));
    }
  }

  // Labels along the x axis, every k-th so they don't collide
  function xLabels(svg, points, xc, yBase, slotW) {
    const every = Math.max(1, Math.ceil(46 / Math.max(slotW, 1)));
    points.forEach((p, i) => {
      if (i % every !== 0) return;
      el("text", { class: "tick", x: xc(i), y: yBase + 16, "text-anchor": "middle" }, svg, p.short || p.label);
    });
  }

  function roundedBar(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  }

  // points: [{label, short, value, missing, estimate, tip}]; avg: {value, label} or null
  function columns(container, { points, avg, aria, height = 200 }) {
    const { svg, width } = frame(container, height, aria);
    const pad = { l: 44, r: 10, t: 16, b: 28 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const vals = points.filter((p) => !p.missing && p.value !== null && p.value !== undefined).map((p) => p.value);
    if (avg && avg.value !== null && avg.value !== undefined) vals.push(avg.value);
    const tv = ticks(0, Math.max(1, ...vals));
    const top = tv[tv.length - 1];
    const y = (v) => pad.t + innerH - (v / top) * innerH;
    const yBase = pad.t + innerH;
    yAxis(svg, tv, y, pad.l, width - pad.r);
    const slot = innerW / Math.max(points.length, 1);
    const bw = Math.max(2, Math.min(24, slot * 0.62));
    const xc = (i) => pad.l + slot * i + slot / 2;
    points.forEach((p, i) => {
      const cx = xc(i);
      const hit = el("rect", { class: "hit", x: pad.l + slot * i, y: pad.t, width: slot, height: innerH, "data-tip": p.tip || "" }, svg);
      hit.setAttribute("tabindex", "-1");
      if (p.missing || p.value === null || p.value === undefined) {
        el("text", { class: "miss", x: cx, y: yBase - 3, "text-anchor": "middle" }, svg, "*");
        return;
      }
      const h = Math.max(0, yBase - y(p.value));
      if (h <= 0) return;
      el("path", { class: "bar" + (p.estimate ? " est" : "") + (p.series2 ? " s2" : ""), d: roundedBar(cx - bw / 2, yBase - h, bw, h) }, svg);
    });
    el("line", { x1: pad.l, x2: width - pad.r, y1: yBase, y2: yBase }, el("g", { class: "axis" }, svg));
    if (avg && avg.value !== null && avg.value !== undefined) {
      el("line", { class: "avg", x1: pad.l, x2: width - pad.r, y1: y(avg.value), y2: y(avg.value) }, svg);
      el("text", { class: "lbl", x: width - pad.r, y: y(avg.value) - 4, "text-anchor": "end" }, svg, avg.label);
    }
    xLabels(svg, points, xc, yBase, slot);
  }

  // points: [{label, short, value, estimate, tip}] in order; empty values are skipped (no line through them)
  function line(container, { points, aria, height = 200 }) {
    const { svg, width } = frame(container, height, aria);
    const pad = { l: 44, r: 44, t: 16, b: 28 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const vals = points.filter((p) => p.value !== null && p.value !== undefined).map((p) => p.value);
    if (!vals.length) return;
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const spread = hi - lo || Math.max(1, hi * 0.1);
    lo = Math.max(0, lo - spread * 0.25); hi = hi + spread * 0.25;
    const tv = ticks(lo, hi);
    const y0 = tv[0], y1 = tv[tv.length - 1];
    const y = (v) => pad.t + innerH - ((v - y0) / (y1 - y0)) * innerH;
    const yBase = pad.t + innerH;
    yAxis(svg, tv, y, pad.l, width - pad.r);
    const slot = innerW / Math.max(points.length, 1);
    const xc = (i) => pad.l + slot * i + slot / 2;
    let d = "";
    points.forEach((p, i) => {
      if (p.value === null || p.value === undefined) return;
      d += (d ? " L" : "M") + xc(i) + "," + y(p.value);
    });
    el("path", { class: "line", d }, svg);
    points.forEach((p, i) => {
      el("rect", { class: "hit", x: pad.l + slot * i, y: pad.t, width: slot, height: innerH, "data-tip": p.tip || "" }, svg);
      if (p.value === null || p.value === undefined) {
        if (p.missing) el("text", { class: "miss", x: xc(i), y: yBase - 3, "text-anchor": "middle" }, svg, "*");
        return;
      }
      el("circle", { class: "dot" + (p.estimate ? " est" : ""), cx: xc(i), cy: y(p.value), r: 4 }, svg);
    });
    const last = [...points].reverse().find((p) => p.value !== null && p.value !== undefined);
    const li = points.lastIndexOf(last);
    el("text", { class: "lbl", x: xc(li) + 8, y: y(last.value) + 4 }, svg, fmt(last.value));
    el("line", { x1: pad.l, x2: width - pad.r, y1: yBase, y2: yBase }, el("g", { class: "axis" }, svg));
    xLabels(svg, points, xc, yBase, slot);
  }

  // items: [{label, value, valueLabel, tip}], largest first
  function hbars(container, { items, aria }) {
    const rowH = 28;
    const height = items.length * rowH + 8;
    const { svg, width } = frame(container, height, aria);
    const labelW = Math.min(170, Math.floor(width * 0.42));
    const x0 = labelW + 8;
    const maxW = width - x0 - 70;
    const max = Math.max(1, ...items.map((it) => it.value || 0));
    items.forEach((it, i) => {
      const yTop = i * rowH + 4;
      el("rect", { class: "hit", x: 0, y: yTop, width, height: rowH, "data-tip": it.tip || "" }, svg);
      const name = it.label.length > 24 ? it.label.slice(0, 23) + "…" : it.label;
      el("text", { class: "lbl", x: labelW, y: yTop + 18, "text-anchor": "end" }, svg, name);
      const w = Math.max(0, (it.value / max) * maxW);
      if (w > 0) {
        const h = 12, yb = yTop + 8, r = Math.min(4, w, h / 2);
        el("path", { class: "bar" + (it.estimate ? " est" : ""), d: `M${x0},${yb} H${x0 + w - r} Q${x0 + w},${yb} ${x0 + w},${yb + r} V${yb + h - r} Q${x0 + w},${yb + h} ${x0 + w - r},${yb + h} H${x0} Z` }, svg);
      }
      el("text", { class: "lbl", x: x0 + w + 6, y: yTop + 18 }, svg, it.valueLabel !== undefined ? it.valueLabel : fmt(it.value));
    });
    el("line", { x1: x0, x2: x0, y1: 0, y2: height }, el("g", { class: "axis" }, svg));
  }

  // One tooltip for every chart: hover with a mouse, tap on a phone
  function bindTips() {
    const tip = document.getElementById("tip");
    let pinned = false;
    const show = (target, x, y) => {
      const text = target.getAttribute("data-tip");
      if (!text) return;
      tip.textContent = text;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 12));
      const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    };
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (t) show(t, e.clientX, e.clientY); else if (!pinned) tip.hidden = true;
    });
    document.addEventListener("pointerdown", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (t && e.pointerType !== "mouse") { pinned = true; show(t, e.clientX, e.clientY); }
      else { pinned = false; tip.hidden = true; }
    });
    window.addEventListener("scroll", () => { if (!pinned) tip.hidden = true; }, { passive: true });
  }

  return { columns, line, hbars, bindTips, fmt };
})();
