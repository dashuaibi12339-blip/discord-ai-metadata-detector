// lib/webp.js —— WebP（RIFF 容器）解析，取出 EXIF / XMP chunk
import { u32le, u16le, u24le, ascii, decodeBytesSmart } from "./util.js";

export function isWebp(b) {
  return b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP";
}

export function parseWebp(b) {
  const out = {
    format: "webp", width: 0, height: 0, exifBytes: null, xmp: null,
    riffSize: 0, chunks: [], truncated: false, animated: false,
    sawImageData: false, pendingFetch: 0, skipTo: 0,
  };
  if (!isWebp(b)) { return null; }
  out.riffSize = u32le(b, 4) + 8;
  let o = 12;
  while (o + 8 <= b.length) {
    const type = ascii(b, o, 4);
    const size = u32le(b, o + 4);
    const dataStart = o + 8;
    const dataEnd = dataStart + size;
    out.chunks.push({ type: type, size: size });
    if (type === "VP8X" && dataStart + 10 <= b.length) {
      const flags = b[dataStart];
      out.animated = (flags & 0x02) !== 0;
      out.width = u24le(b, dataStart + 4) + 1;
      out.height = u24le(b, dataStart + 7) + 1;
    } else if (type === "VP8 " && dataStart + 10 <= b.length) {
      out.width = u16le(b, dataStart + 6) & 0x3fff;
      out.height = u16le(b, dataStart + 8) & 0x3fff;
    } else if (type === "VP8L" && dataStart + 5 <= b.length) {
      const bits = (b[dataStart + 1] | (b[dataStart + 2] << 8) | (b[dataStart + 3] << 16) | (b[dataStart + 4] << 24)) >>> 0;
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >> 14) & 0x3fff) + 1;
    }
    if (dataEnd > b.length) {
      out.truncated = true;
      if (type === "EXIF" || type === "XMP ") { out.pendingFetch = Math.max(out.pendingFetch, dataEnd + (size % 2)); }
      else { out.skipTo = dataEnd + (size % 2); }   // 影像資料：可依 chunk 表直接跳到下一個 chunk
      break;
    }
    if (type === "VP8 " || type === "VP8L" || type === "ANMF" || type === "ALPH") { out.sawImageData = true; }
    if (type === "EXIF") {
      out.exifBytes = b.slice(dataStart, dataEnd);
    } else if (type === "XMP ") {
      out.xmp = decodeBytesSmart(b.subarray(dataStart, dataEnd));
    }
    o = dataEnd + (size % 2);
  }
  return out;
}

// 當只抓到檔案尾段時，用寬鬆方式尋找 EXIF / XMP chunk
export function scanWebpChunksInFragment(b) {
  const found = { exifBytes: null, xmp: null };
  const types = ["EXIF", "XMP "];
  for (const t of types) {
    for (let i = 0; i + 8 <= b.length; i++) {
      if (ascii(b, i, 4) !== t) { continue; }
      const size = u32le(b, i + 4);
      if (size === 0 || size > 4 * 1024 * 1024) { continue; }
      const start = i + 8;
      const end = Math.min(start + size, b.length);
      if (end - start < 8) { continue; }
      if (t === "EXIF") { found.exifBytes = b.slice(start, end); }
      else { found.xmp = decodeBytesSmart(b.subarray(start, end)); }
      found.partial = true;
      return found;
    }
  }
  return found;
}
