// Reads the POA feed, encrypts it with the site password and writes data/key.json, data/data.enc,
// and the document copies: data/docs.enc (the list of copies and the diagrams), data/docs/<key>.enc
// (one per copy) and data/img/<id>.bin (images, stored once each). Runs in GitHub Actions (see
// .github/workflows/build.yml).
//
// Environment:
//   SITE_PASSWORD     the site password (GitHub secret; at least 12 characters)
//   FEED_URL          the Apps Script web app URL (GitHub secret)
//   FEED_FILE         a local JSON file to use instead of the feed's project data (for testing)
//   COPIES_DIR        a local folder with list.json and <key>.json to use instead of the feed's
//                     document copies (for testing)

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 600000;
const DATA_DIR = new URL('../data/', import.meta.url);
const { SITE_PASSWORD, FEED_URL, FEED_FILE, COPIES_DIR } = process.env;

const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = buf => Buffer.from(buf).toString('base64');
const fromB64 = s => new Uint8Array(Buffer.from(s, 'base64'));

function stop(message) {
  console.error('Build stopped: ' + message);
  process.exit(1);
}

if (!SITE_PASSWORD) stop('the SITE_PASSWORD secret is not set.');
if (SITE_PASSWORD.length < 12) stop('the site password must be at least 12 characters long.');
if (!FEED_URL && !(FEED_FILE && COPIES_DIR)) stop('the FEED_URL secret is not set.');

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// Images are stored as raw bytes: the 12-byte IV, then the AES-GCM ciphertext.
async function sealBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return Buffer.concat([iv, Buffer.from(ct)]);
}

async function readJson(name) {
  const url = new URL(name, DATA_DIR);
  return existsSync(url) ? JSON.parse(await readFile(url, 'utf8')) : null;
}

async function writeJson(name, value) {
  await writeFile(new URL(name, DATA_DIR), JSON.stringify(value));
}

async function fetchFeed(part, extra = '') {
  const url = FEED_URL + (FEED_URL.includes('?') ? '&' : '?') + 'part=' + part + extra;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || 'the feed reported a problem');
      return body;
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error('could not read the feed (' + part + extra + '): ' + last.message);
}

async function digest(value) {
  return toB64(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(value))));
}

await mkdir(DATA_DIR, { recursive: true });

// 1. The key. The salt is kept while the password stays the same; a new password gets a
//    new salt, and everything is encrypted again so the old password stops working.
let keyInfo = await readJson('key.json');
let key = null;
if (keyInfo) {
  try {
    const candidate = await deriveKey(SITE_PASSWORD, fromB64(keyInfo.salt));
    if ((await unseal(candidate, keyInfo.check)) === 'POA') key = candidate;
  } catch { key = null; }
}
const rekeyed = !key;
if (rekeyed) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  key = await deriveKey(SITE_PASSWORD, salt);
  keyInfo = { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toB64(salt), check: await seal(key, 'POA') };
  await writeJson('key.json', keyInfo);
  console.log('First build or new password: encrypting all content again.');
}

// 2. Project data. Only rewritten when something changed, so the site keeps its history clean.
let feed;
try {
  feed = FEED_FILE ? JSON.parse(await readFile(FEED_FILE, 'utf8')) : await fetchFeed('data');
} catch (e) { stop(e.message); }
if (!Array.isArray(feed.workstreams) || !feed.workstreams.length) stop('the feed returned no workstreams.');
const { generatedAt, ...stable } = feed;
const hash = await digest(stable);
let previous = null;
const previousBox = await readJson('data.enc');
if (previousBox && !rekeyed) {
  try { previous = await unseal(key, previousBox); } catch { previous = null; }
}
if (rekeyed || !previous || previous.hash !== hash) {
  await writeJson('data.enc', await seal(key, { hash, builtAt: new Date().toISOString(), feed }));
  console.log('Project data updated.');
} else {
  console.log('Project data unchanged.');
}

// 3. Document copies, and the diagrams, which are figures inside them. A copy is read again only
//    when its content fingerprint changes. Each image is stored once, under a name taken from its
//    content, so an unchanged image is never written again. A copy that can't be read keeps its
//    last version; it never stops the project data above from publishing.
const copyFeed = async (part, k) => COPIES_DIR
  ? JSON.parse(await readFile(join(COPIES_DIR, (k || 'list') + '.json'), 'utf8'))
  : fetchFeed(part, k ? '&key=' + encodeURIComponent(k) : '');
