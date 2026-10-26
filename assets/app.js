/* POA project site: unlocks the encrypted data with the password, then renders the menu-driven pages. */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400000;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const parseDate = s => {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = String(s).length > 10 ? new Date(s) : new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d) ? null : d;
  };
  const fmt = (d, o) => d ? d.toLocaleDateString('en-US', o || { month: 'short', day: 'numeric' }) : '';
  const fmtLong = d => fmt(d, { month: 'long', day: 'numeric', year: 'numeric' });
  const fmtTime = d => d ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  const daysSince = d => d ? Math.floor((Date.now() - d.getTime()) / DAY) : null;
  const ago = d => {
    const n = daysSince(d);
    if (n === null) return '';
    if (n <= 0) return 'today';
    if (n === 1) return 'yesterday';
    if (n < 7) return n + ' days ago';
    return fmt(d);
  };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- encryption ----------
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const fromB64 = s => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const toB64 = buf => { let s = ''; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
  async function deriveKey(password, info) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(info.salt), iterations: info.iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }
  async function unseal(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
    return JSON.parse(dec.decode(pt));
  }
  const getJson = path => fetch(path + '?t=' + Date.now(), { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); });

  const S = { key: null, keyInfo: null, bundle: null, feed: null, diagrams: null, diagramsPromise: null, charts: [] };
  const REMEMBER = 'poa-unlock';

  async function tryKey(key) {
    try { return (await unseal(key, S.keyInfo.check)) === 'POA'; } catch { return false; }
  }

  async function boot() {
    try {
      S.keyInfo = await getJson('data/key.json');
    } catch {
      $('#lockMsg').textContent = 'The site is still being set up. Please try again in a few minutes.';
      $('#unlockBtn').disabled = true;
      return;
    }
    const saved = store.get(REMEMBER);
    if (saved && saved.salt === S.keyInfo.salt) {
      try {
        const key = await crypto.subtle.importKey('raw', fromB64(saved.k), { name: 'AES-GCM' }, true, ['decrypt']);
        if (await tryKey(key)) { S.key = key; return openSite(); }
      } catch {}
      store.del(REMEMBER);
    }
    $('#pw').focus();
  }

  $('#lockForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = $('#unlockBtn'); const msg = $('#lockMsg');
    const pw = $('#pw').value;
    if (!pw || !S.keyInfo) return;
    btn.disabled = true; btn.textContent = 'Unlocking…'; msg.textContent = '';
    try {
      const key = await deriveKey(pw, S.keyInfo);
      if (!(await tryKey(key))) throw new Error('bad');
      S.key = key;
      if ($('#remember').checked) store.set(REMEMBER, { salt: S.keyInfo.salt, k: toB64(await crypto.subtle.exportKey('raw', key)) });
      await openSite();
    } catch {
      msg.textContent = "That password didn't work. Check it and try again.";
      btn.disabled = false; btn.textContent = 'Unlock';
      $('#pw').select();
    }
  });

  async function loadData() {
    S.bundle = await unseal(S.key, await getJson('data/data.enc'));
    S.feed = S.bundle.feed;
  }

  async function openSite() {
    await loadData();
    $('#lock').hidden = true;
    $('#app').hidden = false;
    buildMenus();
    render();
  }

  function getDiagrams() {
    if (!S.diagramsPromise) {
      S.diagramsPromise = getJson('data/diagrams.enc').then(box => unseal(S.key, box)).then(async d => {
        const map = {};
        for (const x of d.diagrams) {
          const blob = await (await fetch('data:' + x.mime + ';base64,' + x.b64)).blob();
          map[x.key] = { ...x, url: URL.createObjectURL(blob), b64: null };
        }
        S.diagrams = { builtAt: d.builtAt, map };
        return S.diagrams;
      }).catch(() => { S.diagramsPromise = null; return null; });
    }
    return S.diagramsPromise;
  }

  // ---------- model ----------
  const MISSION_COLOR = { '0': '--steel', '1': '--purple', '2': '--green', '3': '--sky', '4': '--orange', all: '--amber' };
  const MISSION_NAME = { '0': 'Planning and governance', '1': 'Coaching foundations', '2': 'Athlete model', '3': 'Data capture', '4': 'Daily running', all: 'Whole program' };
  const mColor = m => css(MISSION_COLOR[m] || '--teal');
  const workstreams = () => (S.feed.workstreams || []).map(w => {
    const updated = parseDate(w.updated);
    const closed = /closed|complete/i.test(w.status || '');
    const stalledDays = daysSince(updated);
    const status = closed ? 'done' : w.waiting ? 'needs' : (stalledDays >= 3 ? 'stalled' : 'track');
    return { ...w, name: w.name || w.id, updatedDate: updated, closed, status, blocked: !closed && stalledDays >= 3 ? stalledDays : 0 };
  });
  const STATUS_LABEL = { needs: 'Needs you', stalled: 'Stalled', track: 'On track', done: 'Done' };
  const chip = st => `<span class="chip ${st}">${STATUS_LABEL[st]}</span>`;
  const slug = id => 'ws-' + String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const content = page => (S.feed.content && S.feed.content[page]) || [];
  const section = (page, title) => content(page).find(s => s.title.toLowerCase() === title.toLowerCase()) || { title: '', paras: [], items: [] };
  const governance = key => (S.feed.governance || []).find(g => g.key === key);
  const milestones = () => (S.feed.milestones || []).map(m => ({ ...m, targetD: parseDate(m.target), actualD: parseDate(m.actual), startD: parseDate(m.planStart) }));
  const decisions = () => (S.feed.decisions || []).map(d => ({ ...d, dateD: parseDate(d.date) })).filter(d => d.dateD).sort((a, b) => b.dateD - a.dateD);
  const pColor = w => { const m = (w.progress && w.progress.measure) || ''; return /scope/i.test(m) ? css('--teal') : /question/i.test(m) ? css('--purple') : mColor(w.mission); };
  const measureLabel = m => /scope/i.test(m) ? 'product capabilities fully defined' : /question/i.test(m) ? 'coaching questions fully answered' : String(m || '').toLowerCase();

  // ---------- menus ----------
  const MENU = [
    { key: 'home', label: 'Home', href: '#home' },
    { key: 'status', label: 'Status', items: [
      { href: '#waiting', label: 'Waiting on Vince', sub: 'Answers, interviews and decisions', ico: '&#9873;', c: '--amber' },
      { href: '#workstreams', label: 'Workstreams', sub: 'Done, now and next for each', ico: '&#9776;', c: '--teal' },
      { href: '#roadmap', label: 'Roadmap and milestones', sub: 'Target windows to launch', ico: '&#9719;', c: '--sky' },
      { href: '#decisions', label: 'Decisions', sub: 'Every decision, by month', ico: '&#9878;', c: '--violet' },
      { href: '#trends', label: 'Progress trends', sub: 'Coverage over time', ico: '&#9650;', c: '--green' },
      { href: '#health', label: 'Data health', sub: 'When each source last refreshed', ico: '&#9881;', c: '--orange' },
    ] },
    { key: 'how', label: 'How POA works', items: [
      { href: '#goal', label: 'The goal', sub: 'What POA has to do', ico: '&#9737;', c: '--orange' },
      { href: '#missions', label: 'Missions', sub: 'Why five, and how they connect', ico: '&#9638;', c: '--steel' },
      { href: '#lifecycle', label: 'Delivery lifecycle', sub: 'Approved diagram', ico: '&#10140;', c: '--sky' },
      { href: '#testing', label: 'Testing', sub: 'Approved diagram and results', ico: '&#10003;', c: '--green' },
      { href: '#architecture', label: 'Architecture and app preview', sub: 'Design figures and screens', ico: '&#9635;', c: '--purple' },
      { href: '#team', label: 'Team and operating model', sub: 'Who decides, who delivers', ico: '&#9786;', c: '--teal' },
      { href: '#governance', label: 'Governance documents', sub: 'The approved summaries', ico: '&#9783;', c: '--steel' },
    ] },
    { key: 'about', label: 'About', href: '#about' },
  ];
  const tile = it => `<a class="tile" href="${esc(it.href)}"${it.ext ? ' target="_blank" rel="noopener"' : ''} style="--c:var(${it.c})"><span class="ico">${it.ico}</span><span><b>${esc(it.label)}${it.ext ? ' <i class="ext">&#8599;</i>' : ''}</b><span>${esc(it.sub)}</span></span></a>`;
  const groupTiles = g => `<div class="drop-col"><div class="mm-sub">${esc(g.title)}</div>${g.items.map(tile).join('')}</div>`;

  // The project views come from the encrypted feed, grouped Governance to Testing. Only site pages
  // and links to POA's own Jira site and Google Drive are shown; outside links open in a new tab.
  const VIEW_STYLE = { Governance: ['&#9878;', '--violet'], Requirements: ['&#9776;', '--teal'], Development: ['&#9635;', '--sky'], Testing: ['&#10003;', '--green'] };
  function addViewsMenu() {
    const groups = (S.feed.projectViews || []).map(g => {
      const [ico, c] = VIEW_STYLE[g.group] || ['&#9656;', '--steel'];
      const items = (g.items || []).filter(v => /^#[a-z-]+$/.test(v.url || '') || /^https:\/\/(poa-vince\.atlassian\.net|docs\.google\.com)\//.test(v.url || ''))
        .map(v => ({ href: v.url, label: v.label, sub: v.sub, ico, c, ext: v.url.charAt(0) !== '#' }));
      return { title: g.group, items };
    }).filter(g => g.items.length);
    if (groups.length && !MENU.some(m => m.key === 'views')) {
      MENU.splice(MENU.length - 1, 0, { key: 'views', label: 'Project views', groups, items: groups.flatMap(g => g.items) });
    }
  }

  function buildMenus() {
    addViewsMenu();
    $('#menu').innerHTML = MENU.map(m => m.items
      ? `<button type="button" data-drop="${m.key}" aria-expanded="false">${esc(m.label)}<span class="car">&#9662;</span></button>`
      : `<a href="${m.href}" data-key="${m.key}">${esc(m.label)}</a>`).join('');
    $('#mobileMenu').innerHTML = `<div class="mm-head"><span class="logo"><i>POA</i>POA</span><button type="button" class="icon-btn" id="mmClose" aria-label="Close menu">&#10005;</button></div>` +
      `<div class="mm-group">${tile({ href: '#home', label: 'Home', sub: 'Overview and headline charts', ico: '&#8962;', c: '--teal' })}</div>` +
      MENU.filter(m => m.items).map(m => `<div class="mm-group"><div class="mm-label">${esc(m.label)}</div>${m.groups ? m.groups.map(groupTiles).join('') : m.items.map(tile).join('')}</div>`).join('') +
      `<div class="mm-group">${tile({ href: '#about', label: 'About', sub: 'About this website', ico: '&#9432;', c: '--steel' })}</div>`;
    $('#menu').addEventListener('click', ev => {
      const b = ev.target.closest('[data-drop]');
      if (!b) return;
      const open = b.getAttribute('aria-expanded') === 'true';
      closeDrop();
      if (!open) openDrop(b);
    });
    $('#burger').addEventListener('click', () => { $('#mobileMenu').hidden = false; $('#burger').setAttribute('aria-expanded', 'true'); });
    $('#mobileMenu').addEventListener('click', ev => {
      if (ev.target.closest('#mmClose') || ev.target.closest('a')) { $('#mobileMenu').hidden = true; $('#burger').setAttribute('aria-expanded', 'false'); }
    });
    document.addEventListener('click', ev => { if (!ev.target.closest('#drop') && !ev.target.closest('[data-drop]')) closeDrop(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { closeDrop(); closeZoom(); $('#mobileMenu').hidden = true; } });
  }
  function openDrop(btn) {
    const m = MENU.find(x => x.key === btn.dataset.drop);
    const drop = $('#drop');
    drop.innerHTML = m.groups ? m.groups.map(groupTiles).join('') : m.items.map(tile).join('');
    drop.classList.toggle('wide', !!m.groups);
    drop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    drop.addEventListener('click', ev => { if (ev.target.closest('a')) closeDrop(); }, { once: true });
  }
  function closeDrop() {
    $('#drop').hidden = true;
    document.querySelectorAll('[data-drop]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function markMenu(route) {
    const group = MENU.find(m => m.items && m.items.some(i => i.href === '#' + route));
    document.querySelectorAll('#menu > *').forEach(el => {
      const on = (el.dataset.key && el.dataset.key === route) || (group && el.dataset.drop === group.key) || (route.startsWith('ws-') && el.dataset.drop === 'status');
      el.classList.toggle('on', !!on);
    });
  }

  // ---------- charts ----------
  function chart(el, option) {
    if (!el || !window.echarts) return null;
    const c = echarts.init(el, null, { renderer: 'svg' });
    option.animation = !reduceMotion;
    option.textStyle = Object.assign({ fontFamily: 'Manrope, Segoe UI, sans-serif' }, option.textStyle || {});
    c.setOption(option);
    S.charts.push(c);
    return c;
  }
  function disposeCharts() { S.charts.forEach(c => c.dispose()); S.charts = []; }
  window.addEventListener('resize', () => S.charts.forEach(c => c.resize()));

  function ring(el, p, color, compact) {
    const ink = css('--ink'), muted = css('--muted'), track = css('--track');
    return chart(el, {
      title: { text: String(p.complete), subtext: 'of ' + p.total, left: 'center', top: compact ? '34%' : '36%',
        textStyle: { color: ink, fontSize: compact ? 26 : 40, fontFamily: 'Sora', fontWeight: 800 }, subtextStyle: { color: muted, fontSize: compact ? 11 : 13 } },
      legend: compact ? { show: false } : { bottom: 0, textStyle: { color: muted, fontSize: 12 }, itemWidth: 10, itemHeight: 10, icon: 'circle' },
      tooltip: { trigger: 'item', formatter: '{b}: {c}' },
      series: [{ type: 'pie', radius: compact ? ['62%', '84%'] : ['58%', '76%'], center: ['50%', compact ? '50%' : '44%'], label: { show: false }, padAngle: 2, itemStyle: { borderRadius: 6 },
        data: [{ value: p.complete, name: 'Complete', itemStyle: { color } }, { value: p.partial || 0, name: 'Partly', itemStyle: { color: color + '66' } },
          { value: p.pending || 0, name: 'Not yet', itemStyle: { color: track } }] }],
    });
  }

  function roadmapRows() {
    const ms = milestones();
    const names = { '1A': 'Reasoning engine (1A)', '1B': 'Coaching knowledge (1B)', '2': 'Athlete model (2)', '3': 'Data capture (3)', '4': 'Daily running (4)' };
    const colors = { '1A': '--violet', '1B': '--purple', '2': '--green', '3': '--sky', '4': '--orange' };
    const rows = [];
    ms.forEach(m => {
      const k = (m.title.match(/^Mission (1A|1B|\d) Completion/) || [])[1];
      if (!k) return;
      const end = m.actualD || m.targetD;
      const start = m.startD || parseDate((S.feed.static && S.feed.static.roadmapStarts || {})[k]);
      if (!end || !start) return;
      rows.push({ name: names[k] || ('Mission ' + k), start, end, color: css(colors[k] || '--teal'), done: /complete/i.test(m.status) });
    });
    rows.sort((a, b) => a.start - b.start);
    const launch = ms.find(m => /launch/i.test(m.title) && m.targetD);
    return { rows, launch };
  }

  function gantt(el, compact) {
    const { rows, launch } = roadmapRows();
    if (!rows.length) { el.innerHTML = '<p class="empty">No dated milestones yet.</p>'; return; }
    const muted = css('--muted'), ink = css('--ink'), grid = css('--chart-grid'), amber = css('--amber');
    const min = new Date(Math.min(...rows.map(r => r.start)) - 20 * DAY);
    const max = new Date(Math.max(...rows.map(r => r.end), launch ? launch.targetD : 0) + 25 * DAY);
    const today = new Date();
    chart(el, {
      grid: { left: compact ? 8 : 176, right: 22, top: 22, bottom: 28, containLabel: compact },
      tooltip: { formatter: p => p.seriesType === 'custom' ? `${rows[p.dataIndex].name}<br>${fmt(rows[p.dataIndex].start)} to ${fmt(rows[p.dataIndex].end)}` : 'Launch target ' + fmtLong(launch.targetD) },
      xAxis: { type: 'time', min, max, axisLabel: { color: muted, fontSize: compact ? 10 : 11, formatter: v => new Date(v).toLocaleDateString('en-US', { month: 'short' }) },
        splitLine: { show: true, lineStyle: { color: grid } }, axisLine: { lineStyle: { color: grid } } },
      yAxis: { type: 'category', data: rows.map(r => r.name), inverse: true, axisLabel: { color: ink, fontSize: compact ? 10.5 : 12.5, fontWeight: 600 }, axisTick: { show: false }, axisLine: { show: false } },
      series: [{
        type: 'custom',
        renderItem: (params, api) => {
          const y = api.value(0), s = api.coord([api.value(1), y]), e = api.coord([api.value(2), y]);
          const h = api.size([0, 1])[1] * 0.5, r = rows[params.dataIndex];
          const planned = !r.done && r.start > today;
          return { type: 'rect', shape: { x: s[0], y: s[1] - h / 2, width: Math.max(4, e[0] - s[0]), height: h, r: h / 2 },
            style: { fill: planned ? r.color + '55' : r.color, stroke: r.color, lineWidth: planned ? 1.5 : 0, lineDash: planned ? [4, 3] : null } };
        },
        encode: { x: [1, 2], y: 0 },
        data: rows.map((r, i) => [i, r.start, r.end]),
        markLine: { symbol: 'none', silent: true, label: { position: 'start', formatter: 'Today', color: amber, fontWeight: 800, fontSize: 11 },
          lineStyle: { color: amber, width: 2, type: 'solid' }, data: [{ xAxis: today }] },
      }].concat(launch ? [{
        type: 'scatter', symbol: 'diamond', symbolSize: compact ? 14 : 18, itemStyle: { color: amber }, data: [[launch.targetD, rows.length - 1]],
        label: { show: true, formatter: 'Launch', position: 'top', color: amber, fontWeight: 800, fontSize: 11 }, encode: { x: 0, y: 1 },
      }] : []),
    });
  }

  function decisionsByMonth() {
    const counts = new Map();
    decisions().slice().reverse().forEach(d => {
      const k = d.dateD.getFullYear() + '-' + String(d.dateD.getMonth() + 1).padStart(2, '0');
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    return [...counts.entries()].map(([k, v]) => ({ label: new Date(k + '-02').toLocaleDateString('en-US', { month: 'short' }), value: v }));
  }
  function decisionBars(el) {
    const data = decisionsByMonth();
    const muted = css('--muted'), ink = css('--ink'), grid = css('--chart-grid');
    chart(el, {
      grid: { left: 30, right: 10, top: 24, bottom: 26 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: data.map(d => d.label), axisLabel: { color: muted }, axisLine: { lineStyle: { color: grid } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } } },
      series: [{ type: 'bar', name: 'Decisions', data: data.map(d => d.value), barMaxWidth: 46, label: { show: true, position: 'top', color: ink, fontWeight: 800 },
        itemStyle: { borderRadius: [8, 8, 0, 0], color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: css('--sky') }, { offset: 1, color: css('--violet') }]) } }],
    });
  }

  function countUp(root) {
    root.querySelectorAll('[data-count]').forEach(el => {
      const target = Number(el.dataset.count);
      if (reduceMotion || !isFinite(target)) { el.textContent = target; return; }
      const t0 = performance.now(), dur = 900;
      const step = t => { const p = Math.min(1, (t - t0) / dur); el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
    root.querySelectorAll('.spark i[data-w]').forEach(el => requestAnimationFrame(() => { el.style.width = el.dataset.w; }));
  }

  // ---------- shared blocks ----------
  const head = (crumb, title, lead) => `<div class="page-head rise"><div class="crumb">${crumb}</div><h1>${esc(title)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : ''}</div>`;
  const paras = list => (list || []).map(p => `<p>${esc(p)}</p>`).join('');
  function needItem(w) {
    return `<a class="need" href="#${slug(w.id)}"><span class="dot${w.blocked ? ' red' : ''}"></span><span><b>${esc(w.waiting)}</b><span>${esc([w.name, w.waitingWhen, w.blocked ? 'blocked ' + w.blocked + ' days' : ''].filter(Boolean).join(' · '))}</span></span><span class="go">Open &rsaquo;</span></a>`;
  }
  function wsCard(w, i) {
    const p = w.progress;
    const bar = p && p.total ? `<div class="bar"><i style="width:${(p.complete / p.total * 100).toFixed(1)}%;background:${pColor(w)}"></i><i style="width:${((p.partial || 0) / p.total * 100).toFixed(1)}%;background:${pColor(w)}55"></i></div>` : '';
    return `<a class="wsc rise" style="--c:${mColor(w.mission)};animation-delay:${i * 50}ms" href="#${slug(w.id)}">${chip(w.status)}<b>${esc(w.name)}</b>
      <div class="now">${w.now ? 'Now: ' + esc(w.now) : ''}${w.next && !w.closed ? '<br>Next: ' + esc(w.next) : ''}</div>${bar}</a>`;
  }
  function govBlock(key) {
    const g = governance(key);
    if (!g) return '';
    const body = String(g.summary || '').split(/\n+/).map(l => l.trim()).filter(Boolean)
      .map(l => (l.length < 70 && !/[.:;]$/.test(l)) ? `<h4>${esc(l)}</h4>` : `<p>${esc(l)}</p>`).join('');
    return `${g.takeaways && g.takeaways.length ? `<div class="sec-title">Key points</div><div class="take">${g.takeaways.map((t, i) => `<div><i>${i + 1}</i>${esc(t)}</div>`).join('')}</div>` : ''}
      <details class="more"><summary>Read the approved summary of the ${esc(g.title)} (version ${esc(g.revision)})</summary><div class="prose">${body}</div></details>`;
  }
  function diagramSlot(key, opts = {}) {
    return `<figure class="figure rise"><button type="button" class="diag loading" data-diagram="${esc(key)}" aria-label="Open diagram full screen">Loading diagram…</button><figcaption data-cap="${esc(key)}"${opts.short ? ' data-short="1"' : ''}></figcaption></figure>`;
  }
  async function fillDiagrams(root) {
    const slots = root.querySelectorAll('[data-diagram]');
    if (!slots.length) return;
    const d = await getDiagrams();
    slots.forEach(slot => {
      const key = slot.dataset.diagram;
      const x = d && d.map[key];
      const cap = root.querySelector(`[data-cap="${key}"]`);
      if (!x) { slot.textContent = 'This diagram is not available yet.'; return; }
      slot.classList.remove('loading');
      slot.innerHTML = `<img src="${x.url}" alt="${esc(x.title)}"><span class="zoom-tag">&#10530; Tap to zoom</span>`;
      slot.onclick = () => openZoom(x);
      const draft = /draft/i.test(x.source) ? ' <span class="tag-draft">Draft</span>' : '';
      if (cap) cap.innerHTML = cap.dataset.short ? esc(x.title) + draft : esc(x.title) + ' · ' + esc(x.source) + draft;
    });
  }

  // ---------- pages ----------
  function pageHome() {
    const ws = workstreams();
    const needs = ws.filter(w => w.waiting && !w.closed);
    const prog = ws.filter(w => w.progress && w.progress.total).slice(0, 2);
    const hl = section('home', 'Headline').paras[0] || 'Building a private AI coach, one approved step at a time.';
    const intro = section('home', 'Intro').paras[0] || '';
    const parts = hl.split(/,\s*/);
    const hlHtml = parts.length > 1 ? `${esc(parts[0])},<br><em>${esc(parts.slice(1).join(', '))}</em>` : `<em>${esc(hl)}</em>`;
    const launch = roadmapRows().launch;
    const days = launch ? Math.max(0, Math.ceil((launch.targetD - Date.now()) / DAY)) : null;
    const decCount = (S.feed.decisions || []).length;
    const kpi = (v, small, label, w, grad) => `<div class="kpi rise"><div class="v"><span data-count="${v}">${v}</span>${small ? `<small>${small}</small>` : ''}</div><div class="l">${esc(label)}</div>${w ? `<div class="spark"><i data-w="${w}" style="width:0;background:${grad}"></i></div>` : ''}</div>`;
    const kpis = prog.map((w, i) => kpi(w.progress.complete, '/' + w.progress.total, measureLabel(w.progress.measure), (w.progress.complete / w.progress.total * 100).toFixed(1) + '%',
      /question/i.test(w.progress.measure) ? `linear-gradient(90deg, ${css('--violet')}, ${css('--purple')})` : `linear-gradient(90deg, ${css('--teal')}, ${css('--sky')})`)).join('') +
      kpi(decCount, '', 'decisions recorded', '100%', `linear-gradient(90deg, ${css('--sky')}, ${css('--violet')})`) +
      (days != null ? kpi(days, ' days', 'to the ' + fmtLong(launch.targetD) + ' launch target', '', '') : '');
    const recent = ws.flatMap(w => (w.done || []).map(d => ({ ...d, dateD: parseDate(d.date), ws: w.name })))
      .filter(d => d.dateD && daysSince(d.dateD) <= 7).sort((a, b) => b.dateD - a.dateD).slice(0, 6);
    return `
      <section class="hero"><div class="hero-in">
        <div class="kicker rise">Project status · ${esc(fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
        <h1 class="rise">${hlHtml}</h1>
        <p class="rise">${esc(intro)}</p>
        <div class="kpis">${kpis}</div>
      </div></section>
      <div class="wrap">
        <div class="grid g3">
          <div class="card rise"><h3>Waiting on Vince</h3><div class="sub">${needs.length ? 'These can’t move without you' : 'Nothing is waiting on you right now'}</div>${needs.map(needItem).join('')}</div>
          ${prog.map((w, i) => `<div class="card ring rise" style="animation-delay:${80 + i * 60}ms"><h3>${esc(w.name)}</h3><div class="sub">${esc(w.progress.total)} items · ${esc(w.progress.measure)}</div><div class="chart" data-ring="${i}" style="height:250px"></div></div>`).join('')}
        </div>
        <div class="grid g2">
          <div class="card rise"><h3>Roadmap to launch</h3><div class="sub">Sponsor target windows, not forecasts · today marked</div><div class="chart" id="gantt" style="height:300px"></div></div>
          <div class="card rise"><h3>Decisions per month</h3><div class="sub">${decCount} decisions recorded in the Registry</div><div class="chart" id="decBar" style="height:300px"></div></div>
        </div>
        <div class="sec-title">Workstreams</div>
        <div class="ws-strip">${ws.map(wsCard).join('')}</div>
        <div class="grid g-half">
          <div class="card rise"><h3>Done this week</h3>${recent.length ? `<ul class="done-list">${recent.map(d => `<li><span class="d">${esc(fmt(d.dateD))}</span><span class="t">${esc(d.text)} <span class="sub">· ${esc(d.ws)}</span></span></li>`).join('')}</ul>` : '<p class="empty">Nothing recorded as finished in the last 7 days.</p>'}</div>
          <div class="card rise"><h3>Coming up</h3>${comingUp()}</div>
        </div>
      </div>`;
  }
  function afterHome(root) {
    const ws = workstreams().filter(w => w.progress && w.progress.total).slice(0, 2);
    root.querySelectorAll('[data-ring]').forEach(el => { const w = ws[+el.dataset.ring]; ring(el, w.progress, pColor(w), window.innerWidth < 560); });
    gantt($('#gantt', root), window.innerWidth < 700);
    decisionBars($('#decBar', root));
  }
  function comingUp() {
    const up = milestones().filter(m => !/complete/i.test(m.status) && m.targetD && m.targetD >= Date.now() - DAY).sort((a, b) => a.targetD - b.targetD).slice(0, 4);
    if (!up.length) return '<p class="empty">No upcoming dated milestones.</p>';
    return `<ul class="done-list">${up.map(m => `<li><span class="d">${esc(fmt(m.targetD))}</span><span>${esc(m.title)}<br><span class="sub">Target · ${m.forecastEarliest ? 'forecast ' + esc(fmt(parseDate(m.forecastEarliest))) : 'no forecast yet'}</span></span></li>`).join('')}</ul>`;
  }

  function pageWaiting() {
    const needs = workstreams().filter(w => w.waiting && !w.closed).sort((a, b) => b.blocked - a.blocked);
    return head('Status &rsaquo; <b>Waiting on Vince</b>', 'Waiting on Vince', needs.length ? `${needs.length} item${needs.length > 1 ? 's' : ''} can't move until you act.` : 'Nothing is waiting on you right now.') +
      `<div class="wrap"><div class="card rise">${needs.map(needItem).join('') || '<p class="empty">All clear.</p>'}</div>
       <p class="sub">Red means the workstream has had no update for three days or more.</p></div>`;
  }

  function pageWorkstreams() {
    const ws = workstreams();
    const active = new Set(ws.filter(w => !w.closed).map(w => w.mission));
    const idle = ['2', '4'].filter(m => !active.has(m));
    return head('Status &rsaquo; <b>Workstreams</b>', 'Workstreams', 'Each workstream is one line of work with its own lead. Tap one for its detail.') +
      `<div class="wrap"><div class="ws-strip">${ws.map(wsCard).join('')}</div>
      ${idle.length ? `<div class="sec-title">Not started yet</div><div class="ws-strip">${idle.map(m => `<div class="wsc" style="--c:${mColor(m)}"><span class="chip done">Not started</span><b>${esc(MISSION_NAME[m])}</b><div class="now">Mission ${m} · no active workstream</div></div>`).join('')}</div>` : ''}</div>`;
  }

  function pageWorkstream(id) {
    const w = workstreams().find(x => slug(x.id) === id);
    if (!w) return head('Status', 'Not found', 'That workstream is no longer in the Registry.');
    const p = w.progress;
    return `<div class="wrap">
      <div class="ws-head rise" style="--c:${mColor(w.mission)}"><div class="crumb"><a href="#workstreams">Workstreams</a> &rsaquo;</div><h1>${esc(w.name)}</h1>
        <div>${chip(w.status)} <span class="sub">${esc(w.owner)}${w.updatedDate ? ' · updated ' + esc(ago(w.updatedDate)) : ''}</span></div></div>
      ${w.waiting && !w.closed ? `<div class="callout rise"><b>${esc(w.waiting)}</b><span class="sub">${esc(w.waitingWhen)}${w.blocked ? ' · blocked ' + w.blocked + ' days' : ''}</span></div>` : ''}
      <div class="grid g-half">
        ${p && p.total ? `<div class="card rise"><h3>Progress</h3><div class="sub">${esc(p.measure)}</div><div class="chart" id="wsRing" style="height:230px"></div>
          <div class="sub">Checked ${esc(fmtLong(parseDate(p.checked)))}. Counts definition work, not testing or building.</div>${p.stale ? '<p class="warn">These counts are waiting for the automatic Jira refresh.</p>' : ''}</div>` : ''}
        <div class="card rise"><h3>Now and next</h3><div class="prose" style="margin-top:8px"><p><b>Now:</b> ${esc(w.now || 'Not recorded')}</p>${w.closed ? '' : `<p><b>Next:</b> ${esc(w.next || 'Not recorded')}</p>`}</div></div>
      </div>
      <div class="card rise"><h3>Done recently</h3>${(w.done || []).length ? `<ul class="done-list">${w.done.map(d => `<li><span class="d">${esc(fmt(parseDate(d.date)))}</span><span class="t">${esc(d.text)}</span></li>`).join('')}</ul>` : '<p class="empty">No finished steps recorded yet.</p>'}</div>
    </div>`;
  }
  function afterWorkstream(root, id) {
    const w = workstreams().find(x => slug(x.id) === id);
    if (w && w.progress && w.progress.total) ring($('#wsRing', root), w.progress, pColor(w));
  }

  function pageRoadmap() {
    const ms = milestones();
    const up = ms.filter(m => !/complete/i.test(m.status)).sort((a, b) => (a.targetD || 9e15) - (b.targetD || 9e15));
    const reached = ms.filter(m => /complete/i.test(m.status)).sort((a, b) => (b.actualD || b.targetD || 0) - (a.actualD || a.targetD || 0));
    const late = m => m.actualD && m.targetD && m.actualD - m.targetD > DAY ? ` <span class="chip stalled">${Math.round((m.actualD - m.targetD) / DAY)} days after target</span>` : '';
    return head('Status &rsaquo; <b>Roadmap and milestones</b>', 'Roadmap and milestones', 'Target windows are the sponsor’s planning dates, not forecasts.') +
      `<div class="wrap"><div class="card rise"><h3>Roadmap to launch</h3><div class="chart" id="gantt" style="height:320px"></div></div>
      <div class="grid g-half">
        <div class="card rise"><h3>Milestones ahead</h3><ul class="done-list">${up.map(m => `<li><span class="d">${esc(m.targetD ? fmt(m.targetD) : 'No date')}</span><span>${esc(m.title)}<br><span class="sub">${m.targetD ? 'Target ' + esc(fmtLong(m.targetD)) : 'No target yet'} · ${m.forecastEarliest ? 'forecast ' + esc(fmt(parseDate(m.forecastEarliest))) : 'no forecast yet'}</span></span></li>`).join('')}</ul></div>
        <div class="card rise"><h3>Milestones reached</h3><ul class="done-list">${reached.map(m => `<li><span class="d">${esc(fmt(m.actualD || m.targetD))}</span><span class="t">${esc(m.title)}${late(m)}</span></li>`).join('')}</ul></div>
      </div></div>`;
  }

  function pageDecisions() {
    const ds = decisions();
    return head('Status &rsaquo; <b>Decisions</b>', 'Decisions', `${ds.length} decisions recorded since June, newest first.`) +
      `<div class="wrap"><div class="grid g-half">
        <div class="card rise"><h3>Decisions per month</h3><div class="chart" id="decBar" style="height:260px"></div></div>
        <div class="card rise"><h3>By mission</h3><div class="chart" id="decPie" style="height:260px"></div></div></div>
        <input class="search" id="decSearch" type="search" placeholder="Search decisions" aria-label="Search decisions">
        <div class="card rise" id="decList"></div></div>`;
  }
  function afterDecisions(root) {
    decisionBars($('#decBar', root));
    const ds = decisions();
    const byM = {};
    ds.forEach(d => { const k = d.mission || 'all'; byM[k] = (byM[k] || 0) + 1; });
    chart($('#decPie', root), {
      tooltip: { trigger: 'item', formatter: '{b}: {c}' },
      legend: { bottom: 0, textStyle: { color: css('--muted'), fontSize: 12 }, itemWidth: 10, itemHeight: 10, icon: 'circle' },
      series: [{ type: 'pie', radius: ['48%', '72%'], center: ['50%', '42%'], label: { show: false }, padAngle: 2, itemStyle: { borderRadius: 6 },
        data: Object.keys(byM).sort().map(k => ({ name: MISSION_NAME[k] || 'Mission ' + k, value: byM[k], itemStyle: { color: mColor(k) } })) }],
    });
    const list = $('#decList', root);
    const draw = q => {
      const f = ds.filter(d => !q || (d.headline + ' ' + d.id).toLowerCase().includes(q));
      let month = '', html = '';
      f.forEach(d => {
        const m = d.dateD.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (m !== month) { html += `<div class="dec-month">${esc(m)}</div>`; month = m; }
        html += `<div class="dec" style="--c:${mColor(d.mission || 'all')}"><span class="d">${esc(fmt(d.dateD))}</span><span class="dotm"></span><span>${esc(d.headline)}<span class="id">${esc(d.id)} · ${esc(MISSION_NAME[d.mission || 'all'] || '')}</span></span></div>`;
      });
      list.innerHTML = html || '<p class="empty">No decisions match.</p>';
    };
    draw('');
    $('#decSearch', root).addEventListener('input', e => draw(e.target.value.trim().toLowerCase()));
  }

  function pageTrends() {
    const h = S.feed.history || [];
    return head('Status &rsaquo; <b>Progress trends</b>', 'Progress trends', 'How coverage grows over time. A point is added each day the site reads the Registry.') +
      `<div class="wrap"><div class="card rise"><h3>Share fully complete</h3><div class="sub">${h.length} day${h.length === 1 ? '' : 's'} recorded so far</div><div class="chart" id="trend" style="height:320px"></div>
      ${h.length < 3 ? '<p class="sub">The lines fill in as days pass; the first points were recorded when the site launched.</p>' : ''}</div></div>`;
  }
  function afterTrends(root) {
    const h = S.feed.history || [];
    const ws = workstreams().filter(w => w.progress);
    const muted = css('--muted'), grid = css('--chart-grid');
    chart($('#trend', root), {
      grid: { left: 40, right: 16, top: 30, bottom: 50 },
      tooltip: { trigger: 'axis', valueFormatter: v => v == null ? '' : v + '%' },
      legend: { bottom: 0, textStyle: { color: muted } },
      xAxis: { type: 'category', data: h.map(p => fmt(parseDate(p.date))), axisLabel: { color: muted }, axisLine: { lineStyle: { color: grid } } },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: muted, formatter: '{value}%' }, splitLine: { lineStyle: { color: grid } } },
      series: ws.map(w => ({ name: w.name, type: 'line', smooth: true, symbolSize: 8, lineStyle: { width: 3, color: mColor(w.mission) }, itemStyle: { color: mColor(w.mission) },
        areaStyle: { color: mColor(w.mission) + '22' }, data: h.map(p => p[w.id] ? Math.round(p[w.id].c / p[w.id].t * 1000) / 10 : null) })),
    });
  }

  function pageHealth() {
    const dot = d => { const n = daysSince(d); return n === null ? css('--steel') : n < 1 ? css('--green') : n < 3 ? css('--amber') : css('--rose'); };
    const rows = [];
    const built = parseDate(S.bundle.builtAt), gen = parseDate(S.feed.generatedAt);
    rows.push({ c: dot(built), b: 'Project data last changed', s: built ? fmtLong(built) + ', ' + fmtTime(built) : 'unknown' });
    rows.push({ c: dot(gen), b: 'Registry read', s: gen ? fmtLong(gen) + ', ' + fmtTime(gen) : 'unknown' });
    workstreams().filter(w => w.progress).forEach(w => {
      const d = parseDate(w.progress.checked);
      rows.push({ c: w.progress.stale ? css('--amber') : dot(d), b: w.name + ' counts', s: (d ? 'checked ' + fmtLong(d) : 'not checked') + (w.progress.stale ? ' · waiting for the automatic Jira refresh' : '') });
    });
    return head('Status &rsaquo; <b>Data health</b>', 'Data health', 'When each source last refreshed. Green is today, amber is within three days, red is older.') +
      `<div class="wrap"><div class="card rise">${rows.map(r => `<div class="health-row"><span class="dot" style="background:${r.c}"></span><span><b>${esc(r.b)}</b><span>${esc(r.s)}</span></span></div>`).join('')}
      <div class="health-row" id="diagHealth"><span class="dot" style="background:${css('--steel')}"></span><span><b>Diagrams</b><span>Checking…</span></span></div></div></div>`;
  }
  async function afterHealth(root) {
    const d = await getDiagrams();
    const el = $('#diagHealth', root);
    if (!el) return;
    const b = d && parseDate(d.builtAt);
    el.querySelector('.dot').style.background = b ? (daysSince(b) < 2 ? css('--green') : css('--amber')) : css('--rose');
    el.querySelector('span span').textContent = b ? `${Object.keys(d.map).length} diagrams · refreshed ${fmtLong(b)}` : 'Not available';
  }

  const OBJ_COLORS = ['--teal', '--sky', '--violet', '--purple', '--green', '--orange', '--amber', '--steel'];
  function pageGoal() {
    const o = section('goal', 'Overall objective');
    const s = section('goal', 'Supporting objectives');
    return head('How POA works &rsaquo; <b>The goal</b>', 'The goal', o.paras[0] || '') +
      `<div class="wrap"><div class="obj-grid">${s.items.map((it, i) => `<div class="obj rise" style="--c:var(${OBJ_COLORS[i % 8]});animation-delay:${i * 40}ms"><div class="num">${i + 1}</div><b>${esc(it.label)}</b><span>${esc(it.text)}</span></div>`).join('')}</div></div>`;
  }

  function pageMissions() {
    const intro = section('missions', 'Intro');
    const five = section('missions', 'The five missions');
    const chosen = section('missions', 'How the missions were chosen');
    const mcol = label => { const m = (label.match(/Mission\s*(\d)/) || [])[1]; return label.includes('1A') ? css('--violet') : mColor(m); };
    return head('How POA works &rsaquo; <b>Missions</b>', 'Missions', intro.paras[0] || '') +
      `<div class="wrap">
        <div class="mission-cards">${five.items.map((it, i) => `<div class="mcard rise" style="--c:${mcol(it.label)};animation-delay:${i * 40}ms"><b>${esc(it.label)}</b><span>${esc(it.text)}</span></div>`).join('')}</div>
        <div class="grid g2" style="align-items:start">
          <div class="card rise"><h3>How the missions connect</h3><div class="sub" style="margin-bottom:10px">From the Mission 3 technical design</div>${diagramSlot('architecture')}</div>
          <div class="card rise"><h3>How the missions were chosen</h3><ul class="timeline" style="margin-top:14px">${chosen.items.map(it => {
            const m = it.text.match(/^(.+?[.!?])\s+(.*)$/);
            return `<li><div class="when">${esc(it.label)}</div><div class="what">${esc(m ? m[1].replace(/\.$/, '') : it.text)}</div>${m ? `<div class="why">${esc(m[2])}</div>` : ''}</li>`;
          }).join('')}</ul></div>
        </div>
        ${govBlock('hierarchy')}
      </div>`;
  }

  function pageLifecycle() {
    const shows = section('lifecycle', 'What the diagram shows');
    const owners = section('lifecycle', 'Who owns each stage');
    return head('How POA works &rsaquo; <b>Delivery lifecycle</b>', 'How POA delivers a capability', 'Every capability moves from scope to release through the same linked stages.') +
      `<div class="wrap">${diagramSlot('lifecycle')}
        <div class="grid g-half" style="align-items:start">
          <div class="card rise"><h3>What the diagram shows</h3><div class="prose" style="margin-top:8px">${paras(shows.paras)}</div></div>
          <div class="card rise"><h3>Who owns each stage</h3><div class="rows" style="margin-top:10px">${owners.items.map(it => `<div>${esc(it.label)}<span>${esc(it.text)}</span></div>`).join('')}</div></div>
        </div>${govBlock('lifecycle')}</div>`;
  }

  function pageTesting() {
    const shows = section('testing', 'What the diagram shows');
    const rules = section('testing', 'Rules we keep');
    const t = (S.feed.static && S.feed.static.testing1A) || null;
    return head('How POA works &rsaquo; <b>Testing</b>', 'How we test', 'Each release is checked against what it claims to do, by someone other than the builder.') +
      `<div class="wrap">${diagramSlot('testing')}
        <div class="grid g-half" style="align-items:start">
          <div class="card rise"><h3>What the diagram shows</h3><div class="prose" style="margin-top:8px">${paras(shows.paras)}</div></div>
          <div class="card rise"><h3>Rules we keep</h3><div class="take" style="margin-top:10px">${rules.items.map((it, i) => `<div><i>${i + 1}</i>${esc(it.label ? it.label + ': ' + it.text : it.text)}</div>`).join('')}</div></div>
        </div>
        ${t ? `<div class="sec-title">Real example: testing the reasoning engine</div>
        <div class="grid g-half">
          <div class="card rise"><h3>First run</h3><div class="sub">${t.cases} test cases, graded independently</div><div class="chart" id="t1" style="height:260px"></div></div>
          <div class="card rise"><h3>After fixes and retests</h3><div class="sub">Right answers out of ${t.cases}, with and without the specification</div><div class="chart" id="t2" style="height:260px"></div></div>
        </div><p class="sub">Campaign closed ${esc(fmtLong(parseDate(t.closed)))} with recorded limits. It doesn't claim full behavioral assurance.</p>` : ''}
        ${govBlock('testing')}</div>`;
  }
  function afterTesting(root) {
    const t = S.feed.static && S.feed.static.testing1A;
    if (!t) return;
    const muted = css('--muted'), ink = css('--ink'), grid = css('--chart-grid');
    chart($('#t1', root), {
      tooltip: { trigger: 'item', formatter: '{b}: {c}' },
      title: { text: Math.round(t.firstRun.passed / t.cases * 100) + '%', subtext: 'passed', left: 'center', top: '34%', textStyle: { color: ink, fontSize: 34, fontFamily: 'Sora', fontWeight: 800 }, subtextStyle: { color: muted } },
      legend: { bottom: 0, textStyle: { color: muted, fontSize: 12 }, itemWidth: 10, itemHeight: 10, icon: 'circle' },
      series: [{ type: 'pie', radius: ['56%', '74%'], center: ['50%', '44%'], label: { show: false }, padAngle: 2, itemStyle: { borderRadius: 6 },
        data: [{ name: 'Passed', value: t.firstRun.passed, itemStyle: { color: css('--green') } }, { name: 'Incomplete', value: t.firstRun.incomplete, itemStyle: { color: css('--amber') } },
          { name: 'Failed', value: t.firstRun.failed, itemStyle: { color: css('--rose') } }] }],
    });
    chart($('#t2', root), {
      grid: { left: 40, right: 16, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: ['With the specification', 'Without it'], axisLabel: { color: muted }, axisLine: { lineStyle: { color: grid } }, axisTick: { show: false } },
      yAxis: { type: 'value', min: 150, max: t.cases, axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } } },
      series: [{ type: 'bar', barMaxWidth: 70, label: { show: true, position: 'top', color: ink, fontWeight: 800 },
        data: [{ value: t.afterFixes.withSpec, itemStyle: { color: css('--teal'), borderRadius: [8, 8, 0, 0] } }, { value: t.afterFixes.withoutSpec, itemStyle: { color: css('--steel'), borderRadius: [8, 8, 0, 0] } }] }],
    });
  }

  function pageArchitecture() {
    const intro = section('architecture', 'Intro');
    const fit = section('architecture', 'How the pieces fit together');
    const check = section('architecture', 'How a new entry is checked');
    const screens = ['screen-food', 'screen-training', 'screen-cardio', 'screen-progress'];
    return head('How POA works &rsaquo; <b>Architecture and app preview</b>', 'Architecture and app preview', intro.paras[0] || '') +
      `<div class="wrap">
        <div class="grid g2" style="align-items:start"><div>${diagramSlot('architecture')}</div><div class="card rise"><h3>${esc(fit.title || 'How the pieces fit together')}</h3><div class="prose" style="margin-top:8px">${paras(fit.paras)}</div></div></div>
        <div class="grid g2" style="align-items:start"><div>${diagramSlot('capture')}</div><div class="card rise"><h3>${esc(check.title || 'How a new entry is checked')}</h3><div class="prose" style="margin-top:8px">${paras(check.paras)}</div></div></div>
        <div class="sec-title">App preview <span class="sub" style="font-family:var(--body)">Illustrative screen concepts; every value is an example</span></div>
        <div class="gallery">${screens.map(k => diagramSlot(k, { short: true })).join('')}</div>
      </div>`;
  }

  function pageTeam() {
    const who = section('team', 'Who does what');
    const agree = section('team', 'The working agreement');
    return head('How POA works &rsaquo; <b>Team and operating model</b>', 'Team and operating model', 'Vince decides. AI agents deliver, each in a named role, and each keeps its own records current.') +
      `<div class="wrap"><div class="roles">${who.items.map((it, i) => {
        const m = it.label.match(/^(.+?)\s*\((.+)\)$/);
        return `<div class="role rise" style="animation-delay:${i * 40}ms"><span class="k">${esc(m ? m[2] : '')}</span><b>${esc(m ? m[1] : it.label)}</b><span>${esc(it.text)}</span></div>`;
      }).join('')}</div>
      <div class="card rise"><h3>The working agreement</h3><div class="take" style="margin-top:10px">${agree.items.map((it, i) => `<div><i>${i + 1}</i>${esc(it.label ? it.label + ': ' + it.text : it.text)}</div>`).join('')}</div></div>
      ${govBlock('framework')}</div>`;
  }

  function pageGovernance() {
    const gs = S.feed.governance || [];
    return head('How POA works &rsaquo; <b>Governance documents</b>', 'Governance documents', 'The documents that govern the project, with their approved summaries.') +
      `<div class="wrap">${gs.map((g, i) => `<div class="card rise" style="animation-delay:${i * 40}ms"><h3>${esc(g.title)}</h3><div class="sub">Version ${esc(g.revision)}${g.effective ? ' · effective ' + esc(fmtLong(parseDate(g.effective))) : ''}</div>
        ${g.takeaways.length ? `<div class="take" style="margin-top:12px">${g.takeaways.map((t, j) => `<div><i>${j + 1}</i>${esc(t)}</div>`).join('')}</div>` : ''}
        <details class="more" style="margin-top:12px"><summary>Read the approved summary</summary><div class="prose">${String(g.summary || '').split(/\n+/).filter(Boolean).map(l => (l.length < 70 && !/[.:;]$/.test(l)) ? `<h4>${esc(l)}</h4>` : `<p>${esc(l)}</p>`).join('')}</div></details></div>`).join('')}</div>`;
  }

  function pageAbout() {
    const a = content('about');
    return head('<b>About</b>', 'About this website', '') + `<div class="wrap"><div class="card rise"><div class="prose">${a.map(s => paras(s.paras)).join('')}</div></div></div>`;
  }

  const ROUTES = {
    home: [pageHome, afterHome, 'Home'], waiting: [pageWaiting, null, 'Waiting on Vince'], workstreams: [pageWorkstreams, null, 'Workstreams'],
    roadmap: [pageRoadmap, root => gantt($('#gantt', root), window.innerWidth < 700), 'Roadmap'], decisions: [pageDecisions, afterDecisions, 'Decisions'],
    trends: [pageTrends, afterTrends, 'Progress trends'], health: [pageHealth, afterHealth, 'Data health'], goal: [pageGoal, null, 'The goal'],
    missions: [pageMissions, null, 'Missions'], lifecycle: [pageLifecycle, null, 'Delivery lifecycle'], testing: [pageTesting, afterTesting, 'Testing'],
    architecture: [pageArchitecture, null, 'Architecture'], team: [pageTeam, null, 'Team'], governance: [pageGovernance, null, 'Governance'], about: [pageAbout, null, 'About'],
  };

  function render() {
    const route = (location.hash || '#home').slice(1) || 'home';
    disposeCharts();
    closeDrop();
    const view = $('#view');
    let title = 'Home';
    try {
      if (route.startsWith('ws-')) {
        view.innerHTML = pageWorkstream(route);
        afterWorkstream(view, route);
        const w = workstreams().find(x => slug(x.id) === route);
        title = w ? w.name : 'Workstream';
      } else {
        const r = ROUTES[route] || ROUTES.home;
        view.innerHTML = r[0]();
        if (r[1]) r[1](view);
        title = r[2];
      }
      fillDiagrams(view);
      countUp(view);
    } catch (e) {
      view.innerHTML = `<div class="wrap"><div class="card">Something went wrong showing this page. <a href="#home">Back to Home</a></div></div>`;
      console.error(e);
    }
    document.title = title + ' · POA';
    markMenu(route);
    const needs = workstreams().filter(w => w.waiting && !w.closed).length;
    $('#waitCount').textContent = needs;
    const built = parseDate(S.bundle.builtAt);
    $('#builtAt').textContent = built ? 'Project data updated ' + fmtLong(built) + ', ' + fmtTime(built) : '';
  }

  window.addEventListener('hashchange', () => { if (S.feed) { render(); window.scrollTo(0, 0); } });

  // ---------- zoom ----------
  function openZoom(x) {
    const z = $('#zoom'); const img = $('#zoomImg');
    img.src = x.url; img.alt = x.title;
    $('#zoomScroll').classList.remove('big');
    z.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeZoom() { $('#zoom').hidden = true; document.body.style.overflow = ''; }
  $('#zoomClose').addEventListener('click', closeZoom);
  $('#zoomImg').addEventListener('click', () => $('#zoomScroll').classList.toggle('big'));
  $('#zoom').addEventListener('click', ev => { if (ev.target.id === 'zoom' || ev.target.id === 'zoomScroll') closeZoom(); });

  // ---------- controls ----------
  $('#lockBtn').addEventListener('click', () => { store.del(REMEMBER); location.hash = ''; location.reload(); });
  $('#refreshBtn').addEventListener('click', async () => {
    const b = $('#refreshBtn'); b.textContent = 'Refreshing…';
    try { await loadData(); S.diagramsPromise = null; render(); } catch {}
    b.textContent = 'Refresh';
  });
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('poa-theme', next); } catch {}
    $('#themeBtn').innerHTML = next === 'light' ? '&#9728;' : '&#9790;';
    if (S.feed) render();
  });
  if (document.documentElement.dataset.theme === 'light') $('#themeBtn').innerHTML = '&#9728;';

  boot();
})();
