// lib/png-alpha.js —— 純 JS 的 PNG alpha 解碼（不用 canvas）
// 用途一：隱寫「低成本預檢」——只需要前 152 列就能判斷有沒有 stealth 資料。
// 用途二：完整讀取隱寫 payload（解到需要的列數即可，不必碰 RGB）。
import { u32be, ascii } from "./util.js";
import { inflateZlib, inflatePartial, gunzip } from "./zlib.js";
import { STEALTH_MAGIC_COMP, STEALTH_MAGIC_RAW } from "./stealth.js";

const MAGIC_LEN = 15;
const PREFIX_BITS = (MAGIC_LEN + 4) * 8;   // 152

export function pngInfo(bytes) {
  if (!bytes || bytes.length < 33) { return null; }
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) { return null; }
  const out = { width: 0, height: 0, bitDepth: 8, colorType: 0, interlace: 0, idat: [], partialIdat: false, sawIend: false };
  let o = 8;
  while (o + 8 <= bytes.length) {
    const len = u32be(bytes, o);
    const type = ascii(bytes, o + 4, 4);
    const dataStart = o + 8;
    const dataEnd = dataStart + len;
    if (type === "IHDR" && dataEnd <= bytes.length) {
      out.width = u32be(bytes, dataStart);
      out.height = u32be(bytes, dataStart + 4);
      out.bitDepth = bytes[dataStart + 8];
      out.colorType = bytes[dataStart + 9];
      out.interlace = bytes[dataStart + 12];
    } else if (type === "IDAT") {
      if (dataEnd > bytes.length) { out.partialIdat = true; out.idat.push(bytes.subarray(dataStart, bytes.length)); break; }
      out.idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") { out.sawIend = true; break; }
    if (dataEnd + 4 > bytes.length) { break; }
    o = dataEnd + 4;
  }
  if (!out.width || !out.height) { return null; }
  return out;
}

function concatIdat(list) {
  let n = 0;
  for (const p of list) { n += p.length; }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of list) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * 解出前 maxRows 列（只保留 alpha）。位元組不足時回傳已解出的部分（不會拋例外）。
 * @returns {Promise<{info:object, rows:Uint8Array[], rowsDecoded:number, complete:boolean, error?:string}>}
 */
export async function decodeAlphaRows(bytes, maxRows) {
  const info = pngInfo(bytes);
  if (!info) { return { error: "not-png", rows: [], rowsDecoded: 0 }; }
  if (info.bitDepth !== 8 || info.interlace !== 0) { return { info: info, error: "unsupported-format", rows: [], rowsDecoded: 0 }; }
  const ch = info.colorType === 6 ? 4 : info.colorType === 2 ? 3 : 0;
  if (!ch) { return { info: info, error: "unsupported-color-type", rows: [], rowsDecoded: 0 }; }
  // 用「容忍截斷」的解壓：位元組不完整時也能拿到已解出的部分
  let raw = await inflatePartial(concatIdat(info.idat), 80);
  if (!raw && info.sawIend) { raw = await inflateZlib(concatIdat(info.idat)); }
  if (!raw) { return { info: info, error: "inflate-failed", rows: [], rowsDecoded: 0 }; }
  const stride = info.width * ch;
  const want = Math.min(maxRows || info.height, info.height);
  const rows = [];
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < want; y++) {
    if (p + 1 + stride > raw.length) { break; }
    const f = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v;
      if (f === 0) { v = x; }
      else if (f === 1) { v = x + a; }
      else if (f === 2) { v = x + b; }
      else if (f === 3) { v = x + ((a + b) >> 1); }
      else {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      }
      cur[i] = v & 0xff;
    }
    p += stride;
    const alpha = new Uint8Array(info.width);
    if (ch === 4) { for (let x2 = 0; x2 < info.width; x2++) { alpha[x2] = cur[x2 * 4 + 3]; } }
    else { alpha.fill(255); }
    rows.push(alpha);
    prev.set(cur);
  }
  return { info: info, rows: rows, rowsDecoded: rows.length, complete: rows.length >= info.height };
}

// 逐欄位址：bit k -> 欄 floor(k / rows)、列 k % rows
function bitAt(rows, width, height, rowCount, k) {
  const x = Math.floor(k / rowCount);
  const y = k - x * rowCount;
  if (x >= width || y >= height || y >= rows.length) { return -1; }
  return rows[y][x] & 1;
}
function readBytesAt(rows, width, height, rowCount, startBit, count) {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      const bit = bitAt(rows, width, height, rowCount, startBit + i * 8 + k);
      if (bit < 0) { return null; }
      b = (b << 1) | bit;
    }
    out[i] = b;
  }
  return out;
}
function magicOf(rows, width, height, rowCount) {
  const bytes = readBytesAt(rows, width, height, rowCount, 0, MAGIC_LEN);
  if (!bytes) { return ""; }
  let s = "";
  for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
  return s;
}

