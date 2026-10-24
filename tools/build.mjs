// Reads the POA feed, encrypts it with the site password and writes data/key.json,
// data/data.enc and data/diagrams.enc. Runs in GitHub Actions (see .github/workflows/build.yml).
//
// Environment:
//   SITE_PASSWORD     the site password (GitHub secret; at least 12 characters)
//   FEED_URL          the Apps Script web app URL (GitHub secret)
//   REFRESH_DIAGRAMS  "true" to re-read the diagrams as well
//   FEED_FILE, DIAGRAMS_FILE  local JSON files to use instead of FEED_URL (for testing)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

const ITERATIONS = 600000;
const DATA_DIR = new URL('../data/', import.meta.url);
const { SITE_PASSWORD, FEED_URL, FEED_FILE, DIAGRAMS_FILE, REFRESH_DIAGRAMS } = process.env;

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
if (!FEED_URL && !FEED_FILE) stop('the FEED_URL secret is not set.');

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

async function readJson(name) {
  const url = new URL(name, DATA_DIR);
  return existsSync(url) ? JSON.parse(await readFile(url, 'utf8')) : null;
}

async function writeJson(name, value) {
  await writeFile(new URL(name, DATA_DIR), JSON.stringify(value));
}

async function getFeed(part, file) {
  if (file) return JSON.parse(await readFile(file, 'utf8'));
  const url = FEED_URL + (FEED_URL.includes('?') ? '&' : '?') + 'part=' + part;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || 'the feed reported a problem');
      return body;
    } catch (e) {
      if (attempt === 2) stop('could not read the feed (' + part + '): ' + e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
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
const feed = await getFeed('data', FEED_FILE);
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

// 3. Diagrams: once a day, on request, or after a password change.
if (rekeyed || REFRESH_DIAGRAMS === 'true' || !existsSync(new URL('diagrams.enc', DATA_DIR))) {
  const diagrams = await getFeed('diagrams', DIAGRAMS_FILE);
  if (!Array.isArray(diagrams.diagrams) || !diagrams.diagrams.length) stop('the feed returned no diagrams.');
  await writeJson('diagrams.enc', await seal(key, { builtAt: new Date().toISOString(), diagrams: diagrams.diagrams }));
  console.log('Diagrams updated: ' + diagrams.diagrams.length + '.');
}
