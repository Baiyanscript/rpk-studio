import { deflateSync, inflateSync } from '../vendor/fflate.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const td = new TextDecoder();
const te = new TextEncoder();

function dv(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function readZip(bytes) {
  const v = dv(bytes);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到中央目录，文件可能不是 ZIP/RPK');

  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  const commentLen = v.getUint16(eocd + 20, true);
  const comment = td.decode(bytes.subarray(eocd + 22, eocd + 22 + commentLen));

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) break;
    const e = {
      flags: v.getUint16(p + 8, true),
      method: v.getUint16(p + 10, true),
      mtime: v.getUint16(p + 12, true),
      mdate: v.getUint16(p + 14, true),
      crc: v.getUint32(p + 16, true),
      csize: v.getUint32(p + 20, true),
      usize: v.getUint32(p + 24, true),
      nameLen: v.getUint16(p + 28, true),
      extraLen: v.getUint16(p + 30, true),
      cmtLen: v.getUint16(p + 32, true),
      lho: v.getUint32(p + 42, true),
    };
    e.name = td.decode(bytes.subarray(p + 46, p + 46 + e.nameLen));
    const lnameLen = v.getUint16(e.lho + 26, true);
    const lextraLen = v.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + lnameLen + lextraLen;
    e.raw = bytes.subarray(start, start + e.csize);
    e.data = null;
    e.isDir = e.name.endsWith('/');
    entries.push(e);
    p += 46 + e.nameLen + e.extraLen + e.cmtLen;
  }
  return { entries, comment, eocd, cdOffset };
}

export function dataOf(entry) {
  if (entry.isDir) return new Uint8Array(0);
  if (!entry.data) {
    entry.data = entry.method === 0 ? entry.raw : inflateSync(entry.raw);
  }
  return entry.data;
}

export function dosNow(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 按给定顺序写 ZIP。目录项保持 store，其余用 DEFLATE level 9。
 */
export function writeZip(entries, comment = '') {
  const chunks = [];
  const central = [];
  let offset = 0;
  const cmt = te.encode(comment);

  for (const e of entries) {
    const nameBytes = te.encode(e.name);
    const useRaw = Boolean(e.reuseRaw && e.raw && !e.isDir);
    const data = useRaw ? null : dataOf(e);
    const crc = useRaw ? e.crc : (e.isDir ? 0 : crc32(data));
    const method = useRaw ? e.method : (e.isDir ? 0 : 8);
    const packed = useRaw ? e.raw : (e.isDir ? new Uint8Array(0) : deflateSync(data, { level: 9 }));
    const usize = useRaw ? e.usize : (e.isDir ? 0 : data.length);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags & 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, e.mtime, true);
    lv.setUint16(12, e.mdate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, usize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    chunks.push(lh, packed);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags & 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, e.mtime, true);
    cv.setUint16(14, e.mdate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, usize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + packed.length;
  }

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22 + cmt.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, cmt.length, true);
  eocd.set(cmt, 22);

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}
