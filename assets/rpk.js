import { readZip, writeZip, crc32, dataOf, dosNow } from './zip.js';

const MAGIC = 'RPK Sig Block 42';
const te = new TextEncoder();
const td = new TextDecoder();

/* ---------- 基础 ---------- */

export function sha256(data) {
  return crypto.subtle.digest('SHA-256', data);
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- DER ---------- */

function derLen(n) {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag, content) {
  return concat([Uint8Array.of(tag), derLen(content.length), content]);
}

const seq = (...parts) => tlv(0x30, concat(parts));
const set = (...parts) => tlv(0x31, concat(parts));

function derInt(bytes) {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = concat([Uint8Array.of(0), b]);
  return tlv(0x02, b);
}

function derOid(str) {
  const parts = str.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [];
    let v = p;
    do { stack.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    bytes.push(...stack);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

const utf8 = s => tlv(0x0c, te.encode(s));
const nullDer = () => tlv(0x05, new Uint8Array(0));

function derTime(d) {
  const p = n => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, te.encode(s));
}

function randomSerial() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[0] &= 0x7f;
  b[0] |= 0x01;
  return b;
}

/* ---------- 证书 ---------- */

const SHA256_RSA = () => seq(derOid('1.2.840.113549.1.1.11'), nullDer());

export async function createIdentity(opts, daysArg = 3650, existingArg = null) {
  let optsObj;
  if (typeof opts === 'string' || opts == null) {
    optsObj = { cn: opts || '', days: daysArg, existing: existingArg };
  } else {
    optsObj = opts;
  }

  const cn = (optsObj.cn || '').trim() || 'RPK Studio';
  const o = (optsObj.o || '').trim();
  const ou = (optsObj.ou || '').trim();
  const c = (optsObj.c || '').trim().toUpperCase().slice(0, 2);
  const days = clampDays(optsObj.days);

  let key = optsObj.key || optsObj.existing?.key;
  let spki = optsObj.existing?.pubDer;
  if (!key) {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']
    );
    key = pair.privateKey;
    spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  }
  if (!spki) spki = await spkiOf(key);

  const now = new Date();
  const exp = new Date(now.getTime() + days * 86400000);

  const rdns = [];
  if (c) rdns.push(set(seq(derOid('2.5.4.6'), utf8(c))));
  if (o) rdns.push(set(seq(derOid('2.5.4.10'), utf8(o))));
  if (ou) rdns.push(set(seq(derOid('2.5.4.11'), utf8(ou))));
  rdns.push(set(seq(derOid('2.5.4.3'), utf8(cn))));
  const name = seq(...rdns);

  const tbs = seq(
    tlv(0xa0, derInt(Uint8Array.of(2))),
    derInt(randomSerial()),
    SHA256_RSA(),
    name,
    seq(derTime(now), derTime(exp)),
    name,
    spki
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, tbs));
  const cert = seq(tbs, SHA256_RSA(), tlv(0x03, concat([Uint8Array.of(0), sig])));

  let pkcs8 = null;
  try { pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)); } catch {}

  return { key, certDer: cert, pubDer: spki, cn, o, ou, c, notBefore: now, notAfter: exp, pkcs8 };
}

function clampDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 3650;
  return Math.min(36500, Math.max(1, Math.round(n)));
}

async function spkiOf(key) {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = await crypto.subtle.importKey(
    'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']
  );
  return new Uint8Array(await crypto.subtle.exportKey('spki', pub));
}

export async function importPrivateKey(input, kind = null) {
  let der = typeof input === 'string' ? pemToDer(input) : input;
  const isPkcs1 = kind === 'pkcs1' || (typeof input === 'string' && /BEGIN RSA PRIVATE KEY/.test(input));
  if (isPkcs1) {
    der = seq(derInt(Uint8Array.of(0)), seq(derOid('1.2.840.113549.1.1.1'), nullDer()), tlv(0x04, der));
  }
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  const spki = await spkiOf(key);
  return { key, pubDer: spki };
}

