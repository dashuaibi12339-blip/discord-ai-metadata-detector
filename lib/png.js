// lib/png.js —— PNG（含 APNG）chunk 解析，取出 tEXt / zTXt / iTXt / eXIf
import { u32be, ascii, decodeTextSmart, decodeBytesSmart } from "./util.js";
import { inflateZlib } from "./zlib.js";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const META_CHUNKS = ["tEXt", "zTXt", "iTXt", "eXIf"];

export function isPng(b) {
  if (b.length < 8) { return false; }
  for (let i = 0; i < 8; i++) { if (b[i] !== SIG[i]) { return false; } }
  return true;
}

function isChunkType(b, o) {
  for (let i = 0; i < 4; i++) {
    const c = b[o + i];
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!ok) { return false; }
  }
  return true;
}

// 解析整段（或前段）PNG。truncated=true 代表位元組被截斷，只解析到截斷處。
export async function parsePng(b) {
  const out = {
    format: "png", width: 0, height: 0, bitDepth: 0, colorType: 0,
    texts: [], exifBytes: null, xmp: null, chunkTypes: [], truncated: false, sawIend: false,
    sawDataChunk: false, pendingFetch: 0, needProbe: false,
  };
  if (!isPng(b)) { return null; }
  let o = 8;
  while (o + 8 <= b.length) {
    const len = u32be(b, o);
    if (len > 0x7fffffff) { out.truncated = true; break; }
    const type = ascii(b, o + 4, 4);
    if (!isChunkType(b, o + 4)) { out.truncated = true; break; }
    const dataStart = o + 8;
    const dataEnd = dataStart + len;
    out.chunkTypes.push(type);
    if (type === "IDAT" || type === "fdAT") { out.sawDataChunk = true; }

    if (type === "IHDR") {
      if (dataEnd + 4 <= b.length) {
        out.width = u32be(b, dataStart);
        out.height = u32be(b, dataStart + 4);
        out.bitDepth = b[dataStart + 8];
        out.colorType = b[dataStart + 9];
      }
    } else if (dataEnd > b.length) {
      // 資料不完整：仍嘗試解析已到手的部分
      if (type === "tEXt") { pushText(out, b, dataStart, b.length, "tEXt"); }
      // 被切斷的是「中繼資料 chunk」時，告知呼叫方精確終點，讓它只需補抓這一小段
      if (META_CHUNKS.indexOf(type) !== -1) {
        out.pendingFetch = Math.max(out.pendingFetch, dataEnd + 4);
      }
      out.truncated = true;
      break;
    } else if (type === "tEXt") {
      pushText(out, b, dataStart, dataEnd, "tEXt");
    } else if (type === "zTXt") {
      let z = dataStart;
      while (z < dataEnd && b[z] !== 0) { z++; }
      const key = decodeBytesSmart(b.subarray(dataStart, z));
      const method = b[z + 1];
      if (method === 0 && z + 2 < dataEnd) {
        const raw = await inflateZlib(b.subarray(z + 2, dataEnd));
        if (raw) { pushTextValue(out, key, decodeBytesSmart(raw), "zTXt"); }
      }
    } else if (type === "iTXt") {
      await parseITxt(out, b, dataStart, dataEnd);
    } else if (type === "eXIf") {
      out.exifBytes = b.slice(dataStart, dataEnd);
    } else if (type === "iCCP") {
      // 色彩描述檔，忽略內容
    } else if (type === "tIME" || type === "pHYs" || type === "sRGB" || type === "gAMA") {
      // 一般 chunk
    }
    if (type === "IEND") { out.sawIend = true; break; }
    o = dataEnd + 4;
  }
  // 沒看到 IEND、也沒看到影像資料 chunk → 後面可能還有中繼資料，值得再往前探一小段
  if (!out.sawIend && !out.sawDataChunk) { out.needProbe = true; }
  const byKey = {};
  for (const t of out.texts) { byKey[t.key] = t.text; }
  out.textMap = byKey;
  return out;
}