const salt = fromB64(keyInfo.salt);
const imageId = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.concat([salt, bytes]))).toString('hex').slice(0, 32);
const inData = name => new URL(name, DATA_DIR);

let list = null;
try {
  list = await copyFeed('docs');
  if (!Array.isArray(list.docs) || !list.docs.length) throw new Error('the feed listed no documents');
} catch (e) {
  console.log('Document copies skipped this time: ' + e.message);
  list = null;
}
if (list) {
  await mkdir(inData('docs/'), { recursive: true });
  await mkdir(inData('img/'), { recursive: true });
  let index = null;
  const indexBox = rekeyed ? null : await readJson('docs.enc');
  if (indexBox) {
    try { index = await unseal(key, indexBox); } catch { index = null; }
  }
  const docs = {};
  for (const d of list.docs) {
    const prev = index && index.docs[d.key];
    const file = 'docs/' + d.key + '.enc';
    if (d.error) {
      console.log('Copy not read (' + d.key + '): ' + d.error);
      if (prev) docs[d.key] = prev;
      continue;
    }
    if (prev && prev.rev === d.rev && existsSync(inData(file))) { docs[d.key] = prev; continue; }
    try {
      const full = await copyFeed('doc', d.key);
      const images = [];
      for (const im of full.images || []) {
        if (im.missing || !im.b64) { images.push({ missing: true, alt: im.alt || '' }); continue; }
        const bytes = fromB64(im.b64);
        const id = await imageId(bytes);
        if (!existsSync(inData('img/' + id + '.bin'))) await writeFile(inData('img/' + id + '.bin'), await sealBytes(key, bytes));
        images.push({ id, mime: im.mime || 'image/png', w: im.w || 0, alt: im.alt || '' });
      }
      const builtAt = new Date().toISOString();
      await writeJson(file, await seal(key, {
        key: d.key, kind: full.kind, title: full.title, original: full.original, builtAt,
        blocks: full.blocks || [], sheets: full.sheets || [], images,
      }));
      docs[d.key] = {
        title: full.title, kind: full.kind, rev: full.rev || d.rev, builtAt,
        images: images.filter(i => i.id).map(i => i.id),
        // In document order, so the diagrams can name a figure by its position.
        figures: (full.figures || []).map(f => images[f.i] && images[f.i].id ? { img: images[f.i].id, mime: images[f.i].mime, cap: f.cap || '' } : null),
      };
      console.log('Copy updated: ' + d.key + '.');
    } catch (e) {
      console.log('Copy not updated (' + d.key + '): ' + e.message);
      if (prev) docs[d.key] = prev;
    }
  }
  const diagrams = (list.diagrams || []).map(g => {
    const f = docs[g.copy] && docs[g.copy].figures[g.index];
    return f ? { key: g.key, title: g.title, source: g.source, copy: g.copy, caption: f.cap, img: f.img, mime: f.mime } : null;
  }).filter(Boolean);
  const next = { docs, diagrams };
  if (rekeyed || !index || (await digest({ docs: index.docs, diagrams: index.diagrams })) !== (await digest(next))) {
    await writeJson('docs.enc', await seal(key, { ...next, builtAt: new Date().toISOString() }));
    console.log('Copy list updated: ' + Object.keys(docs).length + ' copies, ' + diagrams.length + ' diagrams.');
  } else {
    console.log('Copies unchanged.');
  }

  // Remove what no copy uses any more: copies dropped from the feed, images no longer in any copy,
  // and files written under an earlier password.
  const keep = new Set(Object.values(docs).flatMap(d => d.images));
  for (const f of await readdir(inData('img/'))) {
    if (/^[0-9a-f]{32}\.bin$/.test(f) && !keep.has(f.slice(0, 32))) await unlink(inData('img/' + f));
  }
  for (const f of await readdir(inData('docs/'))) {
    if (/\.enc$/.test(f) && !docs[f.replace(/\.enc$/, '')]) await unlink(inData('docs/' + f));
  }
}

// The diagrams used to have a file of their own; they now come from the copies.
if (existsSync(inData('docs.enc')) && existsSync(inData('diagrams.enc'))) await unlink(inData('diagrams.enc'));