function readTlv(b, p) {
  const tag = b[p];
  let len = b[p + 1];
  let h = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[p + 2 + i];
    h = 2 + n;
  }
  return { tag, hdr: p, start: p + h, end: p + h + len, next: p + h + len };
}

function children(b, node) {
  const out = [];
  let p = node.start;
  while (p < node.end) {
    const t = readTlv(b, p);
    out.push(t);
    p = t.next;
  }
  return out;
}

function decodeString(b, node) {
  const raw = b.subarray(node.start, node.end);
  if (node.tag === 0x1e) {
    let s = '';
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode((raw[i] << 8) | raw[i + 1]);
    return s;
  }
  return td.decode(raw);
}

function decodeTime(b, node) {
  const s = td.decode(b.subarray(node.start, node.end));
  const m = s.match(/^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?$/);
  if (!m) return null;
  let year = Number(m[1]);
  if (year < 100) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)));
}

export function parseCertificate(der) {
  try {
    const root = readTlv(der, 0);
    const [tbs] = children(der, root);
    const fields = children(der, tbs);
    const idx = fields[0].tag === 0xa0 ? 1 : 0;
    const validity = fields[idx + 3];
    const subject = fields[idx + 4];
    const spki = fields[idx + 5];

    let cn = '';
    for (const rdn of children(der, subject)) {
      for (const atv of children(der, rdn)) {
        const [oidNode, valNode] = children(der, atv);
        const oid = derOidString(der, oidNode);
        if (oid === '2.5.4.3') cn = decodeString(der, valNode);
      }
    }
    const [nb, na] = children(der, validity);
    return {
      cn,
      notBefore: decodeTime(der, nb),
      notAfter: decodeTime(der, na),
      spki: der.subarray(spki.hdr, spki.end).slice(),
      spkiRaw: der.subarray(spki.start, spki.end).slice(),
    };
  } catch {
    return { cn: '', notBefore: null, notAfter: null, spki: null, spkiRaw: null };
  }
}

function derOidString(b, node) {
  const raw = b.subarray(node.start, node.end);
  const parts = [Math.floor(raw[0] / 40), raw[0] % 40];
  let v = 0;
  for (let i = 1; i < raw.length; i++) {
    v = (v << 7) | (raw[i] & 0x7f);
    if (!(raw[i] & 0x80)) { parts.push(v); v = 0; }
  }
  return parts.join('.');
}

/* ---------- 签名块 ---------- */

const MAGIC_BYTES = te.encode(MAGIC);

export function parseSignature(bytes) {
  const magicPos = indexOfBytes(bytes, MAGIC_BYTES);
  if (magicPos < 0) return { present: false };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = v.getInt32(magicPos - 8, true);
  const start = magicPos + 8 - total;
  const end = magicPos + MAGIC_BYTES.length;

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  const cdOffset = v.getUint32(eocd + 16, true);

  const p = start + 8;
  if (v.getInt32(p + 8, true) !== 0x01000101) return { present: false };

  const valueStart = p + 16;
  const sdSize = v.getInt32(valueStart + 4, true);
  const signed = bytes.subarray(valueStart + 8, valueStart + 8 + sdSize);
  const sv = new DataView(signed.buffer, signed.byteOffset, signed.byteLength);

  const hash = signed.subarray(16, 48);
  const certLen = sv.getInt32(52, true);
  const certDer = signed.subarray(56, 56 + certLen);

  const sigPos = valueStart + 8 + sdSize;
  const sigLen = v.getInt32(sigPos + 12, true);
  const signature = bytes.subarray(sigPos + 16, sigPos + 16 + sigLen);
  const pubLen = v.getInt32(sigPos + 16 + sigLen, true);
  const pubDer = bytes.subarray(sigPos + 20 + sigLen, sigPos + 20 + sigLen + pubLen);

  const kv2 = sigPos + 20 + sigLen + pubLen;
  const kv2Id = v.getInt32(kv2 + 8, true);
  let fileHashes = [];
  if (kv2Id === 0x01000201) {
    const valueSize = v.getInt32(kv2 + 12, true);
    fileHashes = readFileHashBlock(bytes.subarray(kv2 + 16, kv2 + 16 + valueSize));
  }

  return {
    present: true, start, end, total, eocd, cdOffset,
    certDer, pubDer, signature, signed, threeWayHash: hash, fileHashes, sdSize,
  };
}

