// lib/zlib.js —— 使用 Web 標準 DecompressionStream（瀏覽器與 Node 18+ 皆有）
const MAX_OUTPUT = 8 * 1024 * 1024;   // 單次解壓上限，防止 zip bomb 撐爆記憶體

async function collect(stream) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch (e) {
      break;   // 壞資料：當作解壓失敗
    }
    if (r.done) { break; }
    parts.push(r.value);
    total += r.value.length;
    if (total > MAX_OUTPUT) { try { await reader.cancel(); } catch (e) { /* ignore */ } break; }
    }
  const out = new Uint8Array(Math.min(total, MAX_OUTPUT));
  let o = 0;
  for (const p of parts) {
    if (o >= out.length) { break; }
    const take = Math.min(p.length, out.length - o);
    out.set(p.subarray(0, take), o);
    o += take;
  }
  return out;
}

async function inflateWith(bytes, format) {
  if (typeof DecompressionStream === "undefined") { return null; }
  let ds;
  try {
    ds = new DecompressionStream(format);
  } catch (e) {
    return null;
  }
  // 寫入端單獨處理：壞資料會讓 write()/close() 的 Promise 拒絕，
  // 必須自己吞掉，否則會變成 unhandledRejection（實測垃圾 zlib 資料會觸發）。
  const pump = (async function () {
    const w = ds.writable.getWriter();
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (e2) { /* ignore */ }
    }
  })();
  try {
    const out = await collect(ds.readable);
    await pump;
    if (!out || out.length === 0) { return null; }
    return out;
  } catch (e) {
    try { await pump; } catch (e2) { /* ignore */ }
    return null;
  }
}

/**
 * 容忍截斷的串流解壓：把手上有的壓縮位元組餵進去，讀到「一段時間沒有新資料」就停。
 * 截斷的 zlib 流用 DecompressionStream 會在收尾時報錯（而且常常一個位元組都還沒吐出來），
 * 所以這裡刻意不 close，改用「靜默窗口」判斷目前能解出的都拿到了。
 * @param {Uint8Array} bytes 可能不完整的壓縮位元組
 * @param {number} silenceMs 連續多久沒有新資料就視為結束
 */
export async function inflatePartial(bytes, silenceMs) {
  if (typeof DecompressionStream === "undefined") { return null; }
  const silence = silenceMs || 80;
  const swallow = function () {};
  let ds;
  try { ds = new DecompressionStream("deflate"); } catch (e) { return null; }
  // 關鍵：把所有串流錯誤都先「接住」，否則截斷流會變成 unhandled rejection（Node 直接崩、Chrome 記擴展錯誤）
  if (ds.readable && typeof ds.readable.catch === "function") { ds.readable.catch(swallow); }
  if (ds.writable && typeof ds.writable.catch === "function") { ds.writable.catch(swallow); }
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const writePromise = Promise.resolve(writer.write(bytes)).catch(swallow);
  const parts = [];
  let total = 0;
  const waitSilence = function () {
    return new Promise(function (resolve) { setTimeout(function () { resolve({ timeout: true }); }, silence); });
  };
  for (;;) {
    let r;
    try {
      r = await Promise.race([reader.read(), waitSilence()]);
    } catch (e) {
      break;
    }
    if (!r || r.timeout || r.done) { break; }
    parts.push(r.value);
    total += r.value.length;
    if (total > 64 * 1024 * 1024) { break; }
  }
  try { const c = reader.cancel(); if (c && typeof c.catch === "function") { c.catch(swallow); } } catch (e) { /* ignore */ }
  try { const a = writer.abort(); if (a && typeof a.catch === "function") { a.catch(swallow); } } catch (e) { /* ignore */ }
  try { await writePromise; } catch (e) { /* ignore */ }
  if (total === 0) { return null; }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function inflateZlib(bytes) { return inflateWith(bytes, "deflate"); }
export function inflateRaw(bytes) { return inflateWith(bytes, "deflate-raw"); }
export function gunzip(bytes) { return inflateWith(bytes, "gzip"); }