function pushText(out, b, start, end, format) {
  let z = start;
  while (z < end && b[z] !== 0) { z++; }
  if (z >= end) { return; }
  const key = decodeBytesSmart(b.subarray(start, z));
  const text = decodeTextSmart(b, z + 1, end);
  pushTextValue(out, key, text, format);
}

const MAX_TEXT_LEN = 262144;   // 單一文字區塊上限（AI 提示詞不可能這麼長，防止異常檔案撐爆記憶體）

function pushTextValue(out, key, text, format) {
  if (!key) { return; }
  let t = String(text === undefined || text === null ? "" : text);
  if (t.length > MAX_TEXT_LEN) { t = t.slice(0, MAX_TEXT_LEN); }
  out.texts.push({ key: key, text: t, format: format });
}

async function parseITxt(out, b, start, end) {
  let z = start;
  while (z < end && b[z] !== 0) { z++; }
  const key = decodeBytesSmart(b.subarray(start, z));
  if (z + 3 > end) { return; }
  const compFlag = b[z + 1];
  const compMethod = b[z + 2];
  let p = z + 3;
  const langStart = p;
  while (p < end && b[p] !== 0) { p++; }
  const lang = decodeBytesSmart(b.subarray(langStart, p));
  p = p + 1;
  const trStart = p;
  while (p < end && b[p] !== 0) { p++; }
  const translated = decodeBytesSmart(b.subarray(trStart, p));
  p = p + 1;
  if (compFlag === 1) {
    if (compMethod !== 0) { return; }
    const raw = await inflateZlib(b.subarray(p, end));
    if (raw === null || raw === undefined) { return; }
    pushTextValue(out, key, decodeBytesSmart(raw), "iTXt");
  } else {
    pushTextValue(out, key, decodeTextSmart(b, p, end), "iTXt");
  }
  if (lang || translated) {
    const last = out.texts[out.texts.length - 1];
    if (last) { last.lang = lang; last.translated = translated; }
  }
}

// ---------- 尾段掃描：有些工具會把 tEXt 寫在 IDAT 之後 ----------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) { return CRC_TABLE; }
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}
export function crc32(b, start, end) {
  const t = crcTable();
  let c = -1;
  for (let i = start; i < end; i++) { c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ -1) >>> 0;
}

const FRAG_TYPES = ["tEXt", "zTXt", "iTXt", "eXIf"];

// 只掃描「檔案尾段」：以 CRC 驗證找到真正的 chunk 起點，避免誤判
export async function scanPngChunksInFragment(b) {
  const out = { texts: [], exifBytes: null, found: false };
  for (let i = 0; i + 12 <= b.length; i++) {
    const type = ascii(b, i + 4, 4);
    if (FRAG_TYPES.indexOf(type) === -1) { continue; }
    const len = u32be(b, i);
    if (len <= 0 || len > 8388608) { continue; }
    const dataStart = i + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > b.length) { continue; }
    if (crc32(b, i + 4, dataEnd) !== u32be(b, dataEnd)) { continue; }
    out.found = true;
    if (type === "eXIf") {
      out.exifBytes = b.slice(dataStart, dataEnd);
    } else if (type === "tEXt") {
      let z = dataStart;
      while (z < dataEnd && b[z] !== 0) { z++; }
      if (z < dataEnd) { out.texts.push({ key: decodeBytesSmart(b.subarray(dataStart, z)), text: decodeTextSmart(b, z + 1, dataEnd), format: "tEXt" }); }
    } else if (type === "zTXt") {
      let z = dataStart;
      while (z < dataEnd && b[z] !== 0) { z++; }
      const key = decodeBytesSmart(b.subarray(dataStart, z));
      if (b[z + 1] === 0) {
        const raw = await inflateZlib(b.subarray(z + 2, dataEnd));
        if (raw) { out.texts.push({ key: key, text: decodeBytesSmart(raw), format: "zTXt" }); }
      }
    } else if (type === "iTXt") {
      const tmp = { texts: [] };
      await parseITxt(tmp, b, dataStart, dataEnd);
      for (const t of tmp.texts) { out.texts.push(t); }
    }
    if (out.texts.length > 60) { break; }
  }
  return out;
}