function readFileHashBlock(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 4;
  if (v.getInt32(p, true) !== 0x0103) return [];
  p += 4;
  const out = [];
  while (p + 38 <= buf.length) {
    const nameCrc = v.getUint32(p, true);
    const len = v.getInt16(p + 4, true);
    if (len !== 32) break;
    out.push({ nameCrc, hash: buf.subarray(p + 6, p + 38) });
    p += 38;
  }
  return out;
}

function indexOfBytes(hay, needle) {
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

async function segHash(bytes) {
  const h = new Uint8Array(5 + bytes.length);
  h[0] = 0xa5;
  new DataView(h.buffer).setInt32(1, bytes.length, true);
  h.set(bytes, 5);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', h));
}

/**
 * 对一段 zip 生成签名块并插入到中央目录之前。
 * fileHashes: [{ name, hash }]
 */
async function signZip(zipBytes, fileHashes, key, certDer, pubDer) {
  const v = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  const cdOffset = v.getUint32(eocd + 16, true);

  const header = zipBytes.subarray(0, cdOffset);
  const central = zipBytes.subarray(cdOffset, eocd);
  const footer = zipBytes.slice(eocd);

  const h1 = await segHash(header);
  const h2 = await segHash(central);
  const h3 = await segHash(footer);
  const whole = concat([Uint8Array.of(0x5a), u32(3), h1, h2, h3]);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', whole));

  // signdata: digests + 证书 + 附加位
  const digestEntry = concat([u32(40), u32(0x0103), u32(32), digest]);
  const certEntry = concat([u32(certDer.length), certDer]);
  const sd = concat([u32(digestEntry.length), digestEntry, u32(certEntry.length), certEntry, u32(0)]);

  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, sd));

  const blockSize = 12 + pubDer.length + sd.length + (12 + sig.length);
  const block = concat([
    u32(blockSize), u32(sd.length), sd,
    u32(sig.length + 12), u32(sig.length + 8), u32(0x0103), u32(sig.length), sig,
    u32(pubDer.length), pubDer,
  ]);

  // 文件摘要块
  const entriesParts = fileHashes.map(f => concat([u32(crc32(te.encode(f.name))), Uint8Array.of(32, 0), f.hash]));
  const digestBody = concat([u32(0x0103), ...entriesParts]);
  const fileSig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, digestBody));
  const fileChunk = concat([
    u32(digestBody.length), digestBody,
    u32(fileSig.length + 8), u32(0x0103), u32(fileSig.length), fileSig,
  ]);

  const kv1Size = block.length + 4;
  const kv1 = concat([u32(kv1Size), u32(0), u32(0x01000101), u32(block.length), block]);
  const kv2Size = fileChunk.length + 4;
  const kv2 = concat([u32(kv2Size), u32(0), u32(0x01000201), u32(fileChunk.length), fileChunk]);

  const totalSize = 24 + kv1.length + kv2.length;
  const sigBlock = concat([u32(totalSize), u32(0), kv1, kv2, u32(totalSize), u32(0), MAGIC_BYTES]);

  // 插入并修正中央目录偏移
  const newFooter = footer.slice();
  new DataView(newFooter.buffer).setUint32(16, cdOffset + sigBlock.length, true);
  return concat([header, sigBlock, central, newFooter]);
}

