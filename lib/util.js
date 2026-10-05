// lib/util.js —— 通用字节/文本工具（浏览器与 Node 通用，无 chrome API）
export function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function u16be(b, o) { return ((b[o] << 8) | b[o + 1]) >>> 0; }
export function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function u16le(b, o) { return (b[o] | (b[o + 1] << 8)) >>> 0; }

export function u24le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) >>> 0; }

export function ascii(b, o, n) {
  let s = "";
  for (let i = 0; i < n && o + i < b.length; i++) { s += String.fromCharCode(b[o + i]); }
  return s;
}

export function latin1(b, start, end) {
  const s = b.subarray ? b.subarray(start, end) : b.slice(start, end);
  let out = "";
  const CH = 0x8000;
  for (let i = 0; i < s.length; i += CH) {
    out += String.fromCharCode.apply(null, s.slice(i, Math.min(i + CH, s.length)));
  }
  return out;
}

export function tryUtf8(b, start, end) {
  const s = b.subarray ? b.subarray(start, end) : b.slice(start, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(s);
  } catch (e) {
    return null;
  }
}

// tEXt 依規格是 Latin-1，但許多 AI 工具（含中文提示詞）直接寫 UTF-8；優先嘗試 UTF-8
export function decodeTextSmart(b, start, end) {
  const u = tryUtf8(b, start, end);
  if (u !== null) { return u; }
  return latin1(b, start, end);
}

export function decodeBytesSmart(bytes) {
  if (bytes.length === 0) { return ""; }
  const u = tryUtf8(bytes, 0, bytes.length);
  if (u !== null) { return u; }
  return latin1(bytes, 0, bytes.length);
}

export function decodeUtf16(bytes, littleEndian) {
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = littleEndian ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]);
    if (code !== 0) { out += String.fromCharCode(code); }
  }
  return out;
}

export function stripNul(s) {
  return String(s).replace(/\0+$/g, "").replace(/\0/g, "");
}

export function trimText(s, max) {
  if (typeof s !== "string") { s = String(s === undefined || s === null ? "" : s); }
  s = s.replace(/\u0000/g, "").trim();
  if (max && s.length > max) { return s.slice(0, max) + "…"; }
  return s;
}

// 穩定的字串雜湊（用於快取鍵）
export function hashString(s) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i) & 0xff;
    h1 = (h1 * 0x01000193) >>> 0;
  }
  let h2 = 0x1000193;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 = ((h2 ^ s.charCodeAt(i)) * 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function toBytes(x) {
  if (x instanceof Uint8Array) { return x; }
  if (x instanceof ArrayBuffer) { return new Uint8Array(x); }
  return new Uint8Array(x || 0);
}

export function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
