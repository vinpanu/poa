// Backup encryption (design-change card POABUILD-52; security review finding 6). Plain ES module with WebCrypto only,
// so the same code runs in the backup Edge Function (Deno), the restore tools and checks (Node 20+) and a browser.
//
// Each copy is encrypted to Vince's public key: a fresh P-256 key pair per copy, ECDH with his public key, HKDF-SHA256
// to an AES-256-GCM key, and the copy's text encrypted with the header (format, kind, as_of) as additional data, so the
// header can't be changed without the copy failing to open. Only his private key, kept in his password manager, can
// open a copy; Supabase holds only the public key, which can encrypt but never decrypt.
// The envelope keeps in the clear only what the backup script needs: kind, as_of, and tables as {} when nothing changed
// or {"encrypted": 1} when something did (the script saves a change copy only when tables has a key). No health data.

export const FORMAT = "poa-backup-encrypted-1";
const INFO = new TextEncoder().encode(FORMAT);
const subtle = globalThis.crypto.subtle;

const b64 = (bytes) => {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aad = (h) => new TextEncoder().encode(`${h.format}|${h.kind}|${h.as_of}`);

function checkPublicJwk(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || "d" in jwk) {
    throw new Error("backup public key must be a P-256 public JWK (kty EC, crv P-256, x, y, no d)");
  }
}

async function aesKey(privateKey, publicKey, usage) {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO }, hk,
    { name: "AES-GCM", length: 256 }, false, [usage]);
}

// text: the copy as the database wrote it; header fields are read from it once, only to fill the envelope.
export async function encryptCopy(text, publicJwk) {
  checkPublicJwk(publicJwk);
  const parsed = JSON.parse(text);
  const header = { format: FORMAT, kind: String(parsed?.kind ?? ""), as_of: String(parsed?.as_of ?? "") };
  const changed = Object.keys(parsed?.tables ?? {}).length > 0;
  const recipient = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y },
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const key = await aesKey(eph.privateKey, recipient, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(header) }, key,
    new TextEncoder().encode(text));
  const epk = await subtle.exportKey("jwk", eph.publicKey);
  return JSON.stringify({
    ...header,
    tables: changed ? { encrypted: 1 } : {},
    alg: "ECDH-ES P-256, HKDF-SHA256, AES-256-GCM",
    epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y },
    iv: b64(iv),
    ct: b64(ct),
  });
}

export const isEncrypted = (text) => {
  try { return JSON.parse(text)?.format === FORMAT; } catch { return false; }
};

// Returns the copy's original text, byte for byte. Throws if the key is wrong or anything in the envelope was changed.
export async function decryptCopy(envelopeText, privateJwk) {
  const e = JSON.parse(envelopeText);
  if (e?.format !== FORMAT) throw new Error("not an encrypted POA backup copy");
  const mine = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, d: privateJwk.d },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const eph = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: e.epk.x, y: e.epk.y },
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const key = await aesKey(mine, eph, "decrypt");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(e.iv), additionalData: aad(e) }, key, unb64(e.ct));
  return new TextDecoder().decode(plain);
}

// For the key page and the checks: a new key pair as JWKs. The private one goes only to Vince's password manager.
export async function newKeyPair() {
  const kp = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = await subtle.exportKey("jwk", kp.publicKey);
  const priv = await subtle.exportKey("jwk", kp.privateKey);
  return {
    publicJwk: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y },
    privateJwk: { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, d: priv.d },
  };
}
