// test/png-rgba.mjs —— 測試用：把非交錯、8bit 的 RGB/RGBA PNG 解成 RGBA（驗證 alpha 隱寫）
import zlib from "node:zlib";
import { u32be, ascii } from "../lib/util.js";

export function decodePngToRgba(buf) {
  let o = 8, w = 0, h = 0, colorType = 0, bitDepth = 8, interlace = 0;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = u32be(buf, o);
    const type = ascii(buf, o + 4, 4);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = u32be(data, 0); h = u32be(data, 4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") { idat.push(Buffer.from(data)); }
    else if (type === "IEND") { break; }
    o = o + 8 + len + 4;
  }
  if (bitDepth !== 8 || interlace !== 0) { return { error: "只支援 bitDepth=8、非交錯" }; }
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch) { return { error: "只支援 RGB/RGBA（colorType=" + colorType + "）" }; }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v;
      if (f === 0) { v = x; } else if (f === 1) { v = x + a; } else if (f === 2) { v = x + b; }
      else if (f === 3) { v = x + ((a + b) >> 1); }
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)); }
      cur[i] = v & 0xff;
    }
    p += stride;
    for (let x2 = 0; x2 < w; x2++) {
      const si = x2 * ch, di = (y * w + x2) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = ch === 4 ? cur[si + 3] : 255;
    }
    prev.set(cur);
  }
  return { w, h, rgba: out };
}
