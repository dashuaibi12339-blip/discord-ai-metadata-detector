// lib/metadata.js —— 統一入口：原始位元組 -> 正規化中繼資料模型
import { ascii, decodeBytesSmart, trimText } from "./util.js";
import { isPng, parsePng, scanPngChunksInFragment } from "./png.js";
import { isWebp, parseWebp, scanWebpChunksInFragment } from "./webp.js";
import { isJpeg, parseJpeg } from "./jpeg.js";
import { parseExif } from "./exif.js";
import { parseXmp } from "./xmp.js";

const VIDEO_EXT = [".mp4", ".webm", ".mov", ".mkv", ".avi"];

export function sniffFormat(b) {
  if (!b || b.length < 4) { return "unknown"; }
  if (isPng(b)) { return "png"; }
  if (isJpeg(b)) { return "jpeg"; }
  if (isWebp(b)) { return "webp"; }
  if (ascii(b, 0, 3) === "GIF") { return "gif"; }
  if (ascii(b, 0, 4) === "RIFF") { return "riff-other"; }
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand.indexOf("avif") !== -1 || brand.indexOf("avis") !== -1) { return "avif"; }
    if (brand.indexOf("heic") !== -1 || brand.indexOf("heix") !== -1 || brand.indexOf("mif1") !== -1) { return "heic"; }
    return "video";
  }
  const head = ascii(b, 0, 4);
  if (head.charCodeAt(0) === 0x1a && head.charCodeAt(1) === 0x45 && head.charCodeAt(2) === 0xdf) { return "video"; }
  return "unknown";
}

export function isVideoName(name) {
  const n = String(name || "").toLowerCase();
  for (const e of VIDEO_EXT) { if (n.endsWith(e)) { return true; } }
  return false;
}

/**
 * 解析圖片中繼資料。
 * @param {Uint8Array} bytes 檔案位元組（可能只是前段）
 * @param {object} opts { fragment: boolean 是否為片段, ext: 檔名 }
 */
export async function extractMetadata(bytes, opts) {
  opts = opts || {};
  const res = {
    format: "unknown", width: 0, height: 0, truncated: false, fragment: !!opts.fragment,
    entries: [], pngText: {}, pngTextList: [], exif: [], exifMap: {}, xmp: null, comment: null,
    notes: [], bytesRead: bytes ? bytes.length : 0, extra: {},
  };
  if (!bytes || bytes.length < 16) { res.notes.push("資料太少"); return res; }
  const fmt = sniffFormat(bytes);
  res.format = fmt;

  if (fmt === "png") {
    const png = await parsePng(bytes);
    if (!png) { res.notes.push("PNG 解析失敗"); return res; }
    res.width = png.width; res.height = png.height;
    res.truncated = png.truncated || res.fragment;
    for (const t of png.texts) {
      res.pngTextList.push(t);
      if (res.pngText[t.key] === undefined) { res.pngText[t.key] = t.text; }
      else if ((res.pngText[t.key] || "").length < t.text.length) { res.pngText[t.key] = t.text; }
      res.entries.push({ group: "PNG-" + t.format, name: "Textual Data", value: t.key + ": " + t.text, key: t.key, text: t.text });
    }
    res.extra.pendingFetch = png.pendingFetch || 0;
    res.extra.needProbe = !!png.needProbe;
    res.extra.sawDataChunk = !!png.sawDataChunk;
    if (png.exifBytes) { addExif(res, png.exifBytes); }
  } else if (fmt === "webp") {
    const w = parseWebp(bytes);
    if (!w) { res.notes.push("WebP 解析失敗"); return res; }
    res.width = w.width; res.height = w.height;
    res.truncated = w.truncated || res.fragment;
    res.extra.animated = w.animated;
    res.extra.chunks = w.chunks.map((c) => c.type + "(" + c.size + ")").join(" ");
    res.extra.pendingFetch = w.pendingFetch || 0;
    res.extra.skipTo = w.skipTo || 0;
    if (w.exifBytes) { addExif(res, w.exifBytes); }
    if (w.xmp) { addXmp(res, w.xmp); }
    if (!w.exifBytes && !w.xmp && res.fragment) {
      const frag = scanWebpChunksInFragment(bytes);
      if (frag.exifBytes) { addExif(res, frag.exifBytes); res.notes.push("EXIF 取自檔案尾段"); }
      if (frag.xmp) { addXmp(res, frag.xmp); res.notes.push("XMP 取自檔案尾段"); }
    }
  } else if (fmt === "jpeg") {
    const j = parseJpeg(bytes);
    if (!j) { res.notes.push("JPEG 解析失敗"); return res; }
    res.width = j.width; res.height = j.height;
    res.truncated = j.truncated || res.fragment;
    if (j.exifBytes) { addExif(res, j.exifBytes); }
    if (j.xmp) { addXmp(res, j.xmp); }
    if (j.comment) {
      res.comment = j.comment;
      res.entries.push({ group: "JPEG-COM", name: "Comment", value: j.comment });
    }
    res.extra.segments = j.segments.join(" ");
    res.extra.pendingFetch = j.pendingFetch || 0;
    res.extra.needProbe = !j.reachedSos && !j.sawMetadata;
  } else if (fmt === "gif") {
    res.notes.push("GIF 不支援中繼資料讀取");
  } else if (fmt === "avif" || fmt === "heic") {
    res.notes.push(fmt.toUpperCase() + " 容器暫不支援");
  } else if (fmt === "video") {
    res.notes.push("這是影片檔");
  } else {
    res.notes.push("未知檔案格式");
  }

  // 統一文字值（供關鍵字搜尋）：把 PNG 文字與 EXIF 文字都納入
  for (const e of res.entries) {
    if (e.name === "Textual Data" && e.key && e.key !== res.extra.primaryTextKey) { /* 已納入 */ }
  }
  return res;
}

