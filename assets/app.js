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
  // A lane's chip says whether its stages are on schedule (Vince, 2026-11-02). A lane the schedule doesn't
  // cover shows no schedule status. What waits on Vince is only on his pending actions list (Vince,
  // 2026-11-23), so the lanes' own waiting fields are no longer shown.
  const workstreams = () => (S.feed.workstreams || []).map(w => {
    const updated = parseDate(w.updated);
    const closed = /closed|complete/i.test(w.status || '');
    const sched = closed ? null : laneState(w.id);
    const status = closed ? 'done' : sched ? sched.s : 'none';
    return { ...w, name: w.name || w.id, updatedDate: updated, closed, status, sched };
  });
  const STATUS_LABEL = { done: 'Done', moved: 'Moved', track: 'On track', risk: 'At risk', behind: 'Behind', none: 'No schedule' };
  const chip = st => `<span class="chip ${st}">${STATUS_LABEL[st]}</span>`;
  // A lane the schedule doesn't cover shows no chip at all.
  const wsChip = w => w.status === 'none' ? '' : chip(w.status);
  // Only the owner's role: the owner text up to its first colon, comma or opening bracket.
  const ownerRole = o => String(o || '').split(/[:,(]/)[0].trim();
  const slug = id => 'ws-' + String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const content = page => (S.feed.content && S.feed.content[page]) || [];
  const section = (page, title) => content(page).find(s => s.title.toLowerCase() === title.toLowerCase()) || { title: '', paras: [], items: [] };
  const governance = key => (S.feed.governance || []).find(g => g.key === key);
  const milestones = () => (S.feed.milestones || []).map(m => ({ ...m, targetD: parseDate(m.target), actualD: parseDate(m.actual), startD: parseDate(m.planStart) }));
  const decisions = () => (S.feed.decisions || []).map(d => ({ ...d, dateD: parseDate(d.date) })).filter(d => d.dateD).sort((a, b) => b.dateD - a.dateD);
  // The program schedule (Registry Schedule tab): one row per stage, release or milestone, grouped by mission
  // or increment in delivery order. Retired rows are left out. Agreed start and finish are the dates the Project
  // Director last agreed (first set 2026-11-13); status is measured against them, so a moved forecast can't hide a slip.
  const SCHED_COLOR = { '0': '--steel', '1A': '--violet', '1B': '--purple', '2': '--green', '3': '--sky', '4': '--orange', all: '--teal' };
  const sColor = k => css(SCHED_COLOR[k] || '--teal');
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const schedule = () => ((S.feed.schedule && S.feed.schedule.rows) || []).filter(r => !/retired/i.test(r.status))
    .map(r => ({ ...r, startD: parseDate(r.start), finishD: parseDate(r.finish), agreedStartD: parseDate(r.agreedStart), agreedFinishD: parseDate(r.agreedFinish), done: /complete/i.test(r.status) }));
  const isLate = r => !r.done && !!r.finishD && r.finishD < startOfToday();
  // Days an open row runs past its agreed finish: to its forecast finish, or to today once that has passed.
  const agreedSlip = r => {
    if (r.done || !r.agreedFinishD) return 0;
    const today = startOfToday(), end = r.finishD && r.finishD > today ? r.finishD : today;
    return Math.max(0, Math.round((end - r.agreedFinishD) / DAY));
  };
  // Under its group's heading a stage drops a prefix the heading already says: "Food: build" reads "Build".
  const shortItem = (item, grp) => {
    const m = String(item).match(/^([^:]{1,40}):\s+(.+)$/);
    const p = m && m[1].toLowerCase(), g = String(grp).toLowerCase();
    return m && (g.includes(p) || g.includes(p.replace(/s$/, ''))) ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : item;
  };
  // The lane whose progress counts the coaching questions (the raw feed, so the schedule status can use it).
  const questionLane = () => (S.feed.workstreams || []).find(x => x.progress && /question/i.test(x.progress.measure || ''));

  // ---------- for your awareness ----------
  // What the Project Director wants Vince to know without asking him anything (Vince, 2026-11-23), one
  // line each, from the Registry's Awareness tab. The Status page shows only the warnings; the full list
  // shows every line from the last three days in Eastern time, today included, newest first, grouped by
  // day. A line whose level reads Red stays at the top whatever its age, and stops showing as red once its
  // level no longer reads Red: the Project Director ends a red by changing its level and adding a line
  // (2026-11-27). The feed sends every red row whatever its age. Older lines stay in the Registry and
  // simply stop showing. The page cuts the list, not the feed, so a line leaves on time
  // even when the data was built an hour earlier. Nothing is cut: a line
  // shows its first sentence and opens on a tap for the rest.
  const ET = 'America/New_York', AWARE_DAYS = 3;
  const ID_RE = /\b(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]{0,7}-[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,6})?\b/g;
  const etDay = d => d.toLocaleDateString('en-CA', { timeZone: ET });
  const etTime = d => d.toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });
  const dayShift = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  // A wall-clock time without a zone is read as Eastern.
  const etWall = (y, mo, d, h, mi, s) => {
    let t = Date.UTC(y, mo - 1, d, h, mi, s);
    for (let i = 0; i < 2; i++) {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ET, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(t)).map(x => [x.type, +x.value]));
      t -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Date.UTC(y, mo - 1, d, h, mi, s);
    }
    return new Date(t);
  };
  const WHEN = '(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?';
  const WHEN_RE = new RegExp('^' + WHEN + '$');
  const LINE_RE = new RegExp('^(' + WHEN.replace(/\((?!\?)/g, '(?:') + ')\\s*:\\s*(.+)$');
  const whenOf = s => {
    const m = String(s || '').trim().match(WHEN_RE);
    if (!m) return null;
    const [, y, mo, d, h, mi, sec = '0', z] = m;
    const t = z ? new Date(`${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}:${sec.padStart(2, '0')}${z === 'Z' ? 'Z' : z.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2')}`) : etWall(+y, +mo, +d, +h, +mi, +sec);
    return isNaN(t) ? null : t;
  };
  const awareText = (s, max = Infinity) => {
    let t = String(s == null ? '' : s).replace(ID_RE, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trim() + '…' : t;
  };
  // A text's first sentence and the rest: [first, rest]. A sentence ends at . ! or ? followed by a space
  // and a capital, a digit or an opening quote, so "1.5 kg" and "e.g. food" don't split.
  const splitFirst = s => {
    const m = String(s || '').match(/^(.+?[.!?]["'”’)]?)\s+(?=["'“‘(]?[A-Z0-9])([\s\S]+)$/);
    return m ? [m[1], m[2]] : [String(s || ''), ''];
  };
  // A short title: the first sentence without its full stop, cut at a word boundary near 70 characters.
  const shortTitle = (s, max = 70) => {
    let t = splitFirst(s)[0].replace(/\.$/, '');
    if (t.length > max + 6) { const cut = t.slice(0, max + 1), sp = cut.lastIndexOf(' '); t = (sp > max / 2 ? cut.slice(0, sp) : cut.slice(0, max)).replace(/\s+\S$/, '').replace(/[\s,;:–—-]+$/, '') + '…'; }
    return t;
  };
  // A warning (Project Director's document, Vince's two lists): amber, something went wrong or is at risk and
  // it is in hand; red, harm done or likely to something of his that is hard to put right. The Registry's
  // Level column says which; a line may instead start "Amber: " or "Red: ", which is taken off the text.
  // "Red:" anywhere else in a line leaves it plain. Lines stay newest first whatever their level.
  const AWARE_LEVEL = { amber: 'Warning', red: 'Urgent' };
  const awareLevel = (level, item) => {
    const lv = String(level || '').trim().toLowerCase();
    if (AWARE_LEVEL[lv]) return { level: lv, text: item };
    const m = String(item == null ? '' : item).match(/^\s*(amber|red)\s*:\s*/i);
    return m ? { level: m[1].toLowerCase(), text: String(item).slice(m[0].length) } : { level: '', text: item };
  };
  // Whole days between two Eastern days ("2026-11-25").
  const dayGap = (later, earlier) => Math.round((Date.parse(later + 'T00:00:00Z') - Date.parse(earlier + 'T00:00:00Z')) / DAY);
  // { ready, today, open: [open reds, any age], lines: [the rest within the last three Eastern days] }, each
  // { at, day, time, item, level, open, age, mission }, newest first.
  function awareness(now = new Date()) {
    const a = S.feed.awareness;
    let raw = null, fromFeed = false;
    if (a && a.status === 'ok') { fromFeed = true; raw = (a.lines || []).map(l => ({ when: l.when, item: l.item, level: l.level, mission: l.mission })); }
    else {
      const sec = content('awareness').find(s => s.title.toLowerCase() === 'lines');
      if (sec) raw = sec.items.map(it => {
        // The feed splits a bullet at its first colon, inside the time, so the two halves are joined again.
        const m = (it.label ? it.label + ':' + it.text : it.text).match(LINE_RE);
        return m ? { when: m[1], item: m[2] } : null;
      }).filter(Boolean);
    }
    if (!raw) return { ready: false, today: etDay(now), open: [], lines: [] };
    const today = etDay(now), first = dayShift(today, 1 - AWARE_DAYS);
    const all = raw.map(l => {
      const { level, text } = awareLevel(l.level, l.item);
      const at = whenOf(l.when), item = awareText(text);
      if (!at || !item) return null;
      const day = etDay(at);
      return { at, day, time: etTime(at), item, level, mission: l.mission || '', age: Math.max(0, dayGap(today, day)),
        open: fromFeed && level === 'red' };
    }).filter(Boolean).sort((p, q) => q.at - p.at);
    return { ready: true, today, open: all.filter(l => l.open), lines: all.filter(l => !l.open && l.day >= first) };
  }
  // A day's name: Today, Yesterday, its weekday within the week, else its date.
  const dayFmt = (day, o) => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  const awareDay = (day, today, long) => day === today ? 'Today' : day === dayShift(today, -1) ? 'Yesterday'
    : dayGap(today, day) < 7 && dayGap(today, day) > 0 ? dayFmt(day, { weekday: long ? 'long' : 'short' }) : dayFmt(day, { month: 'short', day: 'numeric' });
  const awareDate = day => dayFmt(day, { month: 'long', day: 'numeric' });
  const AWARE_EMPTY = 'Nothing new in the last three days.';
  const AWARE_OFF = 'Not connected yet. The lines appear here as soon as the site can read them.';
  // One line: the time (and day), a warning's label (and how long an open red has been open), the first
  // sentence, and the rest on a tap. A warning gets a coloured left edge and its label, not colour alone.
  function awareLine(l, today, withDay) {
    const [first, rest] = splitFirst(l.item);
    const openFor = l.open ? ' · ' + (l.age ? `open ${l.age} ${l.age === 1 ? 'day' : 'days'}` : 'opened today') : '';
    const lvl = l.level ? `<span class="lvl">${AWARE_LEVEL[l.level]}${openFor}</span>` : '';
    const row = `<span class="when">${withDay ? esc(awareDay(l.day, today, true)) + '<br>' : ''}${esc(l.time)}</span><span class="aw-t">${lvl}${esc(first)}</span>`;
    const cls = 'aw' + (l.level ? ' lvl-' + l.level : '');
    return rest ? `<details class="${cls}"><summary>${row}<span class="caret">&#9656;</span></summary><p>${esc(rest)}</p></details>`
      : `<div class="${cls}"><div class="aw-row">${row}</div></div>`;
  }
  // The Status page's card shows warnings only: open reds first, then the warnings of the last three days,
  // newest first; every open red and up to three lines in all show, the rest behind See all. With no
  // warning it is one slim row to the full list.
  function awarenessCard(now) {
    const A = awareness(now), total = A.open.length + A.lines.length;
    const warns = A.open.concat(A.lines.filter(l => l.level)), top = Math.max(3, A.open.length);
    const all = `All ${total} ${total === 1 ? 'line' : 'lines'}&nbsp;&rsaquo;`;
    if (!A.ready || !warns.length) return `<a class="card slim rise" id="sec-awareness" href="#awareness"><span><b>For your awareness</b><small>${!A.ready ? 'Not connected yet' : 'No warnings in the last three days'}</small></span><span class="go">${A.ready ? all : 'Open&nbsp;&rsaquo;'}</span></a>`;
    return `<div class="card rise" id="sec-awareness"><div class="card-h"><h3>For your awareness</h3><a class="go-link" href="#awareness">${all}</a></div>
      <div class="sub">${A.open.length ? 'A red stays until it’s resolved. ' : ''}Warnings from the last three days, newest first.</div>${warns.slice(0, top).map(l => awareLine(l, A.today, true)).join('')}
      ${warns.length > top ? `<details class="fold"><summary>See all ${warns.length} warnings</summary>${warns.slice(top).map(l => awareLine(l, A.today, true)).join('')}</details>` : ''}</div>`;
  }
  function pageAwareness(now) {
    const A = awareness(now);
    const lead = section('awareness', 'Intro').paras[0] || 'A rolling three days: today and the two days before it, newest first. Nothing here needs an answer.';
    const warn = A.lines.filter(l => l.level).length + A.open.length;
    const chips = A.ready ? `<div class="aw-filters" role="group" aria-label="Show">${[['all', 'All ' + (A.lines.length + A.open.length)], ['warn', 'Warnings ' + warn]]
      .map(([k, t], i) => `<button type="button" data-aw="${k}" aria-pressed="${i === 0}">${esc(t)}</button>`).join('')}</div>` : '';
    const body = !A.ready ? `<div class="card rise"><p class="empty">${AWARE_OFF}</p></div>`
      : `${A.open.length ? `<div class="card rise"><h3>Still open</h3><div class="sub">A red stays here until it’s resolved.</div>${A.open.map(l => awareLine(l, A.today, true)).join('')}</div>` : ''}
        <div class="card rise" id="awList">${awareDays(A, false)}</div>`;
    return head(crumb('awareness', 'For your awareness'), 'For your awareness', lead) + `<div class="wrap aware-page">${chips}${body}<p class="sub"><a href="#home">&lsaquo; Back to Status</a></p></div>`;
  }
  // The rolling three days, grouped by day, all lines or only the warnings.
  function awareDays(A, warnOnly) {
    const days = [];
    A.lines.filter(l => !warnOnly || l.level).forEach(l => { const g = days[days.length - 1]; if (g && g.day === l.day) g.lines.push(l); else days.push({ day: l.day, lines: [l] }); });
    return days.length ? days.map(g => `<div class="day-h">${esc(awareDay(g.day, A.today, true))} <span class="sub">${esc(awareDate(g.day))} · ${g.lines.length} ${g.lines.length === 1 ? 'line' : 'lines'}</span></div>${g.lines.map(l => awareLine(l, A.today, false)).join('')}`).join('')
      : `<p class="empty">${warnOnly ? 'No warnings in the last three days.' : AWARE_EMPTY}</p>`;
  }
  function afterAwareness(root) {
    const A = awareness(), list = $('#awList', root);
    root.querySelectorAll('[data-aw]').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('[data-aw]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      if (list) list.innerHTML = awareDays(A, b.dataset.aw === 'warn');
    }));
  }

  // ---------- your pending actions ----------
  // Every action waiting on Vince, in the Project Director's order, each with what it waits on (Vince,
  // 2026-11-23: "I need to be able to go on the website to see what's up next"). Kept by the Project
  // Director only, in the Registry's Pending actions tab (Order | Action | How long | State | Waits on).
  // Ready actions come first and stand out, then the
  // ones that wait, each in order. The Status page shows the first three; the rest are one tap away
  // (2026-11-25). The feed may also send a short title, a due text and a mission; without a title, the
  // title is the action's first sentence. Nothing is cut: the whole action opens on a tap.
  const PEND_TOP = 3;
  const pendState = (state, waitsOn) => /^\s*ready/i.test(state || '') ? 'ready' : /^\s*wait/i.test(state || '') ? 'waits' : String(waitsOn || '').trim() ? 'waits' : 'ready';
  // Minutes from a how-long text: "About 10 min", "1 hour", "20 to 30 minutes", "a few minutes".
  const minutesOf = s => {
    const t = String(s || '').toLowerCase();
    const m = t.match(/(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(hours?|hrs?|h\b|minutes?|mins?|m\b)/);
    if (m) { const n = m[2] ? (+m[1] + +m[2]) / 2 : +m[1]; return /^h/.test(m[3]) ? n * 60 : n; }
    return /half an hour/.test(t) ? 30 : /\ban hour\b/.test(t) ? 60 : /few min/.test(t) ? 5 : /\ba minute\b/.test(t) ? 1 : 0;
  };
  // { ready, actions: [{ order, title, action, howLong, due, mission, state, waitsOn }] }, ready ones first.
  function pending() {
    const p = S.feed.pending;
    let raw = null;
    if (p && p.status === 'ok') raw = p.actions || [];
    else {
      const sec = content('pending').find(x => x.title.toLowerCase() === 'lines');
      // The feed splits a bullet at its first colon when two or more characters come before it, so a
      // two-digit order arrives as the label: the halves are joined again.
      if (sec) raw = sec.items.map(it => {
        const m = (it.label ? it.label + ': ' + it.text : it.text).match(/^\s*(\d+(?:\.\d+)?)\s*[:.)]\s*(.+)$/);
        if (!m) return null;
        const [action, howLong, state, waitsOn] = m[2].split('|').map(x => x.trim());
        return { order: m[1], action, howLong, state, waitsOn: String(waitsOn || '').replace(/^waits on\s*:?\s*/i, '') };
      }).filter(Boolean);
    }
    if (!raw) return { ready: false, actions: [] };
    const num = o => { const n = parseFloat(o); return isNaN(n) ? Infinity : n; };
    const actions = raw.map((a, i) => {
      const action = awareText(a.action), title = awareText(a.title, 90);
      return { i, order: num(a.order), action, title: title || shortTitle(action), howLong: awareText(a.howLong, 40), due: awareText(a.due, 40),
        mission: a.mission || '', waitsOn: awareText(a.waitsOn, 200), state: pendState(a.state, a.waitsOn) };
    }).filter(a => a.action)
      .sort((x, y) => (x.state === y.state ? 0 : x.state === 'ready' ? -1 : 1) || (x.order === y.order ? 0 : x.order < y.order ? -1 : 1) || x.i - y.i);
    return { ready: true, actions };
  }
  const PEND_EMPTY = 'Nothing needs you right now.';
  // One action: its number, title, how long and any due text, what a waiting one waits on, and the whole
  // action on a tap (a row whose title is the whole action doesn't open).
  function pendItem(a, n) {
    const meta = [esc(a.howLong), a.due ? `<span class="due">${esc(a.due)}</span>` : ''].filter(Boolean).join(' &middot; ');
    const row = `<span class="pn">${n}</span><span class="pt">${esc(a.title)}${meta || (a.state === 'waits' && a.waitsOn) ? `<small>${meta}${meta && a.state === 'waits' && a.waitsOn ? '<br>' : ''}${a.state === 'waits' && a.waitsOn ? 'Waits on: ' + esc(a.waitsOn) : ''}</small>` : ''}</span>`;
    const same = a.title.replace(/[.…]$/, '') === a.action.replace(/\.$/, '');
    return `<li class="${a.state}">${same ? `<div class="prow">${row}</div>` : `<details><summary>${row}<span class="caret">&#9656;</span></summary><p>${esc(a.action)}</p></details>`}</li>`;
  }
  // Needs you: the first three in order, then See all for the rest, with the ready ones' time in the header.
  function pendingCard() {
    const P = pending(), list = P.actions, ready = list.filter(a => a.state === 'ready');
    const mins = Math.round(ready.reduce((n, a) => n + minutesOf(a.howLong), 0) / 5) * 5;
    const tag = !list.length ? '' : `<span class="pend-tag">${ready.length} ready${ready.length && mins ? ' &middot; about ' + mins + ' min' : ''}</span>`;
    const body = !P.ready ? `<p class="empty">${AWARE_OFF}</p>` : !list.length ? `<p class="empty">${PEND_EMPTY}</p>`
      : `<ul class="plist">${list.slice(0, PEND_TOP).map((a, i) => pendItem(a, i + 1)).join('')}</ul>` +
        (list.length > PEND_TOP ? `<details class="fold"><summary>See all ${list.length}</summary><ul class="plist">${list.slice(PEND_TOP).map((a, i) => pendItem(a, PEND_TOP + i + 1)).join('')}</ul></details>` : '');
    return `<div class="card rise" id="sec-pending"><div class="card-h"><h3>Needs you</h3>${tag}</div>${body}</div>`;
  }

  // ---------- schedule status ----------
  // Each stage, area and lane is Done, On track, At risk or Behind (Vince, 2026-11-02), against the agreed
  // dates where a row has them (2026-11-13). Behind: a stage is past its finish date or its agreed finish, or
  // is forecast to finish more than a week after the agreed finish. At risk: it is forecast to finish up to a
  // week after the agreed finish; or it should have started (by the earlier of its agreed and forecast start)
  // and hasn't; or it is underway and due within a week with its Jira records still open; or the coaching
  // questions' pace won't finish capture by its date. On track means on schedule, nothing else.
  const SOON = 7;
  const SEVERITY = { done: 0, moved: 0, track: 1, risk: 2, behind: 3 };
  const STATE_COLOR = { done: '--steel', moved: '--steel', track: '--green', risk: '--orange', behind: '--rose' };
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
  // A Jira release shipped in parts ("Capture release 2a: home page and body weight") counts only the areas
  // each part names; a whole release counts every area and card in it.
  const lettered = r => /^Capture release \d+[a-z]\b/i.test(r.item);
  const releaseAreas = r => {
    const b = board(), n = releaseNo(r.item);
    if (!b || !n) return [];
    const all = (b.areas || []).filter(a => (a.releases || []).some(x => releaseNo(x) === n));
    return lettered(r) ? all.filter(a => String(r.item).toLowerCase().includes(areaKey(a.name))) : all;
  };
  const rowReleaseCards = r => {
    const n = releaseNo(r.item);
    return lettered(r) ? releaseAreas(r).flatMap(a => (a.cards || []).filter(c => (c.releases || []).some(x => releaseNo(x) === n))) : releaseCards(n);
  };
  const isTrial = c => /trial|acceptance/i.test(c.name);
  const isOpen = c => c.cat !== 'done';
  // A card that changed status the day the board was set up started there at its real status, so it
  // isn't recently done.
  const movedRecently = c => { const d = parseDate(c.changed), since = parseDate(S.feed.static && S.feed.static.buildBoardSince); return d && daysSince(d) <= SOON && !(since && d <= since); };
  // The Jira records behind a stage: requirement records for a requirements stage, the area's build cards
  // for a build stage (trial cards for a test stage), and every card in a release for a release.
  function stageRecords(r) {
    if (/^requirements$/i.test(r.stage)) { const a = reqArea(r.group); return a ? { list: a.records || [], what: 'requirements still to approve', one: 'requirement still to approve' } : null; }
    if (/^release$/i.test(r.stage)) { const n = releaseNo(r.item); return n && board() ? { list: rowReleaseCards(r), what: 'cards still open', one: 'card still open' } : null; }
    if (/^(build|test)$/i.test(r.stage)) {
      const a = buildArea(r.group);
      if (!a) return null;
      const cards = a.cards || [], trials = cards.filter(isTrial);
      return { list: /^test$/i.test(r.stage) ? (trials.length ? trials : cards) : cards.filter(c => !isTrial(c)), what: 'cards still open', one: 'card still open' };
    }
    return null;
  }
  function rowState(r) {
    if (r.done) return { s: 'done', why: [] };
    if (isLate(r)) return { s: 'behind', why: [`${r.item}: due ${fmtD(r.finishD)}`] };
    const today = startOfToday(), why = [], slipped = agreedSlip(r);
    if (slipped) {
      const t = `${r.item}: agreed ${fmtD(r.agreedFinishD)}, now forecast ${r.finishD ? fmtD(r.finishD) : 'later'}`;
      if (r.agreedFinishD < today || slipped > SOON) return { s: 'behind', why: [t] };
      why.push(t);
    }
    const dueStart = r.agreedStartD && (!r.startD || r.agreedStartD < r.startD) ? r.agreedStartD : r.startD;
    if (!r.milestone && /planned/i.test(r.status) && dueStart && dueStart < today) why.push(`${r.item}: was due to start ${fmtD(dueStart)}`);
    if (r.finishD && r.finishD - today <= SOON * DAY && (!r.startD || r.startD <= today)) {
      const rec = stageRecords(r);
      const n = rec ? rec.list.filter(isOpen).length : 0;
      if (n) why.push(`${r.item}: due ${fmtD(r.finishD)} with ${n} ${n === 1 ? rec.one : rec.what}`);
    }
    const p = isPaceRow(r) ? pace() : null;
    if (p && p.behind) why.push(`${r.item}: ${p.text}`);
    return { s: why.length ? 'risk' : 'track', why };
  }
  // The worst state among the rows; Done only when every row is done.
  function rowsState(rows) {
    if (!rows.length) return null;
    const st = rows.map(rowState);
    return { s: st.reduce((m, x) => SEVERITY[x.s] > SEVERITY[m] ? x.s : m, 'done'), why: st.flatMap(x => x.why) };
  }
  // A group's retired rows: stages no longer needed, each item saying where the work went ("now in the coach's plans").
  const retiredRows = group => ((S.feed.schedule && S.feed.schedule.rows) || []).filter(r => /retired/i.test(r.status) && r.group === group);
  // An area's state. One whose remaining stages are done but some moved elsewhere is Moved, not Done, and says
  // where they went (2026-11-20).
  function areaState(name, rows) {
    const st = rowsState(rows), moved = retiredRows(name);
    return st && st.s === 'done' && moved.length ? { s: 'moved', why: [], moved } : st;
  }
  // The schedule's groups (missions and increments), in delivery order, with their state and Jira records.
  function areas() {
    const groups = [];
    schedule().forEach(r => { let g = groups.find(x => x.name === r.group); if (!g) groups.push(g = { name: r.group, rows: [] }); g.rows.push(r); });
    return groups.map(g => ({ ...g, ...areaState(g.name, g.rows), cards: (buildArea(g.name) || {}).cards || null, req: reqArea(g.name) }));
  }
  // What became of a Moved area's retired stages: "Data contract, build and trials now in the coach's plans".
  function movedLine(a) {
    const items = (a.moved || []).map(r => shortItem(r.item, a.name));
    const parts = items.map(t => t.match(/^(.+?),\s+(now\b.*)$/i));
    if (!parts.length || !parts.every(p => p && p[2] === parts[0][2])) return 'Moved: ' + items.join('; ');
    const heads = parts.map((p, i) => i ? lowerFirst(p[1]) : p[1]);
    return (heads.length > 1 ? heads.slice(0, -1).join(', ') + ' and ' + heads[heads.length - 1] : heads[0]) + ' ' + parts[0][2];
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
  // The audit questions' pace since the feed began reading the analyst's count: answered against the straight
  // line that finishes them by the schedule stage the feed names (the coaching knowledge requirements and
  // design baseline, Project Director 2026-11-25), and, after a week, where the last two weeks' pace leads.
  function isPaceRow(r) {
    const item = (S.feed.static && S.feed.static.coachingPaceItem) || 'coaching knowledge capture';
    return String(r.item || '').toLowerCase().includes(String(item).toLowerCase());
  }
  function pace() {
    const st = S.feed.static || {};
    const start = parseDate(st.coachingPaceStart), w = questionLane();
    const row = schedule().find(isPaceRow);
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
      res.text = res.projected ? `at the last ${span} days’ pace, the audit questions are all answered about ${fmtD(res.projected)}, after ${fmtD(row.finishD)}`
        : `none answered in the last ${span} days, so the audit questions won’t be finished by ${fmtD(row.finishD)}`;
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

  // Audit questions newly answered this week (since Monday), from the daily counts, against Vince's weekly
  // minimum (2026-11-01). It shows from the first full week of the count (Project Director, 2026-11-25), so
  // a part week after the count began isn't shown as falling short.
  function coachingWeek() {
    const min = S.feed.static && S.feed.static.coachingWeeklyMin;
    const w = questionLane();
    const h = (S.feed.history || []).filter(p => w && p[w.id]);
    if (!min || !w || !h.length) return null;
    const now = new Date();
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const key = mon.getFullYear() + '-' + String(mon.getMonth() + 1).padStart(2, '0') + '-' + String(mon.getDate()).padStart(2, '0');
    const from = S.feed.static && S.feed.static.coachingPaceStart;
    if (from && from > key) return null;
    const before = h.filter(p => p.date < key);
    const base = (before.length ? before[before.length - 1] : h[0])[w.id].c;
    return { done: Math.max(0, w.progress.complete - base), min };
  }
  const pColor = w => { const m = (w.progress && w.progress.measure) || ''; return /scope/i.test(m) ? css('--teal') : /question/i.test(m) ? css('--purple') : mColor(w.mission); };
  const measureLabel = m => /scope/i.test(m) ? 'product capabilities fully defined' : /question/i.test(m) ? 'audit questions answered' : String(m || '').toLowerCase();

  // ---------- menus ----------
  // Status (the home page and its detail pages), then Governance, Requirements and design, and Testing
  // from the encrypted feed (Vince, 2026-10-27).
  const MENU = [
    { key: 'status', label: 'Status', items: [
      { href: '#home', label: 'Status overview', sub: 'Waiting on you, progress and what’s next', ico: '&#8962;', c: '--teal' },
      { href: '#pending', label: 'Your pending actions', sub: 'What needs you, and what each waits on', ico: '&#10148;', c: '--amber' },
      { href: '#awareness', label: 'For your awareness', sub: 'What’s new in the last three days', ico: '&#9673;', c: '--amber' },
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
    addMissionMenus();
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

  // The Schedule page's chart, drawn in plain HTML and CSS so it fits a phone (2026-11-25). "12 weeks" (the
  // default at every width) is 28 days before today to 56 after, with a line for each area not finished that
  // has work in that window; "Whole program" is every area from the first start to the last finish. One bar
  // per stage: done steel, under way in its state's colour, planned a dashed outline (orange or rose when it
  // is at risk or behind). Milestones are diamonds: solid at the forecast (both ends of a window), hollow at the
  // target. Every bar and diamond is a button whose name, dates and state show in the line under the chart.
  const SCHED_BACK = 28, SCHED_AHEAD = 56;
  const schedItems = (a, ms) => {
    const out = [];
    a.rows.forEach(r => {
      const name = shortItem(r.item, a.name), st = rowState(r).s, word = STATUS_LABEL[st].toLowerCase();
      if (r.milestone) {
        const m = ms.get(r.milestone), tgt = m && m.targetD;
        const span = r.startD && r.finishD && r.finishD - r.startD > DAY;
        const when = r.done ? 'done' + (r.finishD ? ' ' + fmtD(r.finishD) : '') : r.startD ? 'forecast ' + (span ? fmt(r.startD) + ' to ' + fmtD(r.finishD) : fmtD(r.startD)) : 'no forecast yet';
        const tip = `${a.name}: ${name}, ${when}${tgt ? ', target ' + fmtD(tgt) : ''}${r.done ? '' : ', ' + word}`;
        if (r.done && r.finishD) out.push({ at: r.finishD, cls: 'f done', tip });
        else if (!r.done && r.startD) { out.push({ at: r.startD, cls: 'f ' + st, tip }); if (span) out.push({ at: r.finishD, cls: 'f ' + st, tip }); }
        if (tgt && !(r.done && r.finishD && Math.abs(tgt - r.finishD) <= DAY)) out.push({ at: tgt, cls: 't', tip });
      } else if (r.startD && r.finishD) {
        const k = r.done ? 'done' : /in progress/i.test(r.status) ? 'now' : 'plan';
        const label = k === 'done' ? 'done' : k === 'now' ? word : st === 'track' ? 'planned' : 'planned, ' + word;
        out.push({ from: r.startD, to: new Date(+r.finishD + DAY), cls: k === 'done' ? 'done' : k + ' ' + st, tip: `${a.name}: ${name}, ${fmt(r.startD)} to ${fmtD(r.finishD)}${agreedSlip(r) ? ' (agreed ' + fmtD(r.agreedFinishD) + ')' : ''}, ${label}` });
      }
    });
    return out;
  };
  function schedGantt(win) {
    const today = startOfToday(), ms = new Map(milestones().map(m => [m.id, m]));
    const finished = a => a.s === 'done' || a.s === 'moved';
    const worst = (x, y) => SEVERITY[y.a.s] - SEVERITY[x.a.s];
    const all = areas().map(a => ({ a, xs: schedItems(a, ms) })).filter(g => g.xs.length);
    const inside = (x, f, t) => x.from ? x.to > f && x.from <= t : x.at >= f && x.at <= t;
    let from, to, list;
    if (win === 'all') {
      list = all.filter(g => finished(g.a)).concat(all.filter(g => !finished(g.a)).sort(worst));
      const times = all.flatMap(g => g.xs.flatMap(x => x.from ? [+x.from, +x.to] : [+x.at]));
      if (!times.length) return '<p class="empty">No dated stages yet.</p>';
      const lo = Math.min(...times, +today), hi = Math.max(...times, +today), pad = (hi - lo) * 0.015;
      from = new Date(lo - pad); to = new Date(hi + pad);
    } else {
      from = new Date(+today - SCHED_BACK * DAY); to = new Date(+today + SCHED_AHEAD * DAY);
      list = all.filter(g => !finished(g.a) && g.xs.some(x => inside(x, from, to))).sort(worst);
    }
    if (!list.length) return '<p class="empty">No area has work in these 12 weeks.</p>';
    const pct = d => (d - from) / (to - from) * 100, now = pct(today);
    const ticks = [];
    if (win === 'all') {
      const months = [];
      for (let m = new Date(from.getFullYear(), from.getMonth() + 1, 1); m <= to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) months.push(m);
      // Every month on a wide screen; on a phone every other one (the "alt" ones hide). The first label of each
      // year a phone shows, and each January, carry the year: "Jun ’26 … Dec, Jan ’27, Feb ’27 …".
      const alt = months.length > 8;
      let year = null;
      months.forEach((m, i) => {
        const shown = !alt || i % 2 === 0, y = m.getFullYear();
        const withYear = m.getMonth() === 0 || (shown && y !== year);
        if (shown) year = y;
        ticks.push({ at: pct(m), label: fmt(m, { month: 'short' }) + (withYear ? ' ’' + String(y).slice(2) : ''), edge: alt && !shown ? 'alt' : '' });
      });
    } else for (let n = -SCHED_BACK; n <= SCHED_AHEAD; n += 14) ticks.push({ at: pct(new Date(+today + n * DAY)), label: n && n % 28 === 0 ? fmt(new Date(+today + n * DAY)) : '', edge: n === -SCHED_BACK ? 'first' : n === SCHED_AHEAD ? 'last' : '' });
    // Labels keep clear of the Today label: about 40px either side of it.
    const clear = window.innerWidth < 700 ? 16 : 6;
    ticks.forEach(t => { if (Math.abs(t.at - now) < clear) t.label = ''; });
    const at = p => `left:${p.toFixed(2)}%`;
    const head = ticks.filter(t => t.label).map(t => `<span class="${t.edge}" style="${at(t.at)}">${esc(t.label)}</span>`).join('') + `<span class="today" style="${at(now)}">Today</span>`;
    const grid = ticks.map(t => `<i style="${at(t.at)}"></i>`).join('') + `<i class="today" style="${at(now)}"></i>`;
    const btn = (cls, style, tip) => `<button type="button" class="${cls}" style="${style}" data-tip="${esc(tip)}" aria-label="${esc(tip)}"></button>`;
    const rows = list.map(g => {
      const xs = g.xs.filter(x => inside(x, from, to));
      const bars = xs.filter(x => x.from).map(x => { const l = Math.max(0, pct(x.from)), r = Math.min(100, pct(x.to)); return btn('g-bar ' + x.cls, `${at(l)};width:${Math.max(1.6, r - l).toFixed(2)}%`, x.tip); });
      // Targets first, so a forecast diamond on the same day sits on top.
      const marks = xs.filter(x => !x.from).sort((p, q) => (p.cls === 't' ? 0 : 1) - (q.cls === 't' ? 0 : 1)).map(x => btn('g-ms ' + x.cls, at(pct(x.at)), x.tip));
      return `<div class="g-row"><div class="g-name">${esc(g.a.name)}</div><div class="g-track">${bars.join('')}${marks.join('')}</div></div>`;
    }).join('');
    return `<div class="sgantt"><div class="g-head"><span></span><div class="g-ticks">${head}</div></div><div class="g-body"><div class="g-grid">${grid}</div>${rows}</div></div>
      <p class="g-tip" id="gtip" aria-live="polite">Tap a bar for its stage and dates.</p>
      <div class="sched-legend"><span><i style="background:var(--steel)"></i>Done</span><span><i style="background:var(--green)"></i>On track</span><span><i style="background:var(--orange)"></i>At risk</span><span><i style="background:var(--rose)"></i>Behind</span><span><i class="pl"></i>Planned</span><span>&#9670; milestone forecast or done &middot; &#9671; target</span></div>`;
  }
  // The chart card's inside: the switch, then the chart for the chosen window.
  function schedCardBody() {
    const all = S.schedWin === 'all';
    return `<div class="sched-h"><h3>${all ? 'The whole program' : 'The 12 weeks around today'}</h3>
      <span class="seg" role="group" aria-label="Chart range"><button type="button" data-win="12" aria-pressed="${!all}">12 weeks</button><button type="button" data-win="all" aria-pressed="${all}">Whole program</button></span></div>
      <div class="sub">${all ? 'Every area from the first stage to the last.' : 'Only the areas with work in this window. One line per area, one bar per stage.'}</div>${schedGantt(S.schedWin)}`;
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
      const st = areaState(g.label, g.rows).s;
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
  // How long ago the project data was built: "Updated 12 min ago", "Updated 3 hours ago", else its date.
  function updatedAgo() {
    const b = parseDate(S.bundle && S.bundle.builtAt);
    if (!b) return '';
    const m = Math.max(0, Math.floor((Date.now() - b) / 60000));
    if (m < 1) return 'Updated just now';
    if (m < 60) return `Updated ${m} min ago`;
    if (m < 1440) { const h = Math.floor(m / 60); return `Updated ${h} hour${h === 1 ? '' : 's'} ago`; }
    return 'Updated ' + fmtD(b);
  }
  const updLine = () => { const u = updatedAgo(); return u ? `<span class="page-upd">${esc(u)}</span>` : ''; };
  const head = (crumb, title, lead) => `<div class="page-head rise"><div class="head-top"><div class="crumb">${crumb}</div>${updLine()}</div><h1>${esc(title)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : ''}</div>`;
  const paras = list => (list || []).map(p => `<p>${esc(p)}</p>`).join('');
  function wsCard(w, i) {
    const p = w.progress;
    const bar = p && p.total ? `<div class="bar"><i style="width:${(p.complete / p.total * 100).toFixed(1)}%;background:${pColor(w)}"></i><i style="width:${((p.partial || 0) / p.total * 100).toFixed(1)}%;background:${pColor(w)}55"></i></div>` : '';
    return `<a class="wsc rise" style="--c:${mColor(w.mission)};animation-delay:${i * 50}ms" href="#${slug(w.id)}">${wsChip(w)}<b>${esc(w.name)}</b>
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
  // The Status page (2026-11-25 redesign): about three phone screens. The date line; Needs you first, full
  // width, on every screen (Vince's placement of 2026-11-23; Project Director, 2026-11-27); the status card;
  // the active missions; the warnings and the way from idea to real use; Done, now and next and
  // the workstreams. Every list shows its top three with the rest one tap away. The headline, the number
  // tiles, the rings and the two charts left this page; the decisions chart stays on the Decisions page.
  const HOME_TOP = 3, GLANCE_AHEAD = 28;
  const WS_ORDER = { behind: 0, risk: 1, track: 2, none: 3, moved: 4, done: 5 };
  // The areas behind, at risk and on track (each a way into the schedule), the launch window and the next release.
  function statusCard() {
    const list = schedule().length ? areas() : [];
    const n = s => list.filter(a => a.s === s).length;
    const st = (s, label, c) => `<a class="st" href="#roadmap" style="--c:var(${c})"><b>${n(s)}</b>${label}</a>`;
    const l = milestones().find(m => /launch/i.test(m.title) && !/complete/i.test(m.status));
    const lf = l && parseDate(l.forecastEarliest), ll = l && (parseDate(l.forecastLatest) || lf);
    const days = l && l.targetD ? Math.max(0, Math.ceil((l.targetD - Date.now()) / DAY)) : null;
    // "May 17 to Jun 14, 2027": the year once, at the end, when both ends share it.
    const span = (a, b) => !b || +a === +b ? fmtD(a) : a.getFullYear() === b.getFullYear() ? fmt(a) + ' to ' + fmtD(b) : fmtD(a) + ' to ' + fmtD(b);
    const launch = l && (lf || l.targetD) ? `<div class="kv"><span class="k">Launch</span><span class="v">${lf ? 'Forecast ' + esc(span(lf, ll)) : 'No forecast yet'}${l.targetD ? `<small>Your target ${esc(fmtD(l.targetD))} &middot; ${days} ${days === 1 ? 'day' : 'days'}</small>` : ''}</span></div>` : '';
    const rel = schedule().filter(r => /^release$/i.test(r.stage) && !r.done).sort((p, q) => (p.startD || 9e15) - (q.startD || 9e15))[0];
    let release = '';
    if (rel) {
      const name = String(rel.item).replace(/^[^:]*:\s*/, ''), cards = releaseNo(rel.item) ? rowReleaseCards(rel) : [];
      const done = cards.filter(c => c.cat === 'done').length;
      release = `<div class="kv"><span class="k">Next release</span><span class="v">${esc(name.charAt(0).toUpperCase() + name.slice(1))}${rel.startD ? ' &middot; ' + esc(fmtD(rel.startD)) : ''}${cards.length
        ? `<small>${done} of ${cards.length} build cards done</small><span class="hbar"><i style="width:${(done / cards.length * 100).toFixed(1)}%"></i></span>` : ''}</span></div>`;
    }
    // The audit questions this week against Vince's own weekly minimum (2026-11-01; kept on this page by the
    // Documents Director and the Project Director, 2026-11-25), only once the live count has a full week.
    const wk = coachingWeek();
    const week = wk ? `<div class="kv"><span class="k">Audit questions</span><span class="v">${esc(wk.done)} of ${esc(wk.min)} this week<small>Your weekly minimum is ${esc(wk.min)} &middot; <a href="#roadmap">Pace</a></small><span class="hbar"><i style="width:${Math.min(100, wk.done / wk.min * 100).toFixed(1)}%"></i></span></span></div>` : '';
    const counts = list.length ? `<div class="st3">${st('behind', 'behind', '--rose')}${st('risk', 'at risk', '--orange')}${st('track', 'on track', '--green')}</div>` : '';
    return counts || launch || release || week ? `<div class="card rise" id="sec-status">${counts}${launch}${week}${release}</div>` : '';
  }
  // From idea to real use: one row per step with its numbers; a step without numbers is left out.
  function pipelineCard() {
    const lanes = (S.feed.workstreams || []).filter(w => w.progress && w.progress.total);
    const scope = lanes.find(w => /scope/i.test(w.progress.measure || ''));
    const tested = lanes.find(w => w !== scope && /test/i.test(w.progress.measure || ''));
    const r = reqs(), recs = r ? (r.areas || []).flatMap(a => a.records || []) : [];
    const b = board(), cards = b ? (b.areas || []).flatMap(a => a.cards || []) : [];
    const rel = schedule().filter(x => /^release$/i.test(x.stage));
    const rows = [
      ['Scope defined', scope && scope.progress.complete, scope && scope.progress.total],
      ['Requirements approved', recs.filter(x => x.cat === 'done').length, recs.length],
      ['Built and checked', cards.filter(c => c.cat === 'done').length, cards.length],
      ['Independently tested', tested && tested.progress.complete, tested && tested.progress.total],
      ['In real use', rel.filter(x => x.done).length, rel.length, rel.length === 1 ? 'release' : 'releases'],
    ].filter(([, a, t]) => t > 0 && a != null);
    if (!rows.length) return '';
    return `<div class="card rise"><div class="card-h"><h3>From idea to real use</h3></div><div class="pipe">${rows.map(([label, a, t, unit]) =>
      `<div class="pipe-row${a >= t ? ' full' : ''}"><span>${esc(label)}${a >= t ? ' &#10003;' : ''}</span><em>${a} of ${t}${unit ? ' ' + unit : ''}</em><span class="hbar"><i style="width:${Math.min(100, a / t * 100).toFixed(1)}%"></i></span></div>`).join('')}</div></div>`;
  }
  // Done, now and next (Vince, 2026-11-13: "a concise visual to see what's been completed recently, what's
  // up now and what is coming in the near future"), one list of three at a time. Done: the lanes' done
  // lines from the last three days. Now: each area's stages under way or due to have started, worst first.
  // Next: each area's next stage starting in the next four weeks. All read from the Registry and Jira.
  const lowerFirst = s => /^.[a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  function glanceLists() {
    const ws = workstreams(), today = startOfToday(), until = new Date(+today + GLANCE_AHEAD * DAY), since = dayShift(etDay(new Date()), 1 - AWARE_DAYS);
    const li = (d, body) => `<li><span class="d">${esc(d)}</span><span class="t">${body}</span></li>`;
    const done = ws.flatMap(w => (w.done || []).map(d => ({ day: String(d.date || '').slice(0, 10), dateD: parseDate(d.date), text: d.text })))
      .filter(d => d.dateD && d.day >= since).sort((a, b) => b.dateD - a.dateD).map(d => li(fmt(d.dateD), esc(d.text)));
    const started = r => !r.done && !r.milestone && (/in progress/i.test(r.status) || (r.startD && r.startD < today));
    const now = areas().map(a => ({ a, rows: a.rows.filter(started) })).filter(x => x.rows.length).map(x => {
      const st = rowsState(x.rows).s, due = x.rows.map(r => r.finishD).filter(Boolean).sort((p, q) => p - q)[0];
      return { st, due, html: `${esc(x.a.name)}: ${esc(x.rows.map(r => lowerFirst(shortItem(r.item, x.a.name))).join(', '))}${st === 'risk' || st === 'behind' ? ' ' + chip(st) : ''}` };
    }).sort((p, q) => SEVERITY[q.st] - SEVERITY[p.st] || (p.due || 0) - (q.due || 0)).map(u => li(u.due ? 'Due ' + fmt(u.due) : '', u.html));
    const next = areas().map(a => a.rows.filter(r => !r.done && !started(r) && r.startD && r.startD >= today && r.startD <= until).sort((p, q) => p.startD - q.startD)[0])
      .filter(Boolean).sort((p, q) => p.startD - q.startD).map(r => li(fmt(r.startD), esc(r.item)));
    return [
      { k: 'done', label: 'Done', sub: 'The last three days', items: done, empty: 'Nothing recorded as finished in the last three days.',
        link: ROUTES.history ? ['#history', 'Everything older, in History'] : ['#roadmap', 'The full schedule'] },
      { k: 'now', label: 'Now', sub: 'Under way, worst first', items: now, empty: 'Nothing under way.', link: ['#roadmap', 'Every area, on the schedule'] },
      { k: 'next', label: 'Next', sub: 'What starts next', items: next, empty: 'Nothing starts in the next four weeks.', link: ['#roadmap', 'The full schedule'] },
    ];
  }
  function glanceCard() {
    const L = glanceLists();
    return `<div class="card rise" id="sec-glance"><div class="card-h"><h3>Done, now and next</h3><span class="seg" role="group" aria-label="Show">${L.map(g =>
      `<button type="button" data-glance="${g.k}" aria-pressed="${g.k === 'now'}">${g.label}</button>`).join('')}</span></div>
      ${L.map(g => `<div data-gl="${g.k}"${g.k === 'now' ? '' : ' hidden'}><div class="sub">${esc(g.sub)}${g.items.length > HOME_TOP ? ` &middot; ${HOME_TOP} of ${g.items.length}` : ''}</div>
        ${g.items.length ? `<ul class="lines">${g.items.slice(0, HOME_TOP).join('')}</ul>` : `<p class="empty">${g.empty}</p>`}<a class="go-link" href="${g.link[0]}">${esc(g.link[1])}&nbsp;&rsaquo;</a></div>`).join('')}</div>`;
  }
  // The workstreams, worst first: three shown, the rest behind See all; each opens to now and next.
  function workstreamsCard() {
    const ws = workstreams().map((w, i) => ({ w, i })).sort((a, b) => (WS_ORDER[a.w.status] - WS_ORDER[b.w.status]) || a.i - b.i).map(x => x.w);
    if (!ws.length) return '';
    const row = w => `<details class="ws"><summary><span class="nm">${esc(w.name)}</span>${wsChip(w)}<span class="caret">&#9656;</span></summary>
      <p><b>Now:</b> ${esc(w.now || 'Not recorded')}</p>${w.closed ? '' : `<p><b>Next:</b> ${esc(w.next || 'Not recorded')}</p>`}<a class="go-link" href="#${slug(w.id)}">The workstream’s page&nbsp;&rsaquo;</a></details>`;
    return `<div class="card rise" id="sec-workstreams"><div class="card-h"><h3>Workstreams</h3><span class="sub">Worst first. Tap one for now and next.</span></div>
      ${ws.slice(0, HOME_TOP).map(row).join('')}${ws.length > HOME_TOP ? `<details class="fold"><summary>See all ${ws.length}</summary>${ws.slice(HOME_TOP).map(row).join('')}</details>` : ''}</div>`;
  }
  function pageHome() {
    // The active missions card comes from the mission pages' own code, when the site has it.
    const missions = typeof missionsCard === 'function' ? missionsCard() : '';
    return `<div class="wrap home">
      <div class="dateline rise"><h1>Project status · ${esc(fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }))}</h1><span class="upd">${esc(updatedAgo())}</span></div>
      ${pendingCard()}
      ${statusCard()}
      ${missions}
      <div class="hcols">${awarenessCard()}${pipelineCard()}</div>
      <div class="hcols">${glanceCard()}${workstreamsCard()}</div>
    </div>`;
  }
  // Done, now and next switches its list in place.
  function afterHome(root) {
    root.querySelectorAll('[data-glance]').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('[data-glance]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      root.querySelectorAll('[data-gl]').forEach(x => { x.hidden = x.dataset.gl !== b.dataset.glance; });
    }));
  }

  function pageWorkstream(id) {
    const w = workstreams().find(x => slug(x.id) === id);
    if (!w) return head('Status', 'Not found', 'That workstream is no longer in the Registry.');
    const p = w.progress;
    return `<div class="wrap">
      <div class="ws-head rise" style="--c:${mColor(w.mission)}"><div class="head-top"><div class="crumb"><a href="#workstreams">Status &rsaquo; Workstreams</a> &rsaquo;</div>${updLine()}</div><h1>${esc(w.name)}</h1>
        <div>${wsChip(w)} <span class="sub">${esc([ownerRole(w.owner), w.updatedDate ? (ownerRole(w.owner) ? 'updated ' : 'Updated ') + ago(w.updatedDate) : ''].filter(Boolean).join(' · '))}</span></div></div>
      ${w.sched && w.sched.why.length ? `<div class="card rise"><h3>${esc(STATUS_LABEL[w.status])}</h3><ul class="why">${w.sched.why.map(t => `<li>${esc(t)}</li>`).join('')}</ul><div class="sub" style="margin-top:8px"><a href="#roadmap">Schedule and milestones &rsaquo;</a></div></div>` : ''}
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
    return ['behind', 'risk', 'track', 'done', 'moved'].filter(s => n(s)).map(s => n(s) + ' ' + STATUS_LABEL[s].toLowerCase()).join(' · ');
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
    const to = r.finishD || r.startD, late = slip(t, r.startD, to);
    // On track against the agreed dates, though the forecast is past the original target.
    if (a.s === 'track' && Math.round((to - t) / DAY) > 0) return 'On track to the agreed dates · ' + late;
    return `${shortItem(r.item, a.name)}: target ${fmtD(t)} · forecast ${fmtD(r.startD)}${+to !== +r.startD ? ' to ' + fmtD(to) : ''} · ${late}`;
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
      : a.s === 'moved' ? [stages.length === 1 ? `${label(stages[0])} done` : stages.length ? 'Other stages done' : '', esc(movedLine(a))].filter(Boolean).join(' · ')
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
        : (r.startD ? fmtD(r.startD) + (r.finishD ? ' to ' + fmtD(r.finishD) : '') : '') + (agreedSlip(r) ? ' · agreed ' + fmtD(r.agreedFinishD) : '');
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
        const cards = rowReleaseCards(r), st = rowState(r).s;
        const areasIn = releaseAreas(r).map(a => a.name.split(':')[0]);
        return `<div class="rel"><div class="area-top"><b>${esc(r.item)}</b>${chip(st)}</div>
          <div class="sub">${r.startD ? esc(fmtD(r.startD) + ' to ' + fmtD(r.finishD)) : ''}${areasIn.length ? ' · ' + esc(areasIn.join(', ')) : ''}</div>
          ${cards.length ? cardMeter(cards, 'cards done') : `<p class="sub">${b ? 'No build cards yet: they’re added from each area’s build package.' : 'The build board couldn’t be read at the last refresh.'}</p>`}</div>`;
      }).join('')}</div></div>`;
  }
  function requirementsCard() {
    const r = reqs();
    if (!r || !(r.areas || []).length) return '';
    const due = name => { const row = schedule().find(x => /^requirements$/i.test(x.stage) && areaKey(x.group) === areaKey(name)); return row && !row.done && row.finishD ? row : null; };
    const item = a => {
      const row = due(a.name), st = row ? rowState(row).s : null;
      return `<div class="rel"><div class="area-top"><b>${esc(a.name.replace(/\s+requirements$/i, ''))}</b>${st ? chip(st) : ''}</div>
          ${row ? `<div class="sub">Due ${esc(fmtD(row.finishD))}</div>` : ''}${reqMeter(a)}</div>`;
    };
    // Every area fully approved: one line, the list folded. Otherwise the areas still open, the approved ones folded.
    const full = a => (a.records || []).length > 0 && a.records.every(x => x.cat === 'done');
    const open = r.areas.filter(a => !full(a)), approved = r.areas.filter(full);
    const n = r.areas.length, total = r.areas.reduce((s, a) => s + (a.records || []).length, 0);
    const fold = (label, list) => list.length ? `<details class="sched-fold"><summary>${esc(label)}</summary><div class="rel-list">${list.map(item).join('')}</div></details>` : '';
    if (!open.length) return `<div class="card rise"><div class="area-top"><h3>Requirements before build</h3>${chip('done')}</div>
      <p class="area-line">All ${n} areas approved: ${total} of ${total} requirements</p>${fold(`The ${n} areas`, approved)}</div>`;
    return `<div class="card rise"><h3>Requirements before build</h3><div class="sub">Approved requirements out of each area’s total. Building waits on them.</div>
      <div class="rel-list">${open.map(item).join('')}</div>${fold(`${approved.length} ${approved.length === 1 ? 'area' : 'areas'} fully approved`, approved)}</div>`;
  }
  function paceCard() {
    const p = pace(), wk = coachingWeek();
    if (!p) return '';
    const left = p.total - p.now;
    const lineTxt = p.rate == null ? `The pace shows after the first full week, ${fmtD(new Date(+p.start + 7 * DAY))}.`
      : p.behind ? 'At risk: ' + p.text + '.' : `At the last ${p.span} days’ pace, the audit questions are all answered about ${fmtD(p.projected)}, on time.`;
    return `<div class="card rise"><h3>Audit questions pace</h3>
      <div class="sub">${wk ? `${wk.done} of ${wk.min} this week · ` : ''}${left} left, about ${p.needPerWeek} a week to finish by ${esc(fmtD(p.finish))}</div>
      <div class="chart" id="paceChart" style="height:240px"></div><p class="sub">${esc(lineTxt)} Audit questions answered, from the coaching knowledge analyst’s count.</p></div>`;
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
    // Ahead: the milestones with a date (a target, or else a forecast), soonest first; the rest are folded.
    const msDate = m => m.targetD || parseDate(m.forecastEarliest);
    const up = ms.filter(m => !/complete/i.test(m.status)).sort((a, b) => (msDate(a) || 9e15) - (msDate(b) || 9e15));
    const upDated = up.filter(msDate), upUndated = up.filter(m => !msDate(m));
    const reached = ms.filter(m => /complete/i.test(m.status)).sort((a, b) => (b.actualD || b.targetD || 0) - (a.actualD || a.targetD || 0));
    S.schedWin = '12';
    const late = m => m.actualD && m.targetD && m.actualD - m.targetD > DAY ? ` <span class="chip behind">${Math.round((m.actualD - m.targetD) / DAY)} days after target</span>` : '';
    const rows = schedule();
    const reviewed = parseDate(S.feed.schedule && S.feed.schedule.reviewed);
    const lead = rows.length ? 'Where each area is, what’s next and whether it’s on schedule, from the Registry’s schedule and the Jira build board' + (reviewed ? '. Forecast last reviewed ' + fmtLong(reviewed) : '') + '.'
      : 'Target windows are the sponsor’s planning dates, not forecasts.';
    const list = rows.length ? areas() : [];
    // Areas still under way, worst first (behind, at risk, on track) and in delivery order within each;
    // finished and moved ones folded below them.
    const finished = a => a.s === 'done' || a.s === 'moved';
    const live = list.filter(a => !finished(a)).sort((x, y) => SEVERITY[y.s] - SEVERITY[x.s]), fin = list.filter(finished);
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
      ${rows.some(r => r.startD) ? `<div class="card rise sched-card" id="schedCard">${schedCardBody()}</div>`
        : `<div class="card rise"><h3>Schedule</h3><div class="sub">Sponsor target windows</div><div class="chart" id="sched" style="height:320px"></div></div>`}
      ${list.length ? `<div class="card rise"><h3>Every area</h3><div class="sub">${esc(stateSummary(list))}. Worst first. On track means every stage is on schedule against its agreed dates. Tap an area for its stages and build cards.</div>
        <div class="areas">${live.map(areaRow).join('')}</div>${fin.length ? `<details class="sched-fold"><summary>${fin.length} finished ${fin.length === 1 ? 'area' : 'areas'}</summary><div class="areas">${fin.map(areaRow).join('')}</div></details>` : ''}
        ${boardNote ? `<div class="sub" style="margin-top:10px">${boardNote}</div>` : ''}</div>
      <div class="grid g-half">
        <div class="card rise"><h3>Next two weeks</h3><div class="sub">Stages starting or due by ${esc(fmtD(new Date(+startOfToday() + 14 * DAY)))}</div>${mini(soon.map(x => miniItem(rowState(x.r).s, `${esc(x.r.item)} <span class="sub">· ${esc(x.kind)}</span>`, fmtD(x.d))))}</div>
        ${paceCard()}
      </div>
      <div class="grid g-half">${releasesCard()}${requirementsCard()}</div>` : ''}
      <div class="grid g-half">
        <div class="card rise"><h3>Milestones ahead</h3>${upDated.length ? `<ul class="done-list">${upDated.map(m => `<li><span class="d">${esc(fmtD(msDate(m)))}</span><span>${esc(m.title)}<br><span class="sub">${milestoneSub(m)}</span></span></li>`).join('')}</ul>` : '<p class="empty">No dated milestones ahead.</p>'}
          ${upUndated.length ? `<details class="sched-fold"><summary>${upUndated.length} ${upUndated.length === 1 ? 'milestone' : 'milestones'} without a date yet</summary><ul class="done-list">${upUndated.map(m => `<li><span>${esc(m.title)}<br><span class="sub">${milestoneSub(m)}</span></span></li>`).join('')}</ul></details>` : ''}</div>
        <div class="card rise"><h3>Milestones reached</h3><ul class="done-list">${reached.map(m => { const d = m.actualD || m.targetD;
          return `<li>${d ? `<span class="d">${esc(fmtD(d))}</span>` : ''}<span class="t">${esc(String(m.title || '').replace(/\.\s*$/, ''))}${late(m)}</span></li>`; }).join('')}</ul></div>
      </div></div>`;
  }
  function afterRoadmap(root) {
    const card = $('#schedCard', root);
    if (card) {
      const tip = b => {
        card.querySelectorAll('.g-bar.on, .g-ms.on').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        $('#gtip', card).textContent = b.dataset.tip;
      };
      // The switch redraws only the chart card, and keeps focus on the button pressed.
      card.addEventListener('click', ev => {
        const w = ev.target.closest('[data-win]');
        if (w) { S.schedWin = w.dataset.win; card.innerHTML = schedCardBody(); const f = $(`[data-win="${S.schedWin}"]`, card); if (f) f.focus(); return; }
        const b = ev.target.closest('.g-bar, .g-ms');
        if (b) tip(b);
      });
      card.addEventListener('mouseover', ev => { const b = ev.target.closest('.g-bar, .g-ms'); if (b) $('#gtip', card).textContent = b.dataset.tip; });
    } else if ($('#sched', root)) gantt($('#sched', root), window.innerWidth < 700);
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
    // Folded by month, the newest open; while the search box has text, the matches show unfolded.
    const row = d => `<div class="dec" style="--c:${mColor(d.mission || 'all')}"><span class="d">${esc(fmt(d.dateD))}</span><span class="dotm"></span><span>${esc(d.headline)}<span class="id">${esc(d.id)} · ${esc(MISSION_NAME[d.mission || 'all'] || '')}</span></span></div>`;
    const draw = q => {
      const f = ds.filter(d => !q || (d.headline + ' ' + d.id).toLowerCase().includes(q));
      const months = [];
      f.forEach(d => {
        const m = d.dateD.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), g = months[months.length - 1];
        if (g && g.m === m) g.list.push(d); else months.push({ m, list: [d] });
      });
      const html = q ? months.map(g => `<div class="dec-month">${esc(g.m)}</div>${g.list.map(row).join('')}`).join('')
        : months.map((g, i) => `<details class="dec-fold"${i ? '' : ' open'}><summary>${esc(g.m)} · ${g.list.length} ${g.list.length === 1 ? 'decision' : 'decisions'}</summary>${g.list.map(row).join('')}</details>`).join('');
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
    // The legend is wrapped HTML under the chart, so on a phone it never prints over the plot or the dates.
    const el = $('#trend', root);
    if (el && ws.length) el.insertAdjacentHTML('afterend', `<div class="legend trend-legend">${ws.map(w => `<span><i style="background:${mColor(w.mission)}"></i>${esc(w.name)}</span>`).join('')}</div>`);
    chart(el, {
      grid: { left: 40, right: 16, top: 30, bottom: 30 },
      tooltip: { trigger: 'axis', valueFormatter: v => v == null ? '' : v + '%' },
      legend: { show: false },
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
    // The awareness lines: read with the Registry, or from the content document until the feed reads the tab.
    const aw = S.feed.awareness, A = awareness();
    rows.push(aw && aw.status === 'ok' ? { c: dot(gen), b: 'Awareness lines (Registry)', s: 'read with the Registry · ' + A.lines.length + ' from the last three days' }
      : A.ready ? { c: css('--amber'), b: 'Awareness lines (content document)', s: A.lines.length + ' from the last three days, until the feed reads the Registry tab' }
      : { c: css('--steel'), b: 'Awareness lines', s: aw ? String(aw.status) : 'not connected yet' });
    const pe = S.feed.pending, P = pending();
    rows.push(pe && pe.status === 'ok' ? { c: dot(gen), b: 'Pending actions (Registry)', s: 'read with the Registry · ' + P.actions.length + ' actions' }
      : P.ready ? { c: css('--amber'), b: 'Pending actions (content document)', s: P.actions.length + ' actions, until the feed reads the Registry tab' }
      : { c: css('--steel'), b: 'Pending actions', s: pe ? String(pe.status) : 'not connected yet' });
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

  // ---------- mission pages ----------
  // One standard page per active mission (Vince, 2026-11-25): where it stands; Path to green, only when it is not
  // green; one plan that shows now and the next three, with the rest folded; and what is done. The status, counts,
  // plan and dates come from the Schedule groups the mission names and the Jira records behind them. Only the tag,
  // purpose, where it stands, the next three and Path to green are written by hand. The list is the feed's missions
  // only (the Registry, once the Project Director's Missions tab exists), each { key, name, tag, purpose, stands,
  // next: [up to three], path: [{ do, clears }] or ["do | clears"], updated, groups: [Schedule group names] or
  // "a; b", plan: "stages" or "releases" }. Until the feed sends them there are no mission pages, no Active missions
  // card and no menu entries. The content document's page "missions" is the Missions explainer, not this list.
  const MISSION_STALE = 7, MISSION_DONE_TOP = 3, MISSION_DONE_MAX = 12;
  const missionKey = k => String(k == null ? '' : k).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  function missionsRaw() { return Array.isArray(S.feed.missions) ? S.feed.missions : []; }
  // A group's short name: "Shared foundation (Missions 2–4)" and "Fitbit: sleep, steps…" read "Shared foundation" and "Fitbit".
  const groupLabel = g => String(g).replace(/\s*\([^)]*\)/g, '').split(':')[0].trim();
  const relLabel = item => String(item).replace(/^Capture release\b/i, 'Release');
  // "Dec 21 to Jan 15, 2027", "Feb 26 to Apr 30, 2027", or one date.
  const dateSpan = (a, b) => {
    if (!a) return b ? fmtD(b) : '';
    if (!b || Math.abs(b - a) < DAY) return fmtD(a);
    const thisYear = new Date().getFullYear();
    return (a.getFullYear() === b.getFullYear() || a.getFullYear() === thisYear ? fmt(a) : fmtD(a)) + ' to ' + fmtD(b);
  };
  const firstSentence = (s, max = 110) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), x = t.match(/^(.+?[.!?])(?=\s|$)/);
    const f = x ? x[1] : t;
    if (f.length <= max) return f;
    const cut = f.slice(0, max), sp = cut.lastIndexOf(' ');
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, '') + '…';
  };
  // The missions with what the site works out for each: its groups, status (the worst of them), counts by state,
  // numbers, milestone and plan rows. A mission none of whose Schedule groups is in the schedule doesn't show at
  // all: no page, no Active missions row and no menu entry (the Missions tab's rules, 2026-11-27).
  function missions() {
    const all = areas(), sched = schedule(), seen = new Set();
    const b = board(), r = reqs();
    return missionsRaw().map(raw => {
      if (!raw || !raw.name) return null;
      const key = missionKey(raw.key || raw.name);
      if (!key || seen.has(key)) return null;
      const names = (Array.isArray(raw.groups) ? raw.groups : String(raw.groups || '').split(';')).map(x => String(x).trim()).filter(Boolean);
      // A name matches its group exactly, else by area name ("Shared foundation"), else as the start of one ("Mission 1B").
      const groups = [];
      names.forEach(n => {
        const l = n.toLowerCase();
        let hit = all.filter(a => a.name === n);
        if (!hit.length) hit = all.filter(a => areaKey(a.name) === areaKey(n));
        if (!hit.length) hit = all.filter(a => a.name.toLowerCase().startsWith(l));
        hit.forEach(a => { if (!groups.includes(a)) groups.push(a); });
      });
      if (!groups.length) return null;
      seen.add(key);
      const keys = new Set(groups.map(g => areaKey(g.name)));
      const sev = s => SEVERITY[s] || 0;
      const s = groups.length ? groups.reduce((m, g) => sev(g.s) > sev(m) ? g.s : m, 'done') : null;
      const count = st => groups.filter(g => (st === 'done' ? g.s === 'done' || g.s === 'moved' : g.s === st)).length;
      const rows = groups.flatMap(g => g.rows);
      const stages = rows.filter(x => !x.milestone);
      const cards = b ? (b.areas || []).filter(a => keys.has(areaKey(a.name))).flatMap(a => a.cards || []) : [];
      const records = r ? (r.areas || []).filter(a => keys.has(areaKey(a.name))).flatMap(a => a.records || []) : [];
      // Its milestone: the groups' own last milestone, else the completion milestone of the mission that does most
      // of the groups' stages' delivery missions, taking the one with the latest target.
      const end = x => +(x.finishD || x.startD || 0);
      let ms = rows.filter(x => x.milestone).sort((p, q) => end(p) - end(q)).pop() || null;
      if (!ms && stages.length) {
        const own = new Set(stages.map(x => String(x.mission)).filter(x => x && x !== '0' && x !== 'all'));
        const tgt = x => { const m = milestones().find(y => y.id === x.milestone); return +((m && m.targetD) || 0); };
        ms = sched.filter(x => x.milestone && own.has(String(x.mission)) && !rows.includes(x)).sort((p, q) => tgt(p) - tgt(q) || end(p) - end(q)).pop() || null;
      }
      const msInfo = ms ? milestones().find(y => y.id === ms.milestone) : null;
      // The plan: the Release rows the groups ship in, or every stage of the groups, in date order.
      const byDate = (p, q) => (p.startD ? +p.startD : 9e15) - (q.startD ? +q.startD : 9e15) || (p.finishD ? +p.finishD : 9e15) - (q.finishD ? +q.finishD : 9e15);
      let plan = String(raw.plan || '').toLowerCase() === 'releases' ? 'releases' : 'stages';
      let planRows = plan === 'releases' ? sched.filter(x => /^release$/i.test(x.stage) && releaseNo(x.item) && releaseAreas(x).some(a => keys.has(areaKey(a.name)))) : [];
      if (!planRows.length) { plan = 'stages'; planRows = stages.slice(); }
      planRows.sort(byDate);
      const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
      const path = (Array.isArray(raw.path) ? raw.path : []).map(p => typeof p === 'string' ? (([d, c]) => ({ do: d, clears: c }))(p.split('|').map(x => x.trim())) : p)
        .filter(p => p && String(p.do || '').trim()).map(p => ({ do: String(p.do).trim(), clears: String(p.clears || '').trim() }));
      return {
        key, name: String(raw.name).trim(), tag: String(raw.tag || '').trim(), purpose: String(raw.purpose || '').trim(), stands: String(raw.stands || '').trim(),
        next: list(raw.next).slice(0, 3), path, updatedD: parseDate(raw.updated), handWritten: !!(raw.stands || list(raw.next).length || path.length),
        groups, s, counts: { behind: count('behind'), risk: count('risk'), track: count('track'), done: count('done') },
        stages, cards, records, ms, msInfo, plan, planRows,
      };
    }).filter(Boolean);
  }
  const missionByRoute = route => missions().find(m => 'mission-' + m.key === route);
  // A row's name on a mission page: a release as "Release 2a: …", a stage under its group's short name when the
  // mission has more than one group.
  function missionRowLabel(m, r) {
    if (/^release$/i.test(r.stage)) return relLabel(r.item);
    const s = shortItem(r.item, r.group);
    if (m.groups.length <= 1) return s;
    return s === r.item && /:/.test(s) ? s : groupLabel(r.group) + ': ' + lowerFirst(s);
  }
  // "Coaching knowledge complete is forecast Feb 12 to Mar 12, 2027, 2 to 3 months after the target of Nov 30, 2026."
  function missionTarget(m) {
    const r = m.ms;
    if (!r) return '';
    const name = m.name + ' complete', t = m.msInfo && m.msInfo.targetD;
    if (r.done) return `${name}: done ${fmtD(r.finishD)}${t ? ', against a target of ' + fmtD(t) : ''}.`;
    if (!r.startD) return `${name}: no forecast yet${t ? ', against a target of ' + fmtD(t) : ''}.`;
    const to = r.finishD || r.startD;
    if (!t) return `${name} is forecast ${dateSpan(r.startD, to)}.`;
    const sl = slip(t, r.startD, to), late = sl !== 'on or before target';
    return `${late && (m.s === 'track') ? 'On track to the agreed dates. ' : ''}${name} is forecast ${dateSpan(r.startD, to)}, ${late ? sl.replace(/target$/, 'the target of ' + fmtD(t)) : 'on or before its target of ' + fmtD(t)}.`;
  }
  function missionCounts(m) {
    if (m.groups.length < 2) return '';
    const parts = [['behind', 'behind'], ['risk', 'at risk'], ['track', 'on track'], ['done', 'done']].filter(([k]) => m.counts[k]).map(([k, w]) => m.counts[k] + ' ' + w);
    return parts.length ? parts[0].replace(/^(\d+) /, (x, n) => n + (n === '1' ? ' area ' : ' areas ')) + (parts.length > 1 ? ', ' + parts.slice(1).join(', ') : '') + '.' : '';
  }
  function pageMission(route) {
    const m = missionByRoute(route);
    const crumbHtml = `${esc(MENU[0].label)} &rsaquo; <b>Missions</b>`;
    if (!m) return head(crumbHtml, 'Not found', 'That mission is not on the list of active missions.') + '<div class="wrap"><p class="sub mis-back"><a href="#home">&lsaquo; Back to Status</a></p></div>';
    const green = m.s === 'track' || m.s === 'done';
    const today = startOfToday();
    const label = r => missionRowLabel(m, r);
    const stDone = m.stages.filter(r => r.done).length, cDone = m.cards.filter(c => c.cat === 'done').length, rDone = m.records.filter(x => x.cat === 'done').length;
    const facts = [m.stages.length ? [`${stDone} of ${m.stages.length}`, 'stages done'] : null, m.cards.length ? [`${cDone} of ${m.cards.length}`, 'build cards done'] : null,
      m.records.length ? [`${rDone} of ${m.records.length}`, 'requirements approved'] : null].filter(Boolean);
    const tgt = [missionCounts(m), missionTarget(m)].filter(Boolean).join(' ');
    const upd = m.updatedD ? `Hand-written parts updated ${esc(fmtD(m.updatedD))}${daysSince(m.updatedD) > MISSION_STALE ? ' · <span class="mis-stale">may be out of date</span>' : ''}`
      : m.handWritten ? 'Hand-written parts not dated · <span class="mis-stale">may be out of date</span>' : '';
    const stands = `<div class="card rise mis-card"><div class="mis-h"><h3>Where it stands</h3>${m.s ? chip(m.s) : ''}</div>
      ${m.stands ? `<p class="mis-line">${esc(m.stands)}</p>` : ''}${tgt ? `<p class="mis-tgt">${esc(tgt)}</p>` : ''}
      ${facts.length ? `<div class="mis-facts">${facts.map(f => `<div class="mis-fact"><b>${esc(f[0])}</b><span>${esc(f[1])}</span></div>`).join('')}</div>` : ''}
      ${green ? '<p class="mis-green">&#10003; Green. Nothing to fix.</p>' : ''}</div>`;
    // Path to green: the hand-kept steps, lettered; with none, the reasons the schedule gives, so it is never empty.
    let path = '';
    if (m.s && !green) {
      const word = ['', 'this one thing', 'these two', 'these three', 'these four', 'these five'][m.path.length] || 'these';
      const why = m.groups.filter(g => g.why && g.why.length).flatMap(g => g.why);
      path = m.path.length
        ? `<div class="card rise"><div class="mis-h"><h3>Path to green</h3><span class="mis-src">Kept by hand</span></div>
          <div class="sub">Do ${word} and every area of ${esc(lowerFirst(m.name))} is on track.</div>
          <ol class="mis-todo path">${m.path.map(p => `<li><span><b>${esc(p.do)}</b>${p.clears ? `<small>${esc(p.clears)}</small>` : ''}</span></li>`).join('')}</ol></div>`
        : `<div class="card rise"><div class="mis-h"><h3>Path to green</h3><span class="mis-src">From the schedule</span></div>
          <div class="sub">No steps written yet. What keeps ${esc(lowerFirst(m.name))} from green:</div>
          ${why.length ? `<ul class="why">${why.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : `<p class="empty">The schedule gives no reason.</p>`}</div>`;
    }
    // The plan: now, the next three, then the rest and what is done folded as a stepper, ending with the milestone.
    const open = m.planRows.filter(r => !r.done), done = m.planRows.filter(r => r.done);
    const now = open[0];
    const stateWord = r => { const st = rowState(r).s; return st === 'risk' || st === 'behind' ? st : ''; };
    let nowBox = '';
    if (now) {
      const n = m.plan === 'releases' ? (() => { const c = rowReleaseCards(now); return c.length ? `${c.filter(x => x.cat === 'done').length} of ${c.length} build cards done` : ''; })()
        : `stage ${m.planRows.indexOf(now) + 1} of ${m.planRows.length}`;
      const started = now.startD && now.startD <= today || /in progress/i.test(now.status);
      const st = stateWord(now);
      nowBox = `<div class="mis-now"><span class="mis-nowtag">${started ? 'Now' : 'Next up'}</span>${st ? ' ' + chip(st) : ''}<b>${esc(label(now))}</b>
        <small>${esc([dateSpan(now.startD, now.finishD), n].filter(Boolean).join(' · '))}</small></div>`;
    }
    const auto = !m.next.length;
    const nextRows = auto ? open.slice(1, 4) : [];
    const nextHtml = auto ? nextRows.map(r => `<li><span><b>${esc(label(r))}</b><small>${esc([dateSpan(r.startD, r.finishD), stateWord(r) ? STATUS_LABEL[stateWord(r)] : ''].filter(Boolean).join(' · '))}</small></span></li>`)
      : m.next.map(t => `<li><span>${esc(t)}</span></li>`);
    const later = open.slice(auto ? 4 : 1);
    const step = (b, small, cls, mk) => `<li class="${cls}"><span class="mk">${mk}</span><b>${esc(b)}</b>${small ? `<small>${esc(small)}</small>` : ''}</li>`;
    const t = m.msInfo && m.msInfo.targetD;
    const msSmall = m.ms ? [m.ms.startD ? 'Forecast ' + dateSpan(m.ms.startD, m.ms.finishD || m.ms.startD) : 'No forecast yet', t ? 'against a target of ' + fmtD(t) : ''].filter(Boolean).join(', ') : '';
    const msStep = m.ms && !m.ms.done ? step(m.name + ' complete', msSmall, 'end', '') : '';
    const laterHtml = later.map(r => step(label(r), [dateSpan(r.startD, r.finishD), stateWord(r) ? STATUS_LABEL[stateWord(r)] : ''].filter(Boolean).join(' · '), 'todo', '')).join('') + msStep;
    const doneSteps = done.map(r => step(label(r), dateSpan(r.startD, r.finishD), 'done', '&#10003;')).join('') +
      (m.ms && m.ms.done ? step(m.name + ' complete', 'Done ' + fmtD(m.ms.finishD), 'done end', '&#10003;') : '');
    const fold = laterHtml || doneSteps ? `<details class="mis-more"><summary>See the whole plan</summary>
      ${laterHtml ? `<div class="mis-g">${auto ? 'After those' : 'Still to come'}</div><ol class="mis-steps">${laterHtml}</ol>` : ''}
      ${doneSteps ? `<div class="mis-g">Already done</div><ol class="mis-steps">${doneSteps}</ol>` : ''}</details>` : '';
    const planCard = `<div class="card rise"><div class="mis-h"><h3>The plan</h3><span class="mis-src">From the schedule</span></div>
      ${nowBox || `<p class="empty">${m.planRows.length ? 'Every step of the plan is done.' : 'No stages in the schedule yet.'}</p>`}
      ${nextHtml.length ? `<div class="mis-g">Next three</div><ol class="mis-todo">${nextHtml.join('')}</ol>` : ''}${fold}</div>`;
    // Done so far: finished stages (and releases), newest first.
    const finished = m.stages.concat(m.plan === 'releases' ? done : []).filter(r => r.done && r.finishD).sort((p, q) => q.finishD - p.finishD);
    const shown = finished.slice(0, MISSION_DONE_MAX);
    const li = r => `<li><span class="d">${esc(fmtD(r.finishD))}</span><span class="t">${esc(label(r))}</span></li>`;
    const doneCard = `<div class="card rise"><div class="mis-h"><h3>Done so far</h3><span class="mis-src">From the schedule</span></div>
      ${shown.length ? `<ul class="mis-lines">${shown.slice(0, MISSION_DONE_TOP).map(li).join('')}</ul>` : '<p class="empty">Nothing finished yet.</p>'}
      ${shown.length > MISSION_DONE_TOP ? `<details class="mis-more"><summary>See all ${shown.length}</summary><ul class="mis-lines">${shown.slice(MISSION_DONE_TOP).map(li).join('')}</ul>
        ${finished.length > shown.length ? `<p class="sub mis-back">${finished.length - shown.length} earlier stages: <a href="#roadmap">Schedule and milestones &rsaquo;</a></p>` : ''}</details>` : ''}</div>`;
    const h = head(crumbHtml, m.name, m.purpose);
    return (m.tag ? h.replace('<h1>', `<div class="mis-tag">${esc(m.tag)}</div><h1>`) : h) +
      `<div class="wrap mis-page">${upd ? `<p class="sub mis-upd">${upd}</p>` : ''}${stands}${path}
      <div class="mis-cols">${planCard}${doneCard}</div>
      <p class="sub">The plan, its dates, the status and the counts build themselves from the schedule and Jira.${m.handWritten ? ' Where it stands, the next three and Path to green are written by hand.' : ''}</p>
      <p class="sub mis-back"><a href="#home">&lsaquo; Back to Status</a></p></div>`;
  }
  // The Status page's "Active missions" card: one row per mission, each opening its page. Empty with no missions.
  function missionsCard() {
    const list = missions();
    if (!list.length) return '';
    return `<div class="card rise mis-list" id="sec-missions"><div class="mis-h"><h3>Active missions</h3><span class="sub">${list.length === 1 ? 'One mission' : list.length + ' missions'} under way</span></div>
      ${list.map(m => `<a class="mis-row" href="#mission-${esc(m.key)}"><span class="nm">${esc(m.name)}${m.stands ? `<small>${esc(firstSentence(m.stands))}</small>` : ''}</span>${m.s ? chip(m.s) : ''}<span class="car" aria-hidden="true">&#9656;</span></a>`).join('')}</div>`;
  }
  // Each mission in the Status menu, right after Status overview.
  function addMissionMenus() {
    const items = MENU[0].items.filter(i => !/^#mission-/.test(i.href));
    let list = [];
    try { list = missions(); } catch (e) { console.error(e); }
    items.splice(items.findIndex(i => i.href === '#home') + 1, 0, ...list.map(m => ({ href: '#mission-' + m.key, label: 'Mission: ' + lowerFirst(m.name), sub: 'Where it stands, the plan and what’s done', ico: '&#9873;', c: '--violet' })));
    MENU[0].items = items;
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
    // Both bar labels always show, wrapping to a second line when a phone's column is too narrow; the axis starts at 0.
    const t2 = $('#t2', root), col = t2 ? Math.max(80, Math.floor((t2.clientWidth - 56) / 2) - 12) : 120;
    chart(t2, {
      grid: { left: 40, right: 16, top: 30, bottom: 44 },
      xAxis: { type: 'category', data: ['With the specification', 'Without it'], axisLabel: { color: muted, interval: 0, width: col, overflow: 'break', lineHeight: 15 }, axisLine: { lineStyle: { color: grid } }, axisTick: { show: false } },
      yAxis: { type: 'value', min: 0, max: t.cases, axisLabel: { color: muted, showMaxLabel: false }, splitLine: { lineStyle: { color: grid } } },
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
    home: [pageHome, afterHome, 'Status'], awareness: [pageAwareness, afterAwareness, 'For your awareness'],
    roadmap: [pageRoadmap, afterRoadmap, 'Schedule'], decisions: [pageDecisions, afterDecisions, 'Decisions'],
    trends: [pageTrends, afterTrends, 'Progress trends'], health: [pageHealth, afterHealth, 'Data health'], goal: [pageGoal, null, 'The goal'],
    missions: [pageMissions, null, 'Missions'], lifecycle: [pageLifecycle, null, 'Delivery lifecycle'], testing: [pageTesting, afterTesting, 'Testing'],
    architecture: [pageArchitecture, afterArchitecture, 'Architecture'], team: [pageTeam, null, 'Team'], governance: [pageGovernance, null, 'Governance'], about: [pageAbout, null, 'About'],
  };

  // The waiting and workstreams lists live on the Status page; their old addresses open it at that section.
  const SECTIONS = { status: '', pending: 'sec-pending', glance: 'sec-glance', waiting: 'sec-pending', workstreams: 'sec-workstreams' };

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
      } else if (/^mission-[a-z0-9-]+$/.test(route)) {
        view.innerHTML = pageMission(route);
        const m = missionByRoute(route);
        title = m ? m.name : 'Mission';
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
    // One list of what waits on Vince (Vince, 2026-11-23): the top bar counts the pending actions ready now.
    $('#waitCount').textContent = pending().actions.filter(a => a.state === 'ready').length;
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