/**
 * 低成本預檢：只解前 200 列，看前 152 bit 是不是隱寫 magic。
 * status: no-channel（沒有 alpha 通道，不可能有 alpha LSB）| negative（有 alpha 但沒有隱寫）|
 *         positive（確認有隱寫）| need-more（位元組不足，需再抓）| unsupported
 */
export async function probeStealthPrefix(bytes) {
  const info = pngInfo(bytes);
  if (!info) { return { status: "unsupported", reason: "無法解析 PNG 標頭" }; }
  if (info.colorType !== 6) { return { status: "no-channel", reason: "這張 PNG 沒有 alpha 通道" }; }
  if (info.width * info.height < 4096) { return { status: "unsupported", reason: "圖片太小" }; }
  if (info.bitDepth !== 8 || info.interlace !== 0) { return { status: "unsupported", reason: "非 8bit 或交錯 PNG" }; }
  if (info.height < PREFIX_BITS) { return { status: "unsupported", reason: "高度不足 152 列" }; }
  const dec = await decodeAlphaRows(bytes, 200);
  if (!dec.rowsDecoded || dec.rowsDecoded < PREFIX_BITS) {
    return { status: "need-more", rowsDecoded: dec.rowsDecoded || 0, reason: "目前位元組不足以解出前 152 列" };
  }
  const magic = magicOf(dec.rows, info.width, info.height, info.height);
  if (magic === STEALTH_MAGIC_COMP) { return { status: "positive", kind: "comp", width: info.width, height: info.height }; }
  if (magic === STEALTH_MAGIC_RAW) { return { status: "positive", kind: "raw", width: info.width, height: info.height }; }
  return { status: "negative", width: info.width, height: info.height };
}

/**
 * 完整讀取純 JS 隱寫內容（需要（幾乎）完整的檔案位元組）。
 * @returns {Promise<{ok:boolean, json?:string, kind?:string, order?:string, reason?:string}>}
 */
export async function extractStealthFromPngBytesPure(bytes) {
  const info = pngInfo(bytes);
  if (!info) { return { ok: false, reason: "not-png" }; }
  if (info.colorType !== 6) { return { ok: false, reason: "no-alpha-channel" }; }
  if (info.bitDepth !== 8 || info.interlace !== 0) { return { ok: false, reason: "unsupported-format" }; }
  if (info.height < PREFIX_BITS) { return { ok: false, reason: "too-small" }; }
  const first = await decodeAlphaRows(bytes, PREFIX_BITS + 8);
  if (first.rowsDecoded < PREFIX_BITS) { return { ok: false, reason: "need-more-bytes" }; }
  const magic = magicOf(first.rows, info.width, info.height, info.height);
  if (magic !== STEALTH_MAGIC_COMP && magic !== STEALTH_MAGIC_RAW) { return { ok: false, reason: "no-magic" }; }
  const lenBytes = readBytesAt(first.rows, info.width, info.height, info.height, MAGIC_LEN * 8, 4);
  if (!lenBytes) { return { ok: false, reason: "need-more-bytes" }; }
  const bitLen = ((lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3]) >>> 0;
  if (!bitLen || bitLen % 8 !== 0 || bitLen / 8 > 8 * 1024 * 1024) { return { ok: false, reason: "bad-length" }; }
  const totalBits = PREFIX_BITS + bitLen;
  const rows = Math.min(info.height, totalBits);
  const dec = rows <= first.rowsDecoded ? first : await decodeAlphaRows(bytes, rows);
  if (dec.rowsDecoded < rows) { return { ok: false, reason: "need-more-bytes" }; }
  const payload = readBytesAt(dec.rows, info.width, info.height, rows, PREFIX_BITS, bitLen / 8);
  if (!payload) { return { ok: false, reason: "need-more-bytes" }; }
  let text = null;
  if (magic === STEALTH_MAGIC_COMP) {
    const raw = (payload[0] === 0x1f && payload[1] === 0x8b) ? await gunzip(payload) : await inflateZlib(payload);
    text = raw ? new TextDecoder("utf-8", { fatal: false }).decode(raw) : null;
  } else {
    text = new TextDecoder("utf-8", { fatal: false }).decode(payload);
  }
  if (!text || text.indexOf("{") === -1) { return { ok: false, reason: "decode-failed" }; }
  return { ok: true, json: text, kind: magic === STEALTH_MAGIC_COMP ? "comp" : "raw", order: "column", rows: rows };
}
