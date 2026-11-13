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
  // A short date, with its year when it isn't this year's.
  const fmtD = d => d && d.getFullYear() !== new Date().getFullYear() ? fmt(d, { month: 'short', day: 'numeric', year: 'numeric' }) : fmt(d);
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

  const S = { key: null, keyInfo: null, bundle: null, feed: null, copies: null, copy: {}, img: {}, charts: [] };
  const REMEMBER = 'poa-unlock';
  const IDLE_LOCK = 30 * 60000;

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
    idleLock();
  }

  // Unless the site is remembered on this device, it locks itself after 30 minutes without use,
  // so a public computer left open doesn't stay unlocked.
  let idleTimer = null;
  function idleLock() {
    if (store.get(REMEMBER)) return;
    const arm = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { location.hash = ''; location.reload(); }, IDLE_LOCK); };
    ['pointerdown', 'keydown', 'scroll'].forEach(ev => window.addEventListener(ev, arm, { passive: true }));
    arm();
  }

  // Document copies: the list (with the diagrams), one file per copy, and images stored once each
  // as raw bytes (a 12-byte IV, then the ciphertext).
  function getCopies() {
    if (!S.copies) S.copies = getJson('data/docs.enc').then(box => unseal(S.key, box)).catch(() => { S.copies = null; return null; });
    return S.copies;
  }
  function getCopy(key) {
    if (!S.copy[key]) S.copy[key] = getJson('data/docs/' + key + '.enc').then(box => unseal(S.key, box)).catch(() => { delete S.copy[key]; return null; });
    return S.copy[key];
  }
  function getImage(id, mime) {
    if (!S.img[id]) {
      S.img[id] = fetch('data/img/' + id + '.bin').then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(buf => crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12) }, S.key, new Uint8Array(buf, 12)))
        .then(pt => URL.createObjectURL(new Blob([pt], { type: mime || 'image/png' })))
        .catch(() => { delete S.img[id]; return null; });
    }
    return S.img[id];
  }

  // ---------- model ----------
  const MISSION_COLOR = { '0': '--steel', '1': '--purple', '2': '--green', '3': '--sky', '4': '--orange', all: '--amber' };
  const MISSION_NAME = { '0': 'Planning and governance', '1': 'Coaching foundations', '2': 'Athlete model', '3': 'Data capture', '4': 'Daily running', all: 'Whole program' };
  const mColor = m => css(MISSION_COLOR[m] || '--teal');
  // A lane's chip says whether its stages are on schedule (Vince, 2026-11-02); what waits on Vince shows
  // beside it. A lane the schedule doesn't cover shows no schedule status.
  const workstreams = () => (S.feed.workstreams || []).map(w => {
    const updated = parseDate(w.updated);
    const closed = /closed|complete/i.test(w.status || '');
    const stalledDays = daysSince(updated);
    const sched = closed ? null : laneState(w.id);
    const status = closed ? 'done' : sched ? sched.s : 'none';
    return { ...w, name: w.name || w.id, updatedDate: updated, closed, status, sched, blocked: !closed && stalledDays >= 3 ? stalledDays : 0 };
  });
  const STATUS_LABEL = { done: 'Done', track: 'On track', risk: 'At risk', behind: 'Behind', none: 'No schedule' };
  const chip = st => `<span class="chip ${st}">${STATUS_LABEL[st]}</span>`;
  const needsChip = w => w.waiting && !w.closed ? '<span class="chip needs">Needs you</span>' : '';
  const slug = id => 'ws-' + String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const content = page => (S.feed.content && S.feed.content[page]) || [];
  const section = (page, title) => content(page).find(s => s.title.toLowerCase() === title.toLowerCase()) || { title: '', paras: [], items: [] };
  const governance = key => (S.feed.governance || []).find(g => g.key === key);
  const milestones = () => (S.feed.milestones || []).map(m => ({ ...m, targetD: parseDate(m.target), actualD: parseDate(m.actual), startD: parseDate(m.planStart) }));
  const decisions = () => (S.feed.decisions || []).map(d => ({ ...d, dateD: parseDate(d.date) })).filter(d => d.dateD).sort((a, b) => b.dateD - a.dateD);
  // The program schedule (Registry Schedule tab): one row per stage, release or milestone, grouped by mission
  // or increment in delivery order. A stage past its finish date that isn't complete is late.
  const SCHED_COLOR = { '0': '--steel', '1A': '--violet', '1B': '--purple', '2': '--green', '3': '--sky', '4': '--orange', all: '--teal' };
  const SCHED_LEGEND = [['0', 'Planning and scope'], ['1A', 'Reasoning engine (1A)'], ['1B', 'Coaching knowledge (1B)'], ['2', 'Athlete model'], ['3', 'Data capture'], ['4', 'Daily running'], ['all', 'Releases']];
  const sColor = k => css(SCHED_COLOR[k] || '--teal');
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const schedule = () => ((S.feed.schedule && S.feed.schedule.rows) || []).map(r => ({ ...r, startD: parseDate(r.start), finishD: parseDate(r.finish), done: /complete/i.test(r.status) }));
  const isLate = r => !r.done && !!r.finishD && r.finishD < startOfToday();
  // Under its group's heading a stage drops a prefix the heading already says: "Food: build" reads "Build".
  const shortItem = (item, grp) => {
    const m = String(item).match(/^([^:]{1,40}):\s+(.+)$/);
    const p = m && m[1].toLowerCase(), g = String(grp).toLowerCase();
    return m && (g.includes(p) || g.includes(p.replace(/s$/, ''))) ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : item;
  };
  // The lane whose progress counts the coaching questions (the raw feed, so the schedule status can use it).
  const questionLane = () => (S.feed.workstreams || []).find(x => x.progress && /question/i.test(x.progress.measure || ''));

  // ---------- schedule status ----------
  // Each stage, area and lane is Done, On track, At risk or Behind (Vince, 2026-11-02). Behind: a stage is
  // past its finish date. At risk: a stage should have started and hasn't; or it is underway and due within
  // a week with its Jira records still open; or the coaching questions' pace won't finish capture by its
  // date. On track means on schedule, nothing else.
  const SOON = 7;
  const SEVERITY = { done: 0, track: 1, risk: 2, behind: 3 };
  const STATE_COLOR = { done: '--steel', track: '--green', risk: '--orange', behind: '--rose' };
  // A schedule group, a build area (an epic) and a requirement area match by name, so "Shared foundation
  // (Missions 2–4)", "Shared foundation: database, …" and "Logging foundation requirements" are one area.
  const AREA_ALIAS = { 'logging foundation': 'shared foundation' };
  const areaKey = s => {
    const k = String(s || '').toLowerCase().replace(/\s*\([^)]*\)/g, '').split(':')[0].replace(/\s+requirements$/, '').trim();
    return AREA_ALIAS[k] || k;
  };
  const board = () => (S.feed.build && S.feed.build.status === 'ok' && S.feed.build) || null;
  const reqs = () => (S.feed.requirements && S.feed.requirements.status === 'ok' && S.feed.requirements) || null;
  const buildArea = group => { const b = board(); return (b && (b.areas || []).find(a => areaKey(a.name) === areaKey(group))) || null; };
  const reqArea = group => { const r = reqs(); return (r && (r.areas || []).find(a => areaKey(a.name) === areaKey(group))) || null; };
  const releaseNo = s => (String(s || '').match(/^Capture release (\d+)/i) || [])[1];
  const releaseCards = n => { const b = board(); return b ? (b.areas || []).flatMap(a => a.cards || []).filter(c => (c.releases || []).some(x => releaseNo(x) === n)) : []; };
  const isTrial = c => /trial|acceptance/i.test(c.name);
  const isOpen = c => c.cat !== 'done';
  // A card that changed status the day the board was set up started there at its real status, so it
  // isn't recently done.
  const movedRecently = c => { const d = parseDate(c.changed), since = parseDate(S.feed.static && S.feed.static.buildBoardSince); return d && daysSince(d) <= SOON && !(since && d <= since); };
  // The Jira records behind a stage: requirement records for a requirements stage, the area's build cards
  // for a build stage (trial cards for a test stage), and every card in a release for a release.
  function stageRecords(r) {
    if (/^requirements$/i.test(r.stage)) { const a = reqArea(r.group); return a ? { list: a.records || [], what: 'requirements still to approve' } : null; }
    if (/^release$/i.test(r.stage)) { const n = releaseNo(r.item); return n && board() ? { list: releaseCards(n), what: 'cards still open' } : null; }
    if (/^(build|test)$/i.test(r.stage)) {
      const a = buildArea(r.group);
      if (!a) return null;
      const cards = a.cards || [], trials = cards.filter(isTrial);
      return { list: /^test$/i.test(r.stage) ? (trials.length ? trials : cards) : cards.filter(c => !isTrial(c)), what: 'cards still open' };
    }
    return null;
  }
  function rowState(r) {
    if (r.done) return { s: 'done', why: [] };
    if (isLate(r)) return { s: 'behind', why: [`${r.item}: due ${fmtD(r.finishD)}`] };
    const today = startOfToday(), why = [];
    if (!r.milestone && /planned/i.test(r.status) && r.startD && r.startD < today) why.push(`${r.item}: was due to start ${fmtD(r.startD)}`);
    if (r.finishD && r.finishD - today <= SOON * DAY && (!r.startD || r.startD <= today)) {
      const rec = stageRecords(r);
      const n = rec ? rec.list.filter(isOpen).length : 0;
      if (n) why.push(`${r.item}: due ${fmtD(r.finishD)} with ${n} ${rec.what}`);
    }
    const p = /coaching knowledge capture/i.test(r.item) ? pace() : null;
    if (p && p.behind) why.push(`${r.item}: ${p.text}`);
    return { s: why.length ? 'risk' : 'track', why };
  }
  // The worst state among the rows; Done only when every row is done.
  function rowsState(rows) {
    if (!rows.length) return null;
    const st = rows.map(rowState);
    return { s: st.reduce((m, x) => SEVERITY[x.s] > SEVERITY[m] ? x.s : m, 'done'), why: st.flatMap(x => x.why) };
  }
  // The schedule's groups (missions and increments), in delivery order, with their state and Jira records.
  function areas() {
    const groups = [];
    schedule().forEach(r => { let g = groups.find(x => x.name === r.group); if (!g) groups.push(g = { name: r.group, rows: [] }); g.rows.push(r); });
    return groups.map(g => ({ ...g, ...rowsState(g.rows), cards: (buildArea(g.name) || {}).cards || null, req: reqArea(g.name) }));
  }
  // The rows a lane follows, from the feed's rule for it (a pattern per field; every given field must match).
  function laneState(id) {
    const rule = ((S.feed.static || {}).laneSchedule || {})[id];
    if (!rule) return null;
    const test = (pat, v) => !pat || new RegExp(pat, 'i').test(String(v || ''));
    const rows = schedule().filter(r => (!rule.mission || String(rule.mission).split('|').includes(r.mission)) &&
      test(rule.stage && '^(' + rule.stage + ')$', r.stage) && test(rule.group, r.group) && test(rule.item, r.item));
    return rowsState(rows);
  }
  // The coaching questions' pace since Vince's weekly minimum began: fully answered against the straight
  // line that finishes capture on its schedule date, and, after a week, where the last two weeks' pace leads.
  function pace() {
    const st = S.feed.static || {};
    const start = parseDate(st.coachingPaceStart), w = questionLane();
    const row = schedule().find(r => /coaching knowledge capture/i.test(r.item));
    if (!start || !w || !row || !row.finishD) return null;
    const hist = (S.feed.history || []).filter(p => p[w.id]).map(p => ({ d: parseDate(p.date), c: p[w.id].c })).filter(p => p.d);
    if (!hist.length) return null;
    const upTo = d => { const b = hist.filter(p => p.d <= d); return b.length ? b[b.length - 1].c : hist[0].c; };
    const base = upTo(start), total = w.progress.total, now = w.progress.complete;
    const today = startOfToday(), elapsed = Math.round((today - start) / DAY), span = Math.min(elapsed, 14);
    const weeksLeft = Math.max(1, (row.finishD - today) / (7 * DAY));
    const res = { start, base, total, now, row, hist, finish: row.finishD, span, needPerWeek: Math.max(0, Math.ceil((total - now) / weeksLeft)), rate: null, projected: null, behind: false, text: '' };
    if (elapsed >= 7 && now < total) {
      res.rate = (now - upTo(new Date(+today - span * DAY))) / span;
      res.projected = res.rate > 0 ? new Date(+today + Math.ceil((total - now) / res.rate) * DAY) : null;
      res.behind = !res.projected || res.projected > row.finishD;
      res.text = res.projected ? `at the last ${span} days’ pace, capture finishes about ${fmtD(res.projected)}, after ${fmtD(row.finishD)}`
        : `none fully answered in the last ${span} days, so capture won’t finish by ${fmtD(row.finishD)}`;
    }
    return res;
  }
  // How far a forecast window sits past its target: "3 to 4 months after target".
  function slip(target, from, to) {
    const a = Math.round((from - target) / DAY), b = Math.round((to - target) / DAY);
    if (b <= 0) return 'on or before target';
    const unit = d => d < 14 ? [d, 'day'] : d < 61 ? [Math.round(d / 7), 'week'] : [Math.round(d / 30.4), 'month'];
    const say = ([n, u]) => n + ' ' + u + (n === 1 ? '' : 's');
    const [x, u1] = unit(Math.max(a, 0)), [y, u2] = unit(b);
    if (a <= 0) return 'up to ' + say([y, u2]) + ' after target';
    if (u1 === u2) return (x === y ? say([y, u2]) : `${x} to ${say([y, u2])}`) + ' after target';
    return `${say([x, u1])} to ${say([y, u2])} after target`;
  }

  // Coaching questions newly fully answered this week (since Monday), from the daily counts, against
  // Vince's weekly minimum (2026-11-01).
  function coachingWeek() {
    const min = S.feed.static && S.feed.static.coachingWeeklyMin;
    const w = questionLane();
    const h = (S.feed.history || []).filter(p => w && p[w.id]);
    if (!min || !w || !h.length) return null;
    const now = new Date();
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const key = mon.getFullYear() + '-' + String(mon.getMonth() + 1).padStart(2, '0') + '-' + String(mon.getDate()).padStart(2, '0');
    const before = h.filter(p => p.date < key);
    const base = (before.length ? before[before.length - 1] : h[0])[w.id].c;
    return { done: Math.max(0, w.progress.complete - base), min };
  }
  const pColor = w => { const m = (w.progress && w.progress.measure) || ''; return /scope/i.test(m) ? css('--teal') : /question/i.test(m) ? css('--purple') : mColor(w.mission); };
  const measureLabel = m => /scope/i.test(m) ? 'product capabilities fully defined' : /question/i.test(m) ? 'coaching questions fully answered' : String(m || '').toLowerCase();

  // ---------- menus ----------
  // Status (the home page and its detail pages), then Governance, Requirements and design, and Testing
  // from the encrypted feed (Vince, 2026-10-27).
  const MENU = [
    { key: 'status', label: 'Status', items: [
      { href: '#home', label: 'Status overview', sub: 'Waiting on you, progress and what’s next', ico: '&#8962;', c: '--teal' },
      { href: '#roadmap', label: 'Schedule and milestones', sub: 'Every stage from June to launch', ico: '&#9719;', c: '--sky' },
      { href: '#decisions', label: 'Decisions', sub: 'Every decision, by month', ico: '&#9878;', c: '--violet' },
      { href: '#trends', label: 'Progress trends', sub: 'Coverage over time', ico: '&#9650;', c: '--green' },
      { href: '#health', label: 'Data health', sub: 'When each source last refreshed', ico: '&#9881;', c: '--orange' },
    ] },
  ];
  // Links that leave the site for Jira or Google Drive need Vince's sign-in there, so they say so:
  // on a public computer he skips them and reads the copies instead.
  const SIGN_IN = /^https:\/\/(docs\.google\.com|drive\.google\.com|[\w-]+\.atlassian\.net)\//;
  const extMark = u => SIGN_IN.test(u) ? '<i class="ext">sign-in&nbsp;&#8599;</i>' : '<i class="ext">&#8599;</i>';
  const tile = it => `<a class="tile" href="${esc(it.href)}"${it.ext ? ' target="_blank" rel="noopener"' : ''} style="--c:var(${it.c})"><span class="ico">${it.ico}</span><span><b>${esc(it.label)}${it.ext ? ' ' + extMark(it.href) : ''}</b><span>${esc(it.sub)}</span></span></a>`;
  const groupTiles = g => `<div class="drop-col"><div class="mm-sub">${esc(g.title)}</div>${g.items.map(tile).join('')}</div>`;

  // The feed's menus. Only site pages and links to POA's own Jira site and Google Drive are shown; a
  // Drive document the site keeps a copy of opens the copy, and the rest open in a new tab. Site pages
  // keep their own icons; other links take one for their kind, in their menu's color.
  const PAGE_ICON = { '#goal': ['&#9737;', '--orange'], '#missions': ['&#9638;', '--steel'], '#team': ['&#9786;', '--teal'], '#lifecycle': ['&#10140;', '--sky'],
    '#governance': ['&#9783;', '--steel'], '#architecture': ['&#9635;', '--purple'], '#testing': ['&#10003;', '--green'] };
  const MENU_COLOR = { governance: '--violet', reqdesign: '--teal', testing: '--green' };
  function addFeedMenus() {
    (S.feed.menus || []).forEach(m => {
      if (!/^[a-z]+$/.test(m.key || '') || MENU.some(x => x.key === m.key)) return;
      const c = MENU_COLOR[m.key] || '--steel';
      const groups = (m.groups || []).map(g => {
        const items = (g.items || []).filter(v => /^#[a-z0-9-]+$/.test(v.url || '') || /^https:\/\/(poa-vince\.atlassian\.net|docs\.google\.com)\//.test(v.url || ''))
          .map(v => {
            if (/^[a-z0-9-]+$/.test(v.copy || '')) return { href: '#doc-' + v.copy, label: v.label, sub: v.sub, ico: '&#9783;', c };
            if (PAGE_ICON[v.url]) return { href: v.url, label: v.label, sub: v.sub, ico: PAGE_ICON[v.url][0], c: PAGE_ICON[v.url][1] };
            return { href: v.url, label: v.label, sub: v.sub, ico: /atlassian/.test(v.url) ? '&#9776;' : '&#9638;', c, ext: v.url.charAt(0) !== '#' };
          });
        return { title: g.group, items };
      }).filter(g => g.items.length);
      if (groups.length) MENU.push({ key: m.key, label: m.label, groups: groups.length > 1 ? groups : null, items: groups.flatMap(g => g.items) });
    });
  }
  // The menu that holds a page, for the highlighted menu and the page's breadcrumb.
  const menuOf = route => (route === 'home' || route.startsWith('ws-')) ? MENU[0] : MENU.find(m => m.items.some(i => i.href === '#' + route));
  const crumb = (route, title) => { const m = menuOf(route); return (m ? esc(m.label) + ' &rsaquo; ' : '') + '<b>' + esc(title) + '</b>'; };

  function buildMenus() {
    addFeedMenus();
    $('#menu').innerHTML = MENU.map(m => `<button type="button" data-drop="${m.key}" aria-expanded="false">${esc(m.label)}<span class="car">&#9662;</span></button>`).join('');
    $('#mobileMenu').innerHTML = `<div class="mm-head"><span class="logo"><i>POA</i>POA</span><button type="button" class="icon-btn" id="mmClose" aria-label="Close menu">&#10005;</button></div>` +
      MENU.map(m => `<div class="mm-group"><div class="mm-label">${esc(m.label)}</div>${m.groups ? m.groups.map(groupTiles).join('') : m.items.map(tile).join('')}</div>`).join('') +
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
    drop.style.setProperty('--cols', m.groups ? m.groups.length : 2);
    drop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    drop.addEventListener('click', ev => { if (ev.target.closest('a')) closeDrop(); }, { once: true });
  }
  function closeDrop() {
    $('#drop').hidden = true;
    document.querySelectorAll('[data-drop]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function markMenu(route) {
    const m = menuOf(route);
    document.querySelectorAll('#menu > *').forEach(el => el.classList.toggle('on', !!m && el.dataset.drop === m.key));
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

  // A schedule chart: one category per line (cats), bars solid up to today and lighter after (a done bar is
  // solid throughout, one behind schedule ringed in rose, one at risk in orange), thin bars for milestone
  // forecast windows, and diamonds: solid for a forecast or actual date, hollow for a target.
  function drawGantt(el, cats, bars, marks, compact, axisTop) {
    const muted = css('--muted'), ink = css('--ink'), ink2 = css('--ink-2'), grid = css('--chart-grid'), amber = css('--amber'), rose = css('--rose'), orange = css('--orange'), panel = css('--panel');
    el.style.height = (cats.length * (compact ? 19 : 23) + 64) + 'px';
    const today = startOfToday();
    const times = bars.flatMap(b => [+b.start, +b.end]).concat(marks.map(m => +m.date));
    const min = new Date(Math.min(...times) - 14 * DAY), max = new Date(Math.max(...times) + 21 * DAY);
    const cut = compact ? 19 : 40;
    const lab = s => { s = String(s).replace(/[{}|]/g, ''); return s.length > cut ? s.slice(0, cut - 1) + '…' : s; };
    const diamonds = (kind, style) => ({ type: 'scatter', symbol: 'diamond', symbolSize: compact ? 10 : 13, z: kind === 'f' ? 5 : 4, encode: { x: 0, y: 1 }, itemStyle: style,
      data: marks.filter(m => m.kind === kind).map(m => ({ value: [m.date, m.y], tip: m.tip, itemStyle: m.color ? Object.assign({}, style, { color: m.color }) : style })) });
    chart(el, {
      grid: { left: compact ? 118 : 252, right: 18, top: axisTop ? 28 : 12, bottom: 28 },
      tooltip: { trigger: 'item', confine: true, formatter: p => p.seriesType === 'custom' ? bars[p.dataIndex].tip : (p.data && p.data.tip) || '' },
      xAxis: { type: 'time', min, max, position: axisTop ? 'top' : 'bottom', axisLabel: { color: muted, fontSize: compact ? 10 : 11, formatter: v => new Date(v).toLocaleDateString('en-US', { month: 'short' }) },
        splitLine: { show: true, lineStyle: { color: grid } }, axisLine: { lineStyle: { color: grid } } },
      yAxis: { type: 'category', data: cats.map(c => c.label), inverse: true, axisTick: { show: false }, axisLine: { show: false },
        axisLabel: { interval: 0, formatter: (v, i) => (cats[i] && cats[i].head ? '{h|' : '{t|') + lab(v) + '}',
          rich: { h: { color: ink, fontWeight: 800, fontSize: compact ? 10.5 : 12 }, t: { color: ink2, fontSize: compact ? 9.5 : 11 } } } },
      series: [{
        type: 'custom',
        renderItem: (params, api) => {
          const b = bars[params.dataIndex];
          const s = api.coord([b.start, b.y]), e = api.coord([b.end, b.y]);
          const h = b.thin ? 3 : Math.max(6, api.size([0, 1])[1] * 0.56), y0 = s[1] - h / 2, r = h / 2;
          const x = s[0], w = Math.max(b.thin ? 2 : 5, e[0] - s[0]);
          const t = Math.min(Math.max(api.coord([today, b.y])[0], x), x + w);
          const kids = [];
          if (b.thin) kids.push({ type: 'rect', shape: { x, y: y0, width: w, height: h }, style: { fill: b.color + '99' } });
          else if (b.done || t >= x + w) kids.push({ type: 'rect', shape: { x, y: y0, width: w, height: h, r }, style: { fill: b.color } });
          else if (t <= x) kids.push({ type: 'rect', shape: { x, y: y0, width: w, height: h, r }, style: { fill: b.color + '4D', stroke: b.color, lineWidth: 1, lineDash: [3, 3] } });
          else {
            kids.push({ type: 'rect', shape: { x, y: y0, width: t - x, height: h, r: [r, 0, 0, r] }, style: { fill: b.color } });
            kids.push({ type: 'rect', shape: { x: t, y: y0, width: x + w - t, height: h, r: [0, r, r, 0] }, style: { fill: b.color + '4D', stroke: b.color, lineWidth: 1, lineDash: [3, 3] } });
          }
          if (b.late || b.risk) kids.push({ type: 'rect', shape: { x: x - 2, y: y0 - 2, width: w + 4, height: h + 4, r: r + 2 }, style: { fill: 'none', stroke: b.late ? rose : orange, lineWidth: 2 } });
          return { type: 'group', children: kids };
        },
        encode: { x: [1, 2], y: 0 },
        data: bars.map(b => [b.y, b.start, b.end]),
        markLine: { symbol: 'none', silent: true, label: { position: axisTop ? 'end' : 'start', formatter: 'Today', color: amber, fontWeight: 800, fontSize: 11 },
          lineStyle: { color: amber, width: 2, type: 'solid' }, data: [{ xAxis: today }] },
      }, diamonds('f', { color: ink, borderColor: panel, borderWidth: 1 }), diamonds('t', { color: 'rgba(0,0,0,0)', borderColor: muted, borderWidth: 1.5 })],
    });
  }

  // The whole schedule, a line per stage under its group's heading.
  function scheduleChart(el, compact) {
    const rows = schedule();
    if (!rows.some(r => r.startD)) { el.style.height = '320px'; return gantt(el, compact); }
    const ms = new Map(milestones().map(m => [m.id, m]));
    const cats = [], bars = [], marks = [];
    let group = null;
    rows.forEach(r => {
      if (r.group !== group) { group = r.group; cats.push({ label: r.group, head: true }); }
      cats.push({ label: shortItem(r.item, r.group), head: false });
      const y = cats.length - 1, color = sColor(r.mission), st = rowState(r), late = st.s === 'behind', risk = st.s === 'risk';
      const stateTip = late ? '<br><b>Behind schedule</b>' : risk ? '<br><b>At risk:</b> ' + esc(st.why.map(t => t.replace(/^[^:]*:\s*/, '')).join('; ')) : '';
      const m = r.milestone && ms.get(r.milestone), tgt = m && m.targetD;
      const tgtTip = tgt ? '<br>Target ' + fmtLong(tgt) : '';
      if (r.milestone) {
        if (r.done && r.finishD) marks.push({ y, date: r.finishD, kind: 'f', color, tip: `${esc(r.item)}<br>Done ${fmtLong(r.finishD)}${tgtTip}` });
        else if (r.startD) {
          const span = r.finishD && r.finishD - r.startD > DAY;
          const tip = `${esc(r.item)}<br>Forecast ${span ? fmt(r.startD) + ' to ' + fmtLong(r.finishD) : fmtLong(r.startD)}${tgtTip}${stateTip}`;
          if (span) bars.push({ y, start: r.startD, end: r.finishD, color, thin: true, late, risk, tip });
          marks.push({ y, date: r.startD, kind: 'f', color, tip });
          if (span) marks.push({ y, date: r.finishD, kind: 'f', color, tip });
        }
        if (tgt && !(r.done && r.finishD && Math.abs(tgt - r.finishD) <= DAY)) marks.push({ y, date: tgt, kind: 't', tip: `${esc(r.item)}<br>Target ${fmtLong(tgt)}` });
      } else if (r.startD && r.finishD) {
        bars.push({ y, start: r.startD, end: new Date(+r.finishD + DAY), color, done: r.done, late, risk,
          tip: `${esc(r.item)}<br>${fmt(r.startD)} to ${fmtLong(r.finishD)} · ${esc([r.stage, r.status].filter(Boolean).join(', '))}${stateTip}` });
      }
    });
    drawGantt(el, cats, bars, marks, compact, true);
  }

  // One bar per group for the Status page, from its first start to its last finish, with the launch window.
  function scheduleOverview(el, compact) {
    const rows = schedule().filter(r => r.startD && r.finishD);
    if (!rows.length) { el.style.height = '300px'; return gantt(el, compact); }
    const groups = [];
    rows.forEach(r => {
      let g = groups.find(x => x.label === r.group);
      if (!g) { g = { label: r.group, head: true, start: r.startD, end: r.finishD, n: {}, done: true, rows: [] }; groups.push(g); }
      if (r.startD < g.start) g.start = r.startD;
      if (r.finishD > g.end) g.end = r.finishD;
      if (!r.milestone) g.n[r.mission] = (g.n[r.mission] || 0) + 1;
      if (!r.done) g.done = false;
      g.rows.push(r);
    });
    const bars = groups.map((g, y) => {
      const st = rowsState(g.rows).s;
      return { y, start: g.start, end: new Date(+g.end + DAY), done: g.done, late: st === 'behind', risk: st === 'risk',
        color: sColor(Object.keys(g.n).sort((a, b) => g.n[b] - g.n[a])[0] || 'all'),
        tip: `${esc(g.label)}<br>${fmt(g.start)} to ${fmtLong(g.end)} · ${STATUS_LABEL[st].toLowerCase()}` };
    });
    const marks = [];
    const launch = rows.find(r => r.milestone && /launch/i.test(r.item));
    const y = launch ? groups.findIndex(g => g.label === launch.group) : -1;
    if (y >= 0) {
      const m = milestones().find(x => x.id === launch.milestone);
      marks.push({ y, date: launch.startD, kind: 'f', color: css('--amber'), tip: `Launch forecast ${fmt(launch.startD)} to ${fmtLong(launch.finishD)}` });
      if (m && m.targetD) marks.push({ y, date: m.targetD, kind: 't', tip: 'Launch target ' + fmtLong(m.targetD) });
    }
    drawGantt(el, groups, bars, marks, compact, false);
  }
  const schedLegend = () => `<div class="sched-legend">${SCHED_LEGEND.map(([k, t]) => `<span><i style="background:${sColor(k)}"></i>${esc(t)}</span>`).join('')}<span><i class="pl"></i>Planned</span><span><i class="risk"></i>At risk</span><span><i class="late"></i>Behind</span><span>&#9670; forecast or actual &middot; &#9671; target</span></div>`;

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
  // What exactly is asked, from the lane's open sponsor request: numbered or bulleted lines become a list.
  function waitingDetail(text) {
    const lines = String(text || '').split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    let html = '', list = [], tag = 'ol';
    const flush = () => { if (list.length) html += `<${tag}>${list.map(t => `<li>${esc(t)}</li>`).join('')}</${tag}>`; list = []; };
    lines.forEach(l => {
      const m = l.match(/^(\d+[.)]|[-•*])\s+(.+)$/);
      if (!m) { flush(); html += `<p>${esc(l)}</p>`; return; }
      if (!list.length) tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      list.push(m[2]);
    });
    flush();
    return `<div class="need-detail">${html}</div>`;
  }
  function needItem(w) {
    const href = '#' + slug(w.id);
    return `<div class="need"><span class="dot${w.blocked ? ' red' : ''}"></span><div class="need-body"><a class="need-head" href="${href}"><b>${esc(w.waiting)}</b><span>${esc([w.name, w.waitingWhen, w.blocked ? 'blocked ' + w.blocked + ' days' : ''].filter(Boolean).join(' · '))}</span></a>${waitingDetail(w.waitingDetail)}</div><a class="go" href="${href}">Open &rsaquo;</a></div>`;
  }
  function wsCard(w, i) {
    const p = w.progress;
    const bar = p && p.total ? `<div class="bar"><i style="width:${(p.complete / p.total * 100).toFixed(1)}%;background:${pColor(w)}"></i><i style="width:${((p.partial || 0) / p.total * 100).toFixed(1)}%;background:${pColor(w)}55"></i></div>` : '';
    return `<a class="wsc rise" style="--c:${mColor(w.mission)};animation-delay:${i * 50}ms" href="#${slug(w.id)}">${chip(w.status)}${needsChip(w)}<b>${esc(w.name)}</b>
      <div class="now">${w.now ? 'Now: ' + esc(w.now) : ''}${w.next && !w.closed ? '<br>Next: ' + esc(w.next) : ''}</div>${bar}</a>`;
  }
  // When the summary was last checked, the site's copy of the whole document, and the original.
  const govNote = g => [g.checked ? 'Summary checked ' + esc(fmtLong(parseDate(g.checked))) : '',
    /^[a-z0-9-]+$/.test(g.copy || '') ? `<a href="#doc-${g.copy}">Read the full document</a>` : '',
    /^https:\/\/docs\.google\.com\//.test(g.url || '') ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">Original ${extMark(g.url)}</a>` : ''].filter(Boolean).join(' · ');
  function govBlock(key) {
    const g = governance(key);
    if (!g) return '';
    const body = String(g.summary || '').split(/\n+/).map(l => l.trim()).filter(Boolean)
      .map(l => (l.length < 70 && !/[.:;]$/.test(l)) ? `<h4>${esc(l)}</h4>` : `<p>${esc(l)}</p>`).join('');
    return `${g.takeaways && g.takeaways.length ? `<div class="sec-title">Key points</div><div class="take">${g.takeaways.map((t, i) => `<div><i>${i + 1}</i>${esc(t)}</div>`).join('')}</div>` : ''}
      <details class="more"><summary>Read the approved summary of the ${esc(g.title)}</summary><div class="prose">${body}</div></details>
      ${govNote(g) ? `<div class="sub" style="margin-top:8px">${govNote(g)}</div>` : ''}`;
  }
  function diagramSlot(key, opts = {}) {
    return `<figure class="figure rise"><button type="button" class="diag loading" data-diagram="${esc(key)}" aria-label="Open diagram full screen">Loading diagram…</button><figcaption data-cap="${esc(key)}"${opts.short ? ' data-short="1"' : ''}></figcaption></figure>`;
  }
  function showImage(slot, url, title) {
    slot.classList.remove('loading');
    slot.innerHTML = `<img src="${url}" alt="${esc(title)}"><span class="zoom-tag">&#10530; Tap to zoom</span>`;
    slot.onclick = () => openZoom({ url, title });
  }
  // The diagrams are figures inside the document copies; each caption links to its copy.
  async function fillDiagrams(root) {
    const slots = root.querySelectorAll('[data-diagram]');
    if (!slots.length) return;
    const idx = await getCopies();
    const map = {};
    ((idx && idx.diagrams) || []).forEach(d => { map[d.key] = d; });
    slots.forEach(async slot => {
      const key = slot.dataset.diagram;
      const x = map[key];
      const cap = root.querySelector(`[data-cap="${key}"]`);
      const url = x && await getImage(x.img, x.mime);
      if (!url) { slot.textContent = 'This diagram is not available yet.'; return; }
      showImage(slot, url, x.title);
      const draft = /draft/i.test(x.source) ? ' <span class="tag-draft">Draft</span>' : '';
      const source = /^[a-z0-9-]+$/.test(x.copy || '') ? `<a href="#doc-${x.copy}">${esc(x.source)}</a>` : esc(x.source);
      if (cap) cap.innerHTML = cap.dataset.short ? esc(x.title) + draft : esc(x.title) + ' · ' + source + draft;
    });
  }

  // ---------- pages ----------
  function pageHome() {
    const ws = workstreams();
    const needs = ws.filter(w => w.waiting && !w.closed);
    const prog = ws.filter(w => w.progress && w.progress.total).slice(0, 2);
    const active = new Set(ws.filter(w => !w.closed).map(w => w.mission));
    const idle = ['2', '4'].filter(m => !active.has(m));
    const hl = section('home', 'Headline').paras[0] || 'Building a private AI coach, one approved step at a time.';
    const intro = section('home', 'Intro').paras[0] || '';
    const parts = hl.split(/,\s*/);
    const hlHtml = parts.length > 1 ? `${esc(parts[0])},<br><em>${esc(parts.slice(1).join(', '))}</em>` : `<em>${esc(hl)}</em>`;
    const launch = roadmapRows().launch;
    const days = launch ? Math.max(0, Math.ceil((launch.targetD - Date.now()) / DAY)) : null;
    const decCount = (S.feed.decisions || []).length;
    const wk = coachingWeek();
    const kpi = (v, small, label, w, grad) => `<div class="kpi rise"><div class="v"><span data-count="${v}">${v}</span>${small ? `<small>${small}</small>` : ''}</div><div class="l">${esc(label)}</div>${w ? `<div class="spark"><i data-w="${w}" style="width:0;background:${grad}"></i></div>` : ''}</div>`;
    const kpis = prog.map((w, i) => kpi(w.progress.complete, '/' + w.progress.total, measureLabel(w.progress.measure), (w.progress.complete / w.progress.total * 100).toFixed(1) + '%',
      /question/i.test(w.progress.measure) ? `linear-gradient(90deg, ${css('--violet')}, ${css('--purple')})` : `linear-gradient(90deg, ${css('--teal')}, ${css('--sky')})`)).join('') +
      (wk ? kpi(wk.done, '/' + wk.min, 'coaching questions this week, your minimum ' + wk.min, Math.min(100, wk.done / wk.min * 100).toFixed(1) + '%', `linear-gradient(90deg, ${css('--violet')}, ${css('--purple')})`)
        : kpi(decCount, '', 'decisions recorded', '100%', `linear-gradient(90deg, ${css('--sky')}, ${css('--violet')})`)) +
      (days != null ? kpi(days, ' days', 'to the ' + fmtLong(launch.targetD) + ' launch target', '', '') : '');
    return `
      <section class="hero"><div class="hero-in">
        <div class="kicker rise">Project status · ${esc(fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
        <h1 class="rise">${hlHtml}</h1>
        <p class="rise">${esc(intro)}</p>
        <div class="kpis">${kpis}</div>
      </div></section>
      <div class="wrap">
        <div class="card rise" id="sec-glance"><h3>Done, now and next</h3><div class="sub">The last two weeks, today and the next four weeks · <a href="#roadmap">Full schedule &rsaquo;</a></div>${glance()}</div>
        <div class="card rise" id="sec-waiting"><h3>Waiting on Vince</h3><div class="sub">${needs.length ? 'These can’t move without you. Red means no update for three days or more.' : 'Nothing is waiting on you right now'}</div>${needs.map(needItem).join('')}</div>
        <div class="grid g-pair">
          ${prog.map((w, i) => `<div class="card ring rise" style="animation-delay:${80 + i * 60}ms"><h3>${esc(w.name)}</h3><div class="sub">${esc(w.progress.total)} items · ${esc(w.progress.measure)}</div><div class="chart" data-ring="${i}" style="height:250px"></div></div>`).join('')}
        </div>
        <div class="grid g2">
          <div class="card rise"><h3>Schedule to launch</h3><div class="sub">${esc(stateSummary(areas()))} · <a href="#roadmap">Where each area is &rsaquo;</a></div><div class="chart" id="gantt" style="height:300px"></div></div>
          <div class="card rise"><h3>Decisions per month</h3><div class="sub">${decCount} decisions recorded in the Registry · <a href="#decisions">All decisions &rsaquo;</a></div><div class="chart" id="decBar" style="height:300px"></div></div>
        </div>
        <div class="sec-title" id="sec-workstreams">Workstreams</div>
        <div class="ws-strip">${ws.map(wsCard).join('')}${idle.map(m => `<div class="wsc" style="--c:${mColor(m)}"><span class="chip done">Not started</span><b>${esc(MISSION_NAME[m])}</b><div class="now">Mission ${m} · no active workstream</div></div>`).join('')}</div>
        <p class="sub">More: <a href="#trends">Progress trends</a> · <a href="#health">Data health</a></p>
      </div>`;
  }
  function afterHome(root) {
    const ws = workstreams().filter(w => w.progress && w.progress.total).slice(0, 2);
    root.querySelectorAll('[data-ring]').forEach(el => { const w = ws[+el.dataset.ring]; ring(el, w.progress, pColor(w), window.innerWidth < 560); });
    scheduleOverview($('#gantt', root), window.innerWidth < 700);
    decisionBars($('#decBar', root));
  }
  // Done, now and next (Vince, 2026-11-13: "a concise visual to see what's been completed recently, what's
  // up now and what is coming in the near future", at any time). Done: the lanes' recently done lines from
  // the last two weeks. Now: what waits on Vince, then each area's stages under way or due to have started,
  // worst first. Coming up: each area's next stage starting in the next four weeks, then the launch window.
  // All read from the Registry and Jira like the rest of the page, so it stays current by itself.
  const GLANCE_BACK = 14, GLANCE_AHEAD = 28;
  const lowerFirst = s => /^.[a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  function glance() {
    const ws = workstreams(), today = startOfToday(), until = new Date(+today + GLANCE_AHEAD * DAY);
    const li = (d, body) => `<li><span class="d">${esc(d)}</span><span class="t">${body}</span></li>`;
    const list = (items, cls, empty) => items.length ? `<ul class="done-list${cls}">${items.join('')}</ul>` : `<p class="empty">${empty}</p>`;
    const done = ws.flatMap(w => (w.done || []).map(d => ({ dateD: parseDate(d.date), text: d.text })))
      .filter(d => d.dateD && daysSince(d.dateD) <= GLANCE_BACK).sort((a, b) => b.dateD - a.dateD).slice(0, 8)
      .map(d => li(fmt(d.dateD), esc(d.text)));
    const started = r => !r.done && !r.milestone && (/in progress/i.test(r.status) || (r.startD && r.startD < today));
    const you = ws.filter(w => w.waiting && !w.closed)
      .map(w => li('You', `<a href="#${slug(w.id)}">${esc(w.waiting)}</a>${w.waitingWhen ? ` <span class="sub">· ${esc(w.waitingWhen)}</span>` : ''}`));
    const under = areas().map(a => ({ a, rows: a.rows.filter(started) })).filter(x => x.rows.length).map(x => {
      const st = rowsState(x.rows).s, due = x.rows.map(r => r.finishD).filter(Boolean).sort((p, q) => p - q)[0];
      return { st, due, html: `<b>${esc(x.a.name)}</b>: ${esc(x.rows.map(r => lowerFirst(shortItem(r.item, x.a.name))).join(', '))}${st === 'risk' || st === 'behind' ? ' ' + chip(st) : ''}` };
    }).sort((p, q) => SEVERITY[q.st] - SEVERITY[p.st] || (p.due || 0) - (q.due || 0));
    const now = you.concat(under.slice(0, 8).map(u => li(u.due ? 'Due ' + fmt(u.due) : '', u.html)));
    const more = under.length > 8 ? `<p class="sub">And ${under.length - 8} more on the <a href="#roadmap">schedule</a></p>` : '';
    const next = areas().map(a => a.rows.filter(r => !r.done && !started(r) && r.startD && r.startD >= today && r.startD <= until).sort((p, q) => p.startD - q.startD)[0])
      .filter(Boolean).sort((p, q) => p.startD - q.startD).slice(0, 6).map(r => li(fmt(r.startD), esc(r.item)));
    const l = milestones().find(m => /launch/i.test(m.title) && !/complete/i.test(m.status));
    const lf = l && parseDate(l.forecastEarliest), ll = l && (parseDate(l.forecastLatest) || lf);
    const launch = l && (lf || l.targetD) ? `<p class="sub">Launch: ${lf ? 'forecast ' + esc(ll && +ll !== +lf ? fmt(lf) + ' to ' + fmtD(ll) : fmtD(lf)) : ''}${lf && l.targetD ? '; ' : ''}${l.targetD ? 'your target ' + esc(fmt(l.targetD)) : ''}</p>` : '';
    return `<div class="grid g3 glance">
      <div><h4>Done recently</h4>${list(done, '', 'Nothing recorded as finished in the last two weeks.')}</div>
      <div><h4>Now</h4>${list(now, ' plain', 'Nothing under way.')}${more}</div>
      <div><h4>Coming up</h4>${list(next, ' plain', 'Nothing starts in the next four weeks.')}${launch}</div>
    </div>`;
  }

  function pageWorkstream(id) {
    const w = workstreams().find(x => slug(x.id) === id);
    if (!w) return head('Status', 'Not found', 'That workstream is no longer in the Registry.');
    const p = w.progress;
    return `<div class="wrap">
      <div class="ws-head rise" style="--c:${mColor(w.mission)}"><div class="crumb"><a href="#workstreams">Status &rsaquo; Workstreams</a> &rsaquo;</div><h1>${esc(w.name)}</h1>
        <div>${chip(w.status)}${needsChip(w)} <span class="sub">${esc(w.owner)}${w.updatedDate ? ' · updated ' + esc(ago(w.updatedDate)) : ''}</span></div></div>
      ${w.sched && w.sched.why.length ? `<div class="card rise"><h3>${esc(STATUS_LABEL[w.status])}</h3><ul class="why">${w.sched.why.map(t => `<li>${esc(t)}</li>`).join('')}</ul><div class="sub" style="margin-top:8px"><a href="#roadmap">Schedule and milestones &rsaquo;</a></div></div>` : ''}
      ${w.waiting && !w.closed ? `<div class="callout rise"><b>${esc(w.waiting)}</b><span class="sub">${esc(w.waitingWhen)}${w.blocked ? ' · blocked ' + w.blocked + ' days' : ''}</span>${waitingDetail(w.waitingDetail)}</div>` : ''}
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

  // "10 on track · 1 at risk · 1 done", across the schedule's areas.
  function stateSummary(list) {
    if (!list.length) return 'Each area from its first stage to its last';
    const n = s => list.filter(a => a.s === s).length;
    return ['behind', 'risk', 'track', 'done'].filter(s => n(s)).map(s => n(s) + ' ' + STATUS_LABEL[s].toLowerCase()).join(' · ');
  }
  const stateDot = s => `<span class="sd" style="--c:var(${STATE_COLOR[s] || '--steel'})"></span>`;
  const mini = items => items.length ? `<ul class="mini">${items.join('')}</ul>` : '<p class="empty">None</p>';
  const miniItem = (s, text, date) => `<li>${stateDot(s)}<span>${text}</span>${date ? `<span class="dt">${esc(date)}</span>` : ''}</li>`;
  // A bar of done (solid) and in progress (light) out of a total, with its label.
  const meter = (label, done, prog, total, color) => total ? `<div class="meter"><span>${esc(label)}</span><div class="bar"><i style="width:${(done / total * 100).toFixed(1)}%;background:${color}"></i><i style="width:${(prog / total * 100).toFixed(1)}%;background:${color}55"></i></div></div>` : '';
  const cardMeter = (cards, label) => meter(`${cards.filter(c => c.cat === 'done').length} of ${cards.length} ${label}`, cards.filter(c => c.cat === 'done').length, cards.filter(c => c.cat === 'indeterminate').length, cards.length, css('--sky'));
  const reqMeter = a => { const r = a.records || [], d = r.filter(x => x.cat === 'done').length; return meter(`${d} of ${r.length} requirements approved`, d, 0, r.length, css('--teal')); };
  // The target line for an area: its last milestone with a target, and how far the forecast sits from it.
  function targetLine(a) {
    const ms = new Map(milestones().map(m => [m.id, m]));
    const r = a.rows.filter(x => x.milestone && ms.get(x.milestone) && ms.get(x.milestone).targetD).pop();
    if (!r) return '';
    const t = ms.get(r.milestone).targetD;
    if (r.done) return `${shortItem(r.item, a.name)}: done ${fmtD(r.finishD)}, target ${fmtD(t)}`;
    if (!r.startD) return `${shortItem(r.item, a.name)}: target ${fmtD(t)}, no forecast yet`;
    const to = r.finishD || r.startD;
    return `${shortItem(r.item, a.name)}: target ${fmtD(t)} · forecast ${fmtD(r.startD)}${+to !== +r.startD ? ' to ' + fmtD(to) : ''} · ${slip(t, r.startD, to)}`;
  }
  // One area: its state, where it is and what's next; tapped open, its reasons, stages and Jira cards.
  function areaRow(a) {
    const stages = a.rows.filter(r => !r.milestone);
    const label = r => esc(shortItem(r.item, a.name));
    const now = stages.filter(r => /in progress/i.test(r.status));
    const nextStage = stages.filter(r => /planned/i.test(r.status)).sort((x, y) => (x.startD || 0) - (y.startD || 0))[0];
    const cards = a.cards || [];
    const selected = cards.filter(c => /selected/i.test(c.status));
    const line = a.s === 'done' ? 'Every stage done'
      : [now.length ? 'Now: ' + now.map(r => `${label(r)} to ${esc(fmtD(r.finishD))}`).join(', ') : '',
        nextStage ? `Next: ${label(nextStage)}${nextStage.startD ? ', ' + esc(fmtD(nextStage.startD)) : ''}` : ''].filter(Boolean).join(' · ');
    const tl = targetLine(a);
    const meters = (cards.length ? cardMeter(cards, 'build cards done') : '') + (a.req ? reqMeter(a.req) : '');
    const nowItems = now.map(r => miniItem(rowState(r).s, label(r), 'to ' + fmtD(r.finishD)))
      .concat(cards.filter(c => c.cat === 'indeterminate').map(c => miniItem('track', 'Card: ' + esc(c.name), c.status)));
    const nextItems = selected.length ? selected.map(c => miniItem('track', 'Card: ' + esc(c.name), 'selected'))
      : nextStage ? [miniItem(rowState(nextStage).s, label(nextStage), nextStage.startD ? 'from ' + fmtD(nextStage.startD) : '')] : [];
    const doneItems = stages.filter(r => r.done && r.finishD && daysSince(r.finishD) <= SOON && daysSince(r.finishD) >= 0).map(r => miniItem('done', label(r), fmtD(r.finishD)))
      .concat(cards.filter(c => c.cat === 'done' && movedRecently(c)).map(c => miniItem('done', 'Card: ' + esc(c.name), fmtD(parseDate(c.changed)))))
      .concat(a.req ? (() => { const n = (a.req.records || []).filter(x => x.cat === 'done' && daysSince(parseDate(x.changed)) <= SOON).length; return n ? [miniItem('done', `${n} requirement${n === 1 ? '' : 's'} approved`, '')] : []; })() : []);
    const stageList = a.rows.map(r => {
      const st = rowState(r).s;
      const when = r.milestone ? (r.done ? 'done ' + fmtD(r.finishD) : r.startD ? 'forecast ' + fmtD(r.startD) + (r.finishD && +r.finishD !== +r.startD ? ' to ' + fmtD(r.finishD) : '') : 'no forecast')
        : (r.startD ? fmtD(r.startD) + (r.finishD ? ' to ' + fmtD(r.finishD) : '') : '');
      return miniItem(st, label(r) + ` <span class="sub">· ${esc(r.milestone ? 'Milestone' : r.status)}</span>`, when);
    });
    const cardList = cards.map(c => `<li><span class="cs ${esc(c.cat)}">${esc(c.status)}</span><span>${esc(c.name)}</span></li>`);
    return `<details class="area" style="--c:var(${STATE_COLOR[a.s] || '--steel'})">
      <summary><span class="area-top"><b>${esc(a.name)}</b>${chip(a.s)}</span>${line ? `<span class="area-line">${line}</span>` : ''}${tl ? `<span class="area-tgt">${esc(tl)}</span>` : ''}${meters ? `<span class="meters">${meters}</span>` : ''}</summary>
      <div class="area-body">
        ${a.why.length ? `<ul class="why">${a.why.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        <div class="area-cols"><div><h4>Now</h4>${mini(nowItems)}</div><div><h4>Next</h4>${mini(nextItems)}</div><div><h4>Done in the last 7 days</h4>${mini(doneItems)}</div></div>
        <h4>Stages</h4><ul class="mini">${stageList.join('')}</ul>
        ${cardList.length ? `<h4>Build cards</h4><ul class="mini cards">${cardList.join('')}</ul>` : ''}
      </div></details>`;
  }
  // Stages starting or due, and milestone windows opening, in the next two weeks.
  function nextTwoWeeks() {
    const today = startOfToday(), end = new Date(+today + 14 * DAY), out = [];
    const inWin = d => d && d >= today && d <= end;
    schedule().forEach(r => {
      if (r.done) return;
      if (r.milestone) { if (inWin(r.startD)) out.push({ d: r.startD, r, kind: 'forecast window opens' }); return; }
      if (/planned/i.test(r.status) && inWin(r.startD)) out.push({ d: r.startD, r, kind: 'starts' });
      if (inWin(r.finishD)) out.push({ d: r.finishD, r, kind: 'due' });
    });
    return out.sort((a, b) => a.d - b.d);
  }
  function releasesCard() {
    const rel = schedule().filter(r => /^release$/i.test(r.stage) && releaseNo(r.item));
    if (!rel.length) return '';
    const b = board();
    return `<div class="card rise"><h3>Capture releases</h3><div class="sub">Build cards done out of each release’s total. Done means built and checked, not released.</div>
      <div class="rel-list">${rel.map(r => {
        const cards = releaseCards(releaseNo(r.item)), st = rowState(r).s;
        const areasIn = b ? (b.areas || []).filter(a => (a.releases || []).some(x => releaseNo(x) === releaseNo(r.item))).map(a => a.name.split(':')[0]) : [];
        return `<div class="rel"><div class="area-top"><b>${esc(r.item)}</b>${chip(st)}</div>
          <div class="sub">${r.startD ? esc(fmtD(r.startD) + ' to ' + fmtD(r.finishD)) : ''}${areasIn.length ? ' · ' + esc(areasIn.join(', ')) : ''}</div>
          ${cards.length ? cardMeter(cards, 'cards done') : `<p class="sub">${b ? 'No build cards yet: they’re added from each area’s build package.' : 'The build board couldn’t be read at the last refresh.'}</p>`}</div>`;
      }).join('')}</div></div>`;
  }
  function requirementsCard() {
    const r = reqs();
    if (!r || !(r.areas || []).length) return '';
    const due = name => { const row = schedule().find(x => /^requirements$/i.test(x.stage) && areaKey(x.group) === areaKey(name)); return row && !row.done && row.finishD ? row : null; };
    return `<div class="card rise"><h3>Requirements before build</h3><div class="sub">Approved requirements out of each area’s total. Building waits on them.</div>
      <div class="rel-list">${r.areas.map(a => {
        const row = due(a.name), st = row ? rowState(row).s : null;
        return `<div class="rel"><div class="area-top"><b>${esc(a.name.replace(/\s+requirements$/i, ''))}</b>${st ? chip(st) : ''}</div>
          ${row ? `<div class="sub">Due ${esc(fmtD(row.finishD))}</div>` : ''}${reqMeter(a)}</div>`;
      }).join('')}</div></div>`;
  }
  function paceCard() {
    const p = pace(), wk = coachingWeek();
    if (!p) return '';
    const left = p.total - p.now;
    const lineTxt = p.rate == null ? `The pace shows after the first full week, ${fmtD(new Date(+p.start + 7 * DAY))}.`
      : p.behind ? 'At risk: ' + p.text + '.' : `At the last ${p.span} days’ pace, capture finishes about ${fmtD(p.projected)}, on time.`;
    return `<div class="card rise"><h3>Coaching questions pace</h3>
      <div class="sub">${wk ? `${wk.done} of ${wk.min} this week · ` : ''}${left} left, about ${p.needPerWeek} a week to finish by ${esc(fmtD(p.finish))}</div>
      <div class="chart" id="paceChart" style="height:240px"></div><p class="sub">${esc(lineTxt)} Main questions fully answered, counted from Jira each day.</p></div>`;
  }
  function drawPace(el) {
    const p = pace();
    if (!el || !p) return;
    const muted = css('--muted'), grid = css('--chart-grid'), purple = css('--purple'), orange = css('--orange'), amber = css('--amber');
    const from = new Date(+p.start - 7 * DAY), end = new Date(Math.max(+p.finish, p.projected && p.behind ? Math.min(+p.projected, +p.finish + 42 * DAY) : 0) + 3 * DAY);
    const today = startOfToday();
    const actual = p.hist.filter(h => h.d >= from).map(h => [h.d, h.c]);
    if (!actual.length || +actual[actual.length - 1][0] < +today) actual.push([today, p.now]);
    const series = [
      { name: 'Fully answered', type: 'line', data: actual, symbolSize: 6, lineStyle: { width: 3, color: purple }, itemStyle: { color: purple }, areaStyle: { color: purple + '22' } },
      { name: 'Needed', type: 'line', data: [[p.start, p.base], [p.finish, p.total]], symbol: 'none', lineStyle: { width: 2, type: 'dashed', color: muted }, itemStyle: { color: muted } },
    ];
    if (p.rate != null) {
      const tEnd = p.projected && p.projected <= end ? p.projected : end;
      series.push({ name: 'Current pace', type: 'line', symbol: 'none', lineStyle: { width: 2, type: 'dotted', color: p.behind ? orange : css('--green') }, itemStyle: { color: p.behind ? orange : css('--green') },
        data: [[today, p.now], [tEnd, Math.min(p.total, p.now + p.rate * Math.round((tEnd - today) / DAY))]] });
    }
    series[0].markLine = { symbol: 'none', silent: true, label: { formatter: 'Today', color: amber, fontWeight: 800, fontSize: 11 }, lineStyle: { color: amber, width: 2, type: 'solid' }, data: [{ xAxis: today }] };
    chart(el, {
      grid: { left: 36, right: 14, top: 18, bottom: 46 },
      tooltip: { trigger: 'axis', valueFormatter: v => v == null ? '' : Math.round(v) },
      legend: { bottom: 0, textStyle: { color: muted, fontSize: 12 } },
      xAxis: { type: 'time', min: from, max: end, splitNumber: window.innerWidth < 560 ? 3 : 6,
        axisLabel: { color: muted, fontSize: 11, hideOverlap: true, formatter: v => fmtD(new Date(v)) }, axisLine: { lineStyle: { color: grid } }, splitLine: { show: false } },
      yAxis: { type: 'value', min: Math.max(0, Math.floor((p.base - 5) / 10) * 10), max: p.total, axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } } },
      series,
    });
  }

  function pageRoadmap() {
    const ms = milestones();
    const up = ms.filter(m => !/complete/i.test(m.status)).sort((a, b) => (a.targetD || 9e15) - (b.targetD || 9e15));
    const reached = ms.filter(m => /complete/i.test(m.status)).sort((a, b) => (b.actualD || b.targetD || 0) - (a.actualD || a.targetD || 0));
    const late = m => m.actualD && m.targetD && m.actualD - m.targetD > DAY ? ` <span class="chip behind">${Math.round((m.actualD - m.targetD) / DAY)} days after target</span>` : '';
    const rows = schedule();
    const reviewed = parseDate(S.feed.schedule && S.feed.schedule.reviewed);
    const lead = rows.length ? 'Where each area is, what’s next and whether it’s on schedule, from the Registry’s schedule and the Jira build board' + (reviewed ? '. Forecast last reviewed ' + fmtLong(reviewed) : '') + '.'
      : 'Target windows are the sponsor’s planning dates, not forecasts.';
    const list = rows.length ? areas() : [];
    // Areas still under way first, in delivery order; finished ones last.
    const ordered = list.filter(a => a.s !== 'done').concat(list.filter(a => a.s === 'done'));
    const b = S.feed.build, read = b && b.status === 'ok' ? parseDate(b.checked) : null;
    const soon = rows.length ? nextTwoWeeks() : [];
    const docLink = (S.feed.menus || []).some(m => (m.groups || []).some(g => (g.items || []).some(i => i.copy === 'jira-views')));
    const boardNote = [read ? 'Build cards read from Jira ' + esc(fmtLong(read)) + ', ' + esc(fmtTime(read)) : b && b.status ? 'The build board couldn’t be read at the last refresh' : '',
      docLink ? '<a href="#doc-jira-views">Jira guide</a>' : '',
      b && /^https:\/\/[\w-]+\.atlassian\.net\//.test(b.board || '') ? `<a href="${esc(b.board)}" target="_blank" rel="noopener">Build board ${extMark(b.board)}</a>` : ''].filter(Boolean).join(' · ');
    const milestoneSub = m => {
      const f = parseDate(m.forecastEarliest), l = parseDate(m.forecastLatest) || f;
      return `${m.targetD ? 'Target ' + esc(fmtLong(m.targetD)) : 'No target yet'} · ${f ? 'forecast ' + esc(fmtD(f)) + (l && +l !== +f ? ' to ' + esc(fmtD(l)) : '') + (m.targetD ? ' · ' + esc(slip(m.targetD, f, l)) : '') : 'no forecast yet'}`;
    };
    return head(crumb('roadmap', 'Schedule and milestones'), 'Schedule and milestones', lead) +
      `<div class="wrap">
      ${list.length ? `<div class="card rise"><h3>Every area</h3><div class="sub">${esc(stateSummary(list))}. On track means every stage is on schedule. Tap an area for its stages and build cards.</div>
        <div class="areas">${ordered.map(areaRow).join('')}</div>${boardNote ? `<div class="sub" style="margin-top:10px">${boardNote}</div>` : ''}</div>
      <div class="grid g-half">
        <div class="card rise"><h3>Next two weeks</h3><div class="sub">Stages starting or due by ${esc(fmtD(new Date(+startOfToday() + 14 * DAY)))}</div>${mini(soon.map(x => miniItem(rowState(x.r).s, `${esc(x.r.item)} <span class="sub">· ${esc(x.kind)}</span>`, fmtD(x.d))))}</div>
        ${paceCard()}
      </div>
      <div class="grid g-half">${releasesCard()}${requirementsCard()}</div>` : ''}
      <div class="card rise"><h3>Schedule</h3><div class="sub">${rows.length ? 'Bars are stages, solid up to today and lighter after. Tap a bar for its dates.' : 'Sponsor target windows'}</div><div class="chart" id="sched"></div>${rows.length ? schedLegend() : ''}</div>
      <div class="grid g-half">
        <div class="card rise"><h3>Milestones ahead</h3><ul class="done-list">${up.map(m => `<li><span class="d">${esc(m.targetD ? fmtD(m.targetD) : 'No date')}</span><span>${esc(m.title)}<br><span class="sub">${milestoneSub(m)}</span></span></li>`).join('')}</ul></div>
        <div class="card rise"><h3>Milestones reached</h3><ul class="done-list">${reached.map(m => `<li><span class="d">${esc(fmtD(m.actualD || m.targetD))}</span><span class="t">${esc(m.title)}${late(m)}</span></li>`).join('')}</ul></div>
      </div></div>`;
  }
  function afterRoadmap(root) {
    scheduleChart($('#sched', root), window.innerWidth < 700);
    drawPace($('#paceChart', root));
  }

  function pageDecisions() {
    const ds = decisions();
    return head(crumb('decisions', 'Decisions'), 'Decisions', `${ds.length} decisions recorded since June, newest first.`) +
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
    return head(crumb('trends', 'Progress trends'), 'Progress trends', 'How coverage grows over time. A point is added each day the site reads the Registry.') +
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
    [['Build board (Jira)', S.feed.build], ['Requirement records (Jira)', S.feed.requirements]].forEach(([label, p]) => {
      if (!p) return;
      const d = p.status === 'ok' ? parseDate(p.checked) : null;
      rows.push({ c: d ? dot(d) : css('--rose'), b: label, s: d ? 'read ' + fmtLong(d) + ', ' + fmtTime(d) : String(p.status || 'not read') });
    });
    return head(crumb('health', 'Data health'), 'Data health', 'When each source last refreshed. Green is today, amber is within three days, red is older.') +
      `<div class="wrap"><div class="card rise">${rows.map(r => `<div class="health-row"><span class="dot" style="background:${r.c}"></span><span><b>${esc(r.b)}</b><span>${esc(r.s)}</span></span></div>`).join('')}
      <div class="health-row" id="copyHealth"><span class="dot" style="background:${css('--steel')}"></span><span><b>Document copies and diagrams</b><span>Checking…</span></span></div></div></div>`;
  }
  // Copies change only when their document does, so an old date is normal; a missing list is not.
  async function afterHealth(root) {
    const idx = await getCopies();
    const el = $('#copyHealth', root);
    if (!el) return;
    const docs = idx ? Object.values(idx.docs || {}) : [];
    const last = docs.map(d => parseDate(d.builtAt)).filter(Boolean).sort((a, b) => b - a)[0];
    el.querySelector('.dot').style.background = docs.length ? css('--green') : css('--rose');
    el.querySelector('span span').textContent = docs.length
      ? `${docs.length} documents and ${(idx.diagrams || []).length} diagrams · checked every 15 minutes, last changed ${fmtLong(last)}`
      : 'Not available';
  }

  const OBJ_COLORS = ['--teal', '--sky', '--violet', '--purple', '--green', '--orange', '--amber', '--steel'];
  function pageGoal() {
    const o = section('goal', 'Overall objective');
    const s = section('goal', 'Supporting objectives');
    return head(crumb('goal', 'The goal'), 'The goal', o.paras[0] || '') +
      `<div class="wrap"><div class="obj-grid">${s.items.map((it, i) => `<div class="obj rise" style="--c:var(${OBJ_COLORS[i % 8]});animation-delay:${i * 40}ms"><div class="num">${i + 1}</div><b>${esc(it.label)}</b><span>${esc(it.text)}</span></div>`).join('')}</div></div>`;
  }

  function pageMissions() {
    const intro = section('missions', 'Intro');
    const five = section('missions', 'The five missions');
    const chosen = section('missions', 'How the missions were chosen');
    const mcol = label => { const m = (label.match(/Mission\s*(\d)/) || [])[1]; return label.includes('1A') ? css('--violet') : mColor(m); };
    return head(crumb('missions', 'Missions'), 'Missions', intro.paras[0] || '') +
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
    return head(crumb('lifecycle', 'Delivery lifecycle'), 'How POA delivers a capability', 'Every capability moves from scope to release through the same linked stages.') +
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
    return head(crumb('testing', 'Testing overview'), 'How we test', 'Each release is checked against what it claims to do, by someone other than the builder.') +
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
    return head(crumb('architecture', 'Architecture'), 'Architecture', intro.paras[0] || '') +
      `<div class="wrap">
        <div class="grid g2" style="align-items:start"><div>${diagramSlot('architecture')}</div><div class="card rise"><h3>${esc(fit.title || 'How the pieces fit together')}</h3><div class="prose" style="margin-top:8px">${paras(fit.paras)}</div></div></div>
        <div class="grid g2" style="align-items:start"><div>${diagramSlot('capture')}</div><div class="card rise"><h3>${esc(check.title || 'How a new entry is checked')}</h3><div class="prose" style="margin-top:8px">${paras(check.paras)}</div></div></div>
        <div id="designMore"></div>
      </div>`;
  }
  // The design documents, and any of their figures not already shown above.
  const DESIGN_DOCS = ['athlete-model', 'technical-design', 'build-package'];
  async function afterArchitecture(root) {
    const idx = await getCopies();
    const box = $('#designMore', root);
    if (!idx || !box) return;
    const docs = DESIGN_DOCS.filter(k => idx.docs[k]);
    const shown = new Set((idx.diagrams || []).map(d => d.img));
    const figs = docs.flatMap(k => (idx.docs[k].figures || []).filter(f => f && !shown.has(f.img)).map(f => ({ ...f, k, doc: idx.docs[k].title })));
    box.innerHTML = (figs.length ? `<div class="sec-title">More design figures</div><div class="grid g2" style="align-items:start">${figs.map((f, i) =>
      `<figure class="figure rise"><button type="button" class="diag loading" data-fig="${i}" aria-label="Open diagram full screen">Loading diagram…</button><figcaption>${esc(f.cap || 'Figure')} · <a href="#doc-${esc(f.k)}">${esc(f.doc)}</a></figcaption></figure>`).join('')}</div>` : '') +
      (docs.length ? `<div class="card rise"><h3>Read the design documents</h3><div class="rows" style="margin-top:10px">${docs.map(k => `<div><a href="#doc-${k}">${esc(idx.docs[k].title)}</a></div>`).join('')}</div></div>` : '');
    box.querySelectorAll('[data-fig]').forEach(async slot => {
      const f = figs[+slot.dataset.fig];
      const url = await getImage(f.img, f.mime);
      if (url) showImage(slot, url, f.cap || f.doc); else slot.textContent = 'This figure is not available yet.';
    });
  }

  // ---------- document copies ----------
  // Read-only copies of the project documents, so they can be read on any computer without a
  // Google sign-in. All text is escaped; links go only to other copies, headings in the same copy
  // or web pages (which open in a new tab).
  function linkHtml(u, inner) {
    if (/^#doc-[a-z0-9-]+$/.test(u)) return `<a href="${u}">${inner}</a>`;
    if (u.startsWith('#h:')) return `<a href="#" data-jump="${esc(u.slice(3))}">${inner}</a>`;
    if (/^https?:\/\//i.test(u)) return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${inner} ${extMark(u)}</a>`;
    return inner;
  }
  const runsHtml = runs => (runs || []).map(r => {
    let h = esc(r.x).replace(/\n/g, '<br>');
    if (r.n) return `<sup>${h}</sup>`;
    if (r.c) h = `<code>${h}</code>`;
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.s) h = `<s>${h}</s>`;
    return r.u ? linkHtml(r.u, h) : h;
  }).join('');
  const runsText = runs => (runs || []).map(r => r.x).join('');
  function blocksHtml(blocks) {
    return (blocks || []).map(b => {
      const anchor = b.a ? ` data-anchor="${esc(b.a)}"` : '';
      switch (b.t) {
        case 'h': { const tag = 'h' + Math.min(5, Math.max(2, (b.l || 0) + 1)); return `<${tag}${anchor}>${runsHtml(b.r)}</${tag}>`; }
        case 'tab': return `<h2 class="doc-tab"${anchor}>${esc(b.x)}</h2>`;
        case 'p': return `<p${b.sub ? ' class="sub"' : ''}>${runsHtml(b.r)}</p>`;
        case 'li': return `<div class="li" style="--l:${Number(b.l) || 0}"><span class="mk">${esc(b.m)}</span><span>${runsHtml(b.r)}</span></div>`;
        case 'img': return b.i == null ? '<p class="sub">[A drawing only the original shows]</p>'
          : `<figure class="doc-fig"><button type="button" class="diag loading" data-img="${Number(b.i)}" aria-label="Open image full screen">Loading image…</button></figure>`;
        case 'table': return `<div class="tbl"><table>${(b.rows || []).map(r => `<tr>${r.map(c => `<td>${blocksHtml(c)}</td>`).join('')}</tr>`).join('')}</table></div>`;
        case 'hr': return '<hr>';
        case 'notes': return `<div class="notes"><h4>Notes</h4><ol>${(b.items || []).map(it => `<li>${blocksHtml(it)}</li>`).join('')}</ol></div>`;
        default: return '';
      }
    }).join('');
  }
  // A sheet tab as one card per row, labelled by the header row, so it reads on a phone too.
  // A tab of label and value pairs (two columns at most) reads as plain lines instead. Each tab
  // folds away (the first starts open), since a long tab is thousands of pixels on a phone.
  function sheetHtml(s, i) {
    const rows = (s.rows || []).filter(r => r.some(Boolean));
    const fold = (count, inner) => `<details class="sheet" data-anchor="sheet-${i}"${i === 0 ? ' open' : ''}><summary><h2>${esc(s.title)}</h2><span class="sub">${count}</span></summary>${inner}</details>`;
    if (rows.every(r => r.slice(2).every(v => !v))) {
      return fold(rows.length + ' lines', `<div class="rowcards"><div class="rowcard pairs">${rows.map(r =>
        `<p>${r[0] && r[1] ? `<b>${esc(r[0])}</b> ` : ''}${esc(r[0] && r[1] ? r[1] : r[0] || r[1])}</p>`).join('')}</div></div>`);
    }
    const hi = rows.findIndex(r => r.filter(Boolean).length >= 2);
    const head = hi < 0 ? [] : rows[hi];
    const before = (hi < 0 ? rows : rows.slice(0, hi)).map(r => `<p class="sub">${esc(r.filter(Boolean).join(' · '))}</p>`).join('');
    const body = hi < 0 ? [] : rows.slice(hi + 1);
    const cards = body.map(r => `<div class="rowcard"><b>${esc(r[0] || '')}</b>${r.slice(1).map((v, j) =>
      v ? `<div><span>${esc(head[j + 1] || '')}</span>${esc(v)}</div>` : '').join('')}</div>`).join('');
    return fold(body.length + ' rows', `${before}<div class="rowcards">${cards}</div>`);
  }

  function pageDoc(route) {
    return head(crumb(route, 'Document'), 'Opening the document…', '') + `<div class="wrap" id="docPage"></div>`;
  }
  async function afterDoc(root, route) {
    const d = await getCopy(route.slice(4));
    if (location.hash.slice(1) !== route || !$('#docPage', root)) return;
    const built = d && parseDate(d.builtAt);
    const original = d && /^https:\/\/docs\.google\.com\//.test(d.original || '') ? `<a href="${esc(d.original)}" target="_blank" rel="noopener">Open the original ${extMark(d.original)}</a>` : '';
    if (!d) {
      $('.page-head h1', root).textContent = 'Not available yet';
      $('#docPage', root).innerHTML = '<div class="card"><p class="empty">This document has no copy on the site yet. Copies appear within about 15 minutes of a document being added.</p></div>';
      return;
    }
    document.title = d.title + ' · POA';
    $('.page-head h1', root).textContent = d.title;
    $('.page-head', root).insertAdjacentHTML('beforeend', `<p class="lead">Read-only copy${built ? ', updated ' + esc(fmtLong(built)) + ', ' + esc(fmtTime(built)) : ''}. It changes when the original does.</p>${original ? `<div class="sub" style="margin-top:6px">${original}</div>` : ''}`);
    let body, toc;
    if (d.kind === 'sheet') {
      toc = (d.sheets || []).map((s, i) => ({ a: 'sheet-' + i, text: s.title, l: 1 }));
      body = `<input class="search" id="rowFilter" type="search" placeholder="Filter rows" aria-label="Filter rows">` + (d.sheets || []).map(sheetHtml).join('');
    } else {
      // Top-level headings get anchors for the contents list and for links between headings.
      (d.blocks || []).forEach((b, i) => { if (b.t === 'h' || b.t === 'tab') b.a = b.id || 's' + i; });
      toc = (d.blocks || []).filter(b => b.t === 'tab' || (b.t === 'h' && b.l <= 2)).map(b => ({ a: b.a, text: b.t === 'tab' ? b.x : runsText(b.r), l: b.t === 'tab' ? 0 : Math.max(1, b.l) }));
      body = blocksHtml(d.blocks);
    }
    const contents = toc.length >= 4 ? `<details class="more toc"><summary>Contents</summary><div>${toc.map(t => `<a href="#" data-jump="${esc(t.a)}" style="--l:${t.l}">${esc(t.text)}</a>`).join('')}</div></details>` : '';
    $('#docPage', root).innerHTML = `${contents}<div class="card doc rise"><div class="prose doc-body">${body}</div></div>`;
    root.querySelectorAll('[data-img]').forEach(async slot => {
      const im = (d.images || [])[+slot.dataset.img];
      const url = im && im.id && await getImage(im.id, im.mime);
      if (url) showImage(slot, url, im.alt || d.title); else slot.outerHTML = '<p class="sub">[An image only the original shows]</p>';
    });
    const filter = $('#rowFilter', root);
    if (filter) filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      root.querySelectorAll('.rowcard').forEach(c => { c.hidden = !!q && !c.textContent.toLowerCase().includes(q); });
      if (q) root.querySelectorAll('details.sheet').forEach(t => { t.open = !!t.querySelector('.rowcard:not([hidden])'); });
    });
  }

  function pageTeam() {
    const who = section('team', 'Who does what');
    const agree = section('team', 'The working agreement');
    return head(crumb('team', 'Team and operating model'), 'Team and operating model', 'Vince decides. AI agents deliver, each in a named role, and each keeps its own records current.') +
      `<div class="wrap"><div class="roles">${who.items.map((it, i) => {
        const m = it.label.match(/^(.+?)\s*\((.+)\)$/);
        return `<div class="role rise" style="animation-delay:${i * 40}ms"><span class="k">${esc(m ? m[2] : '')}</span><b>${esc(m ? m[1] : it.label)}</b><span>${esc(it.text)}</span></div>`;
      }).join('')}</div>
      <div class="card rise"><h3>The working agreement</h3><div class="take" style="margin-top:10px">${agree.items.map((it, i) => `<div><i>${i + 1}</i>${esc(it.label ? it.label + ': ' + it.text : it.text)}</div>`).join('')}</div></div>
      ${govBlock('framework')}</div>`;
  }

  function pageGovernance() {
    const gs = S.feed.governance || [];
    return head(crumb('governance', 'Governance documents'), 'Governance documents', 'The documents that govern the project, with their approved summaries.') +
      `<div class="wrap">${gs.map((g, i) => `<div class="card rise" style="animation-delay:${i * 40}ms"><h3>${esc(g.title)}</h3><div class="sub">${govNote(g)}</div>
        ${g.takeaways.length ? `<div class="take" style="margin-top:12px">${g.takeaways.map((t, j) => `<div><i>${j + 1}</i>${esc(t)}</div>`).join('')}</div>` : ''}
        <details class="more" style="margin-top:12px"><summary>Read the approved summary</summary><div class="prose">${String(g.summary || '').split(/\n+/).filter(Boolean).map(l => (l.length < 70 && !/[.:;]$/.test(l)) ? `<h4>${esc(l)}</h4>` : `<p>${esc(l)}</p>`).join('')}</div></details></div>`).join('')}</div>`;
  }

  function pageAbout() {
    const a = content('about');
    return head('<b>About</b>', 'About this website', '') + `<div class="wrap"><div class="card rise"><div class="prose">${a.map(s => paras(s.paras)).join('')}</div></div></div>`;
  }

  const ROUTES = {
    home: [pageHome, afterHome, 'Status'],
    roadmap: [pageRoadmap, afterRoadmap, 'Schedule'], decisions: [pageDecisions, afterDecisions, 'Decisions'],
    trends: [pageTrends, afterTrends, 'Progress trends'], health: [pageHealth, afterHealth, 'Data health'], goal: [pageGoal, null, 'The goal'],
    missions: [pageMissions, null, 'Missions'], lifecycle: [pageLifecycle, null, 'Delivery lifecycle'], testing: [pageTesting, afterTesting, 'Testing'],
    architecture: [pageArchitecture, afterArchitecture, 'Architecture'], team: [pageTeam, null, 'Team'], governance: [pageGovernance, null, 'Governance'], about: [pageAbout, null, 'About'],
  };

  // The waiting and workstreams lists live on the Status page; their old addresses open it at that section.
  const SECTIONS = { status: '', glance: 'sec-glance', waiting: 'sec-waiting', workstreams: 'sec-workstreams' };

  function render() {
    let route = (location.hash || '#home').slice(1) || 'home';
    const target = SECTIONS[route];
    if (target != null) route = 'home';
    disposeCharts();
    closeDrop();
    const view = $('#view');
    let title = 'Status';
    try {
      if (route.startsWith('ws-')) {
        view.innerHTML = pageWorkstream(route);
        afterWorkstream(view, route);
        const w = workstreams().find(x => slug(x.id) === route);
        title = w ? w.name : 'Workstream';
      } else if (/^doc-[a-z0-9-]+$/.test(route)) {
        view.innerHTML = pageDoc(route);
        afterDoc(view, route);
        title = 'Document';
      } else {
        const r = ROUTES[route] || ROUTES.home;
        view.innerHTML = r[0]();
        if (r[1]) r[1](view);
        title = r[2];
      }
      fillDiagrams(view);
      countUp(view);
    } catch (e) {
      view.innerHTML = `<div class="wrap"><div class="card">Something went wrong showing this page. <a href="#home">Back to Status</a></div></div>`;
      console.error(e);
    }
    // After the hashchange handler's scroll to the top.
    if (target) setTimeout(() => { const el = document.getElementById(target); if (el) el.scrollIntoView({ block: 'start' }); }, 0);
    document.title = title + ' · POA';
    markMenu(route);
    const needs = workstreams().filter(w => w.waiting && !w.closed).length;
    $('#waitCount').textContent = needs;
    const built = parseDate(S.bundle.builtAt);
    $('#builtAt').textContent = built ? 'Project data updated ' + fmtLong(built) + ', ' + fmtTime(built) : '';
  }

  window.addEventListener('hashchange', () => { if (S.feed) { render(); window.scrollTo(0, 0); } });
  // Contents entries and links between headings scroll within the page instead of changing route.
  $('#view').addEventListener('click', ev => {
    const a = ev.target.closest('[data-jump]');
    if (!a) return;
    ev.preventDefault();
    const target = [...$('#view').querySelectorAll('[data-anchor]')].find(el => el.dataset.anchor === a.dataset.jump);
    if (target && target.tagName === 'DETAILS') target.open = true;
    if (target) target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });

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
    try { await loadData(); S.copies = null; S.copy = {}; render(); } catch {}
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
