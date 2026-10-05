// lib/exif.js —— TIFF/EXIF 解析（JPEG APP1、PNG eXIf、WebP EXIF chunk 皆可）
import { u16be, u32be, decodeBytesSmart, decodeUtf16 } from "./util.js";

const TAGS_IFD0 = {
  0x0100: "Image Width", 0x0101: "Image Height", 0x010e: "Image Description",
  0x010f: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x011a: "X Resolution",
  0x011b: "Y Resolution", 0x0128: "Resolution Unit", 0x0131: "Software",
  0x0132: "Date/Time", 0x013b: "Artist", 0x8298: "Copyright",
  0x9c9b: "XPTitle", 0x9c9c: "Windows XP Comment", 0x9c9d: "XPAuthor",
  0x9c9e: "XPKeywords", 0x9c9f: "XPSubject", 0x9286: "User Comment",
  0x8769: "Exif Offset", 0x8825: "GPS Offset",
};
const TAGS_EXIF = {
  0x829a: "Exposure Time", 0x829d: "F Number", 0x8827: "ISO Speed Ratings",
  0x9000: "Exif Version", 0x9003: "Date/Time Original", 0x9004: "Date/Time Digitized",
  0x9201: "Shutter Speed Value", 0x9202: "Aperture Value", 0x9204: "Exposure Bias Value",
  0x9209: "Flash", 0x9286: "User Comment", 0x9290: "Sub-second Time", 0x9291: "Sub-second Time Original",
  0xa001: "Color Space", 0xa002: "Exif Image Width", 0xa003: "Exif Image Height",
  0xa402: "Exposure Mode", 0xa403: "White Balance", 0xa406: "Scene Capture Type",
  0xa430: "Camera Owner Name", 0xa431: "Body Serial Number", 0xa433: "Lens Make", 0xa434: "Lens Model",
  0x8769: "Exif Offset",
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export function stripExifHeader(bytes) {
  if (bytes && bytes.length >= 6 && bytes[0] === 0x45 && bytes[1] === 0x78 && bytes[2] === 0x69 && bytes[3] === 0x66) {
    return bytes.subarray(6);
  }
  return bytes;
}

export function parseExif(bytes) {
  const tiff = stripExifHeader(bytes);
  if (!tiff || tiff.length < 8) { return null; }
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!little && !big) { return null; }
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const r16 = (o) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false));
  const r32 = (o) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false));
  if (r16(2) !== 42) { return null; }
  const out = { entries: [], littleEndian: little };
  try {
    const ifd0Off = r32(4);
    readIfd(tiff, dv, little, ifd0Off, TAGS_IFD0, "Exif IFD0", out, true);
  } catch (e) {
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

function readIfd(bytes, dv, little, offset, tags, group, out, isMain) {
  if (offset <= 0 || offset + 2 > bytes.length) { return; }
  const r16 = (o) => (little ? dv.getUint16(o, true) : dv.getUint16(o, false));
  const r32 = (o) => (little ? dv.getUint32(o, true) : dv.getUint32(o, false));
  const count = r16(offset);
  if (count > 512) { return; }
  let exifPtr = 0, gpsPtr = 0;
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > bytes.length) { break; }
    const tag = r16(e);
    const type = r16(e + 2);
    const num = r32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * num;
    let valueOff = e + 8;
    let inline = true;
    if (size > 4) {
      const ptr = r32(e + 8);
      if (ptr + size > bytes.length) { continue; }
      valueOff = ptr;
      inline = false;
    }
    if (size > 1024 * 1024) { continue; }
    const name = tags[tag] || ("Tag 0x" + tag.toString(16));
    if (tag === 0x8769) { exifPtr = r32(e + 8); continue; }
    if (tag === 0x8825) { gpsPtr = r32(e + 8); continue; }
    const value = decodeValue(bytes, dv, little, type, num, valueOff, tag);
    if (value === null || value === "") { continue; }
    out.entries.push({ group: group, name: name, value: value, tag: tag, type: type });
  }
  // 下一層 IFD
  const nextOff = offset + 2 + count * 12;
  if (nextOff + 4 <= bytes.length) {
    const next = r32(nextOff);
    if (next > 0 && next !== offset && out.entries.length < 512) {
      // IFD1 通常是縮圖，忽略以免混入提示詞
    }
  }
  if (isMain && exifPtr > 0) {
    readIfd(bytes, dv, little, exifPtr, TAGS_EXIF, "Exif SubIFD", out, false);
  }
}

