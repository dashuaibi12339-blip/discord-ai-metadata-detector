// lib/jpeg.js —— JPEG 段落掃描，取出 APP1 EXIF / APP1 XMP / COM 註解
import { u16be, ascii, decodeBytesSmart } from "./util.js";

const XMP_NS = "http://ns.adobe.com/xap/1.0/";

export function isJpeg(b) {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8;
}

export function parseJpeg(b) {
  const out = { format: "jpeg", exifBytes: null, xmp: null, comment: null, segments: [], truncated: false, width: 0, height: 0,
    reachedSos: false, sawMetadata: false, pendingFetch: 0, needProbe: false };
  if (!isJpeg(b)) { return null; }
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) {
      // 跳過填充位元組
      o++;
      continue;
    }
    let marker = b[o + 1];
    if (marker === 0xff) { o++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
    if (marker === 0xda) {
      // SOS：之後是壓縮資料，中繼資料都在前面
      out.reachedSos = true;
      break;
    }
    const len = u16be(b, o + 2);
    if (len < 2) { break; }
    const start = o + 4;
    const end = o + 2 + len;
    out.segments.push("FF" + marker.toString(16).toUpperCase());
    if (end > b.length) {
      // 段落不完整：仍嘗試處理已到手的部分
      if (start < b.length) { handleSegment(out, b, marker, start, b.length); }
      out.truncated = true;
      if (marker === 0xe1 || marker === 0xfe) { out.pendingFetch = Math.max(out.pendingFetch, end); }
      else { out.needProbe = true; }
      break;
    }
    handleSegment(out, b, marker, start, end);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (start + 5 <= end) {
        out.height = u16be(b, start + 1);
        out.width = u16be(b, start + 3);
      }
    }
    o = end;
  }
  return out;
}

function handleSegment(out, b, marker, start, end) {
  if (marker === 0xe1) {
    const head = ascii(b, start, 6);
    if (head === "Exif\0\0" || head.slice(0, 4) === "Exif") {
      out.exifBytes = b.slice(start, end);
      if (end > start + 8) { out.sawMetadata = true; }
    } else if (ascii(b, start, XMP_NS.length) === XMP_NS) {
      out.xmp = decodeBytesSmart(b.subarray(start + XMP_NS.length + 1, end));
      if (out.xmp) { out.sawMetadata = true; }
    }
  } else if (marker === 0xfe) {
    out.comment = decodeBytesSmart(b.subarray(start, end)).replace(/\0+$/g, "").trim();
    if (out.comment) { out.sawMetadata = true; }
  }
}