/* ---------- 包解析 ---------- */

const isMeta = name => name.startsWith('META-INF/');
const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

export function pngSize(data) {
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(12) !== 0x49484452) return null;
  return { w: v.getUint32(16), h: v.getUint32(20) };
}
const CERT = 'META-INF/CERT';

const yieldToUI = () => new Promise(resolve => {
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    scheduler.yield().then(resolve, resolve);
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
  ch.port2.postMessage(0);
});

export async function inspect(bytes, onProgress) {
  const report = (stage, done, total) => { try { onProgress?.({ stage, done, total }); } catch {} };
  report('read', 0, 1);
  const { entries, comment } = readZip(bytes);
  const find = name => entries.find(e => e.name === name);

  const readText = name => {
    const e = find(name);
    return e ? td.decode(dataOf(e)) : null;
  };

  let manifest = null;
  try { manifest = JSON.parse(readText('manifest.json')); } catch {}
  let watch = null;
  try { watch = JSON.parse(readText('manifest-watch.json')); } catch {}

  const sig = parseSignature(bytes);
  let verify = null;
  if (sig.present) {
    const header = bytes.subarray(0, sig.start);
    const central = bytes.subarray(sig.cdOffset, sig.eocd);
    const footer = bytes.slice(sig.eocd);
    new DataView(footer.buffer).setUint32(16, sig.start, true);
    const whole = concat([Uint8Array.of(0x5a), u32(3), await segHash(header), await segHash(central), await segHash(footer)]);
    const digestOk = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', whole))) === hex(sig.threeWayHash);

    let rsaOk = false;
    try {
      const pubKey = await crypto.subtle.importKey('spki', sig.pubDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      rsaOk = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubKey, sig.signature, sig.signed);
    } catch {}

    const byCrc = new Map();
    for (const e of entries) if (!e.isDir) byCrc.set(crc32(te.encode(e.name)), e);
    let badFiles = 0;
    const total = sig.fileHashes.length;
    report('verify', 0, total);
    for (let i = 0; i < total; i++) {
      const f = sig.fileHashes[i];
      const e = byCrc.get(f.nameCrc);
      if (!e) badFiles++;
      else if (hex(new Uint8Array(await crypto.subtle.digest('SHA-256', dataOf(e)))) !== hex(f.hash)) badFiles++;
      if (i % 24 === 23) { report('verify', i + 1, total); await yieldToUI(); }
    }
    report('verify', total, total);
    verify = { digestOk, rsaOk, badFiles, fileCount: sig.fileHashes.length, cert: parseCertificate(sig.certDer) };
  }

  report('index', 0, 1);
  const images = entries
    .filter(e => !e.isDir && IMAGE_RE.test(e.name))
    .map(e => ({ name: e.name, bytes: e.usize, w: 0, h: 0, entry: e }));

  const iconPath = manifest?.icon || '/common/icon.png';
  const iconEntry = find(iconPath.replace(/^\//, ''));
  const codeEntry = find('app.jsc') || find('app.js');
  const embedded = codeEntry ? readEmbedded(codeEntry) : null;

  return {
    bytes, entries, comment, manifest, watch, sig, verify, iconEntry, codeEntry, embedded,
    images, icon: iconEntry ? dataOf(iconEntry) : null,
  };
}

export function measureImage(entry) {
  if (!entry) return null;
  try { return pngSize(dataOf(entry)); } catch { return null; }
}

function readEmbedded(entry) {
  const data = dataOf(entry);
  const ascii = '"package":"';
  const isJsc = entry.name.endsWith('.jsc');
  let idx = -1;
  if (isJsc) {
    const u16 = new Uint8Array(ascii.length * 2);
    for (let i = 0; i < ascii.length; i++) { u16[i * 2] = ascii.charCodeAt(i); u16[i * 2 + 1] = 0; }
    idx = indexOfBytes(data, u16);
    if (idx < 0) return null;
    const slice = data.subarray(idx, Math.min(data.length, idx + 300) & ~1);
    return { source: entry.name, jsc: true, text: new TextDecoder('utf-16le').decode(slice).replace(/\u0000/g, '').slice(0, 200) };
  }
  idx = indexOfBytes(data, te.encode(ascii));
  if (idx < 0) return null;
  const slice = data.subarray(idx, Math.min(data.length, idx + 300));
  return { source: entry.name, jsc: false, text: td.decode(slice).slice(0, 200) };
}

/* ---------- 重新打包 ---------- */

export async function repack(pkg, patch, identity, onProgress) {
  const report = (stage, done, total) => { try { onProgress?.({ stage, done, total }); } catch {} };
  report('prepare', 0, 1);
  const entries = pkg.entries.map(e => ({ ...e, reuseRaw: !e.isDir }));

  const setText = (name, text) => {
    const e = entries.find(x => x.name === name);
    if (e) { e.data = te.encode(text); e.method = 8; e.isDir = false; e.reuseRaw = false; e.raw = null; }
    return e;
  };

  if (patch.manifestText) setText('manifest.json', patch.manifestText);
  if (patch.watchText) setText('manifest-watch.json', patch.watchText);

  for (const [name, bytes] of Object.entries(patch.images || {})) {
    let e = entries.find(x => x.name === name);
    if (!e) {
      const now = dosNow();
      e = { name, data: bytes, isDir: false, method: 8, flags: 0, mtime: now.time, mdate: now.date };
      entries.push(e);
    } else {
      e.data = bytes;
      e.method = 8;
      e.reuseRaw = false;
      e.raw = null;
    }
  }

  // 1) 重算 hash.json → CERT
  const digests = {};
  const need = entries.filter(e => !e.isDir && !isMeta(e.name));
  report('digest', 0, need.length);
  let done = 0;
  for (const e of need) {
    digests[e.name] = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', dataOf(e))));
    done++;
    if (done % 24 === 0) { report('digest', done, need.length); await yieldToUI(); }
  }
  report('digest', need.length, need.length);
  const hashJson = te.encode(JSON.stringify({ algorithm: 'SHA-256', digests }));
  const certZip = writeZip([{ name: 'hash.json', data: hashJson, isDir: false, method: 8, flags: 0, ...dosNow() }], '');

  const certHash = new Uint8Array(await crypto.subtle.digest('SHA-256', certZip));
  const signedCert = await signZip(certZip, [{ name: 'hash.json', hash: certHash }], identity.key, identity.certDer, identity.pubDer);

  let certEntry = entries.find(e => e.name === CERT);
  if (!certEntry) {
    const now = dosNow();
    certEntry = { name: CERT, data: signedCert, isDir: false, method: 8, flags: 0, mtime: now.time, mdate: now.date };
    const metaDir = entries.find(e => e.name === 'META-INF/');
    if (!metaDir) {
      entries.unshift({ name: 'META-INF/', data: new Uint8Array(0), isDir: true, method: 0, flags: 0, ...dosNow() });
    }
    entries.splice(1, 0, certEntry);
  } else {
    certEntry.data = signedCert;
    certEntry.method = 8;
    certEntry.reuseRaw = false;
    certEntry.raw = null;
  }

  // 2) 主包签名
  const fileHashes = [];
  fileHashes.push({ name: CERT, hash: new Uint8Array(await crypto.subtle.digest('SHA-256', signedCert)) });
  for (const e of entries) {
    if (e.isDir || e.name === CERT) continue;
    fileHashes.push({ name: e.name, hash: new Uint8Array(await crypto.subtle.digest('SHA-256', e.data)) });
  }

  const comment = patch.comment ?? pkg.comment;
  const zipBytes = writeZip(entries, comment);
  return signZip(zipBytes, fileHashes, identity.key, identity.certDer, identity.pubDer);
}