export function hasTextMeta(md) {
  if (!md) { return false; }
  return Object.keys(md.pngText || {}).length > 0 || (md.exif || []).length > 0 || !!md.xmp || !!md.comment;
}

// 只解析「檔案尾段」的中繼資料（PNG 用 CRC 驗證、WebP 掃 fourcc）
export async function extractTailFragment(bytes, expectedFormat) {
  const res = { format: "unknown", pngText: {}, pngTextList: [], entries: [], exif: [], exifMap: {}, xmp: null, notes: ["中繼資料取自檔案尾段"] };
  // 尾段開頭不是檔案簽名，不能靠 sniff，必須由呼叫方告知格式
  const fmt = expectedFormat || sniffFormat(bytes);
  res.format = fmt;
  if (fmt === "png") {
    const frag = await scanPngChunksInFragment(bytes);
    for (const t of frag.texts) {
      if (res.pngText[t.key] === undefined) { res.pngText[t.key] = t.text; }
      res.entries.push({ group: "PNG-" + t.format, name: "Textual Data", value: t.key + ": " + t.text, key: t.key, text: t.text });
    }
    if (frag.exifBytes) { addExif(res, frag.exifBytes); }
  } else if (fmt === "webp") {
    const frag = scanWebpChunksInFragment(bytes);
    if (frag.exifBytes) { addExif(res, frag.exifBytes); }
    if (frag.xmp) { addXmp(res, frag.xmp); }
  }
  res.hasTextMeta = hasTextMeta(res);
  return res;
}

export function mergeMetadata(md, extra) {
  if (!extra) { return md; }
  for (const k of Object.keys(extra.pngText || {})) {
    if (md.pngText[k] === undefined) { md.pngText[k] = extra.pngText[k]; }
  }
  for (const e of extra.entries || []) { md.entries.push(e); }
  for (const e of extra.exif || []) {
    md.exif.push(e);
    if (!md.exifMap[e.name] || md.exifMap[e.name].length < e.value.length) { md.exifMap[e.name] = e.value; }
  }
  if (extra.xmp && !md.xmp) { md.xmp = extra.xmp; }
  for (const n of extra.notes || []) { if (md.notes.indexOf(n) === -1) { md.notes.push(n); } }
  return md;
}

function addExif(res, exifBytes) {
  const parsed = parseExif(exifBytes);
  if (!parsed) { res.notes.push("EXIF 解析失敗"); return; }
  for (const e of parsed.entries) {
    res.exif.push(e);
    res.entries.push({ group: e.group, name: e.name, value: e.value });
    if (!res.exifMap[e.name] || res.exifMap[e.name].length < e.value.length) { res.exifMap[e.name] = e.value; }
  }
}

function addXmp(res, raw) {
  res.xmp = raw;
  const p = parseXmp(raw);
  res.extra.xmpCreatorTool = p.creatorTool;
  res.extra.xmpDescription = p.description;
  res.entries.push({ group: "XMP", name: "XMP", value: raw });
  if (p.creatorTool) { res.entries.push({ group: "XMP", name: "Creator Tool", value: p.creatorTool }); }
  if (p.description) { res.entries.push({ group: "XMP", name: "Image Description", value: p.description }); }
}