function decodeValue(bytes, dv, little, type, num, valueOff, tag) {
  const isXp = tag >= 0x9c9b && tag <= 0x9c9f;
  if (isXp) {
    const raw = bytes.subarray(valueOff, valueOff + num);
    return decodeUtf16(raw, true).trim();
  }
  if (type === 2) {
    const n = num;
    const raw = bytes.subarray(valueOff, valueOff + n);
    let end = raw.length;
    while (end > 0 && raw[end - 1] === 0) { end--; }
    return decodeBytesSmart(raw.subarray(0, end)).trim();
  }
  if (type === 7) {
    const raw = bytes.subarray(valueOff, valueOff + num);
    if (tag === 0x9286) { return decodeUserComment(raw); }
    return decodeBytesSmart(raw).replace(/\0+$/g, "").trim();
  }
  if (type === 1 || type === 6) {
    const raw = bytes.subarray(valueOff, valueOff + num);
    if (isXp) { return decodeUtf16(raw, true).trim(); }
    if (num <= 4) { return String(raw[0]); }
    return decodeBytesSmart(raw).replace(/\0+$/g, "").trim();
  }
  if (type === 3) { return String(num <= 2 && valueOff + 2 <= bytes.length ? (little ? dv.getUint16(valueOff, true) : dv.getUint16(valueOff, false)) : readArray(dv, little, 2, num, valueOff)); }
  if (type === 4 || type === 9) { return String(readArray(dv, little, 4, num, valueOff)); }
  if (type === 8) { return String(readArray(dv, little, 2, num, valueOff)); }
  if (type === 5 || type === 10) {
    const parts = [];
    for (let i = 0; i < Math.min(num, 4); i++) {
      const a = (little ? dv.getUint32(valueOff + i * 8, true) : dv.getUint32(valueOff + i * 8, false));
      const b = (little ? dv.getUint32(valueOff + i * 8 + 4, true) : dv.getUint32(valueOff + i * 8 + 4, false));
      parts.push(b === 0 ? String(a) : (a + "/" + b));
    }
    return parts.join(", ");
  }
  return null;
}

function readArray(dv, little, width, num, off) {
  const n = Math.min(num, 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(width === 2
      ? (little ? dv.getUint16(off + i * 2, true) : dv.getUint16(off + i * 2, false))
      : (little ? dv.getUint32(off + i * 4, true) : dv.getUint32(off + i * 4, false)));
  }
  return out.join(", ");
}

// EXIF UserComment：前 8 位元組是編碼標識
function decodeUserComment(raw) {
  if (raw.length <= 8) { return ""; }
  const code = String.fromCharCode.apply(null, Array.prototype.slice.call(raw.subarray(0, 8)));
  const body = raw.subarray(8);
  if (code.indexOf("UNICODE") === 0) {
    const le = decodeUtf16(body, true).trim();
    const be = decodeUtf16(body, false).trim();
    const pick = (le.indexOf(":") !== -1 && le.indexOf(",") !== -1) ? le : ((be.indexOf(":") !== -1 && be.indexOf(",") !== -1) ? be : (le.length >= be.length ? le : be));
    return pick.replace(/\0/g, "").trim();
  }
  if (code.indexOf("JIS") === 0) { return decodeBytesSmart(body).replace(/\0/g, "").trim(); }
  return decodeBytesSmart(body).replace(/\0/g, "").trim();
}
