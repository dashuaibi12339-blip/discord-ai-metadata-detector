// lib/stealth.js —— NovelAI / stealth_pnginfo 的 alpha 通道 LSB 隱寫讀取
// 位址算法（逐欄排布）：bit k -> 欄 x = floor(k / rows)，列 y = k % rows，其中 rows = min(影像高度, 總位元數)。
// 已用真實 Discord 上的 NovelAI 圖驗證（832x1152，解出 gzip JSON）。
import { gunzip, inflateZlib } from "./zlib.js";

export const STEALTH_MAGIC_COMP = "stealth_pngcomp";   // 15 字元：後接 4 byte big-endian 位元長度 + gzip
export const STEALTH_MAGIC_RAW = "stealth_pnginfo";    // 15 字元：後接 4 byte big-endian 位元長度 + 原始 JSON
const MAGIC_COMP = STEALTH_MAGIC_COMP;
const MAGIC_RAW = STEALTH_MAGIC_RAW;
const MAGIC_LEN = 15;
const PREFIX_BITS = (MAGIC_LEN + 4) * 8;   // 152
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

// 逐欄讀取（格式規定的順序）：bit k 在欄 floor(k/rows)、列 k%rows
function columnReader(rgba, width, height, rows) {
  return function (k) {
    const x = Math.floor(k / rows);
    const y = k - x * rows;
    if (x >= width || y >= height) { return -1; }
    return rgba[(y * width + x) * 4 + 3] & 1;
  };
}
// 逐列讀取（少數其他工具用的順序）
function rasterReader(rgba, width, height) {
  const n = width * height;
  return function (k) { return k < n ? (rgba[(k << 2) + 3] & 1) : -1; };
}
function readBytes(read, startBit, count) {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      const bit = read(startBit + i * 8 + k);
      if (bit < 0) { return null; }
      b = (b << 1) | bit;
    }
    out[i] = b;
  }
  return out;
}
function readMagic(read) {
  const bytes = readBytes(read, 0, MAGIC_LEN);
  if (!bytes) { return ""; }
  let s = "";
  for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
  return s;
}

/**
 * 從 RGBA 像素資料讀取隱寫內容。
 * @returns {Promise<{ok:boolean, json?:string, kind?:string, order?:string, rows?:number}>}
 */
export async function extractStealthFromRgba(rgba, width, height) {
  if (!rgba || !width || !height || width * height < 64) { return { ok: false }; }
  const readers = [
    { name: "column", read: columnReader(rgba, width, height, height) },
    { name: "raster", read: rasterReader(rgba, width, height) },
  ];
  for (const reader of readers) {
    const magic = readMagic(reader.read);
    if (magic !== MAGIC_COMP && magic !== MAGIC_RAW) { continue; }
    const lenBytes = readBytes(reader.read, MAGIC_LEN * 8, 4);
    if (!lenBytes) { continue; }
    const bitLen = ((lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3]) >>> 0;
    if (!bitLen || bitLen % 8 !== 0 || bitLen / 8 > MAX_PAYLOAD_BYTES) { continue; }
    const totalBits = PREFIX_BITS + bitLen;
    // 依格式重算列數：rows = min(高度, 總位元數)
    const rows = Math.min(height, totalBits);
    const fullRead = (reader.name === "column" && rows !== height)
      ? columnReader(rgba, width, height, rows)
      : reader.read;
    const payload = readBytes(fullRead, PREFIX_BITS, bitLen / 8);
    if (!payload) { continue; }
    let text = null;
    if (magic === MAGIC_COMP) {
      const raw = (payload[0] === 0x1f && payload[1] === 0x8b) ? await gunzip(payload) : await inflateZlib(payload);
      text = raw ? new TextDecoder("utf-8", { fatal: false }).decode(raw) : null;
    } else {
      text = new TextDecoder("utf-8", { fatal: false }).decode(payload);
    }
    if (text && text.indexOf("{") !== -1) {
      return { ok: true, json: text, kind: magic === MAGIC_COMP ? "comp" : "raw", order: reader.name, rows: rows };
    }
  }
  return { ok: false };
}

// 瀏覽器端：PNG 位元組 -> RGBA -> 隱寫內容（需要 createImageBitmap / OffscreenCanvas）
export async function extractStealthFromPngBytes(bytes) {
  if (typeof createImageBitmap === "undefined" || typeof OffscreenCanvas === "undefined") { return { ok: false, reason: "no-canvas" }; }
  try {
    const blob = new Blob([bytes], { type: "image/png" });
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    } catch (e) {
      bmp = await createImageBitmap(blob);
    }
    const w = bmp.width, h = bmp.height;
    if (w * h < 64) { return { ok: false }; }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    if (bmp.close) { bmp.close(); }
    const res = await extractStealthFromRgba(img.data, w, h);
    return res;
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}
