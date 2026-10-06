// background/service_worker.js —— 抓取附件位元組、解析、快取、排隊
import { extractMetadata, extractTailFragment, mergeMetadata, hasTextMeta, sniffFormat } from "../lib/metadata.js";
import { analyzeMetadata } from "../lib/analyze.js";
import { extractStealthFromPngBytes } from "../lib/stealth.js";
import { probeStealthPrefix, extractStealthFromPngBytesPure } from "../lib/png-alpha.js";
import { matchKeyword } from "../lib/filter.js";
import { normalizeKey, fileNameOf, candidates } from "../lib/discord-url.js";

const DEFAULTS = {
  enabled: true,           // 總開關：false 時完全不檢測、不發任何網路請求
  fabPos: null,            // 懸浮球位置（null = 預設右下角）
  fabHidden: false,        // 懸浮球是否隱藏
  pendingBadge: false,     // 是否顯示「識別中」徽章
  scanDebounceMs: 250,     // 進入視野後多久開始檢測（0 = 立即）
  domDebounceMs: 500,      // Discord 改動頁面後多久重新掃描 DOM
  autoScan: true,
  scanMode: "visible",
  headBytes: 131072,
  tailBytes: 131072,
  smallFullBytes: 262144,
  tailScan: false,
  pageBudgetMB: 30,
  maxFullBytes: 8388608,
  deepMaxBytes: 16777216,
  concurrency: 3,
  minGapMs: 120,
  requestTimeoutMs: 20000,
  stealthScan: "off",      // off（預設）/ auto / always —— alpha 隱寫檢測必須完整下載並解碼像素，代價高，預設關閉
  stealthMaxBytes: 8388608,
  stealthProbeBytes: 1048576,   // 隱寫預檢最多抓多少位元組（確認有隱寫才下整份）
  showBadge: true,
  dimNoMeta: false,
  onlyWithMeta: false,
  keyword: "",
  sourceFilter: "all",
  badgeStyle: "label",
  badgeMode: "ai",
  autoScanLimit: 60,
  cacheLimit: 2500,
  searchTextLimit: 2000,
};

const cache = new Map();
let settings = Object.assign({}, DEFAULTS);
let cacheDirty = false;
let cacheFlushTimer = null;
let queued = 0;
const waiters = [];
let lastRequestAt = 0;
let rateLimitedUntil = 0;

// ---------- 設定與快取持久化 ----------
async function loadState() {
  const got = await chrome.storage.local.get(["settings", "cache"]);
  if (got.settings) { settings = Object.assign({}, DEFAULTS, got.settings); }
  if (got.cache && typeof got.cache === "object") {
    for (const k of Object.keys(got.cache)) { cache.set(k, got.cache[k]); }
  }
}
const ready = loadState();

function scheduleFlush() {
  cacheDirty = true;
  if (cacheFlushTimer) { return; }
  cacheFlushTimer = setTimeout(flushCache, 2500);
}
async function flushCache() {
  cacheFlushTimer = null;
  if (!cacheDirty) { return; }
  cacheDirty = false;
  try {
    const obj = {};
    for (const [k, v] of cache) { obj[k] = v; }
    await chrome.storage.local.set({ cache: obj });
  } catch (e) {
    // 超過配額時丟棄最舊的一半再重試
    const arr = Array.from(cache.entries()).sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
    for (let i = 0; i < Math.floor(arr.length / 2); i++) { cache.delete(arr[i][0]); }
    try {
      const obj = {};
      for (const [k, v] of cache) { obj[k] = v; }
      await chrome.storage.local.set({ cache: obj });
    } catch (e2) { /* 放棄 */ }
  }
}
setInterval(function () { flushCache(); }, 15000);

function pruneCache() {
  if (cache.size <= settings.cacheLimit) { return; }
  const arr = Array.from(cache.entries()).sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
  const remove = arr.length - settings.cacheLimit;
  for (let i = 0; i < remove; i++) { cache.delete(arr[i][0]); }
  scheduleFlush();
}

// ---------- 限流 ----------
async function acquire() {
  if (queued < settings.concurrency) { queued++; return; }
  await new Promise((resolve) => waiters.push(resolve));
  queued++;
}
function release() {
  queued--;
  const next = waiters.shift();
  if (next) { next(); }
}
async function politeWait() {
  const now = Date.now();
  if (rateLimitedUntil > now) { await sleep(rateLimitedUntil - now); }
  const gap = settings.minGapMs - (Date.now() - lastRequestAt);
  if (gap > 0) { await sleep(gap); }
  lastRequestAt = Date.now();
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- URL 正規化（見 lib/discord-url.js） ----------

// ---------- HTTP ----------
async function readUpTo(res, limit) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf.length > limit ? buf.subarray(0, limit) : buf, overLimit: buf.length > limit };
  }
  const parts = [];
  let total = 0;
  let overLimit = false;
  for (;;) {
    const r = await reader.read();
    if (r.done) { break; }
    parts.push(r.value);
    total += r.value.length;
    if (total >= limit) { overLimit = true; try { await reader.cancel(); } catch (e) {} break; }
  }
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const p of parts) {
    const take = Math.min(p.length, out.length - off);
    out.set(p.subarray(0, take), off);
    off += take;
    if (off >= out.length) { break; }
  }
  return { bytes: out, overLimit: overLimit };
}

async function fetchRange(url, start, end, timeoutMs) {
  await politeWait();
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs || settings.requestTimeoutMs);
  const headers = {};
  if (start !== null && start !== undefined) { headers.Range = "bytes=" + start + "-" + (end === null || end === undefined ? "" : end); }
  try {
    const res = await fetch(url, { method: "GET", headers: headers, credentials: "omit", signal: controller.signal, cache: "default", redirect: "follow" });
    clearTimeout(timer);
    if (res.status === 429) {
      rateLimitedUntil = Date.now() + 4000;
      const buf = await res.arrayBuffer().catch(function () { return new ArrayBuffer(0); });
      return { ok: false, status: 429, error: "被限流(429)" };
    }
    if (!res.ok && res.status !== 206) {
      return { ok: false, status: res.status, error: "HTTP " + res.status };
    }
    const cr = res.headers.get("content-range");
    let total = null;
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) { total = parseInt(m[1], 10); }
    }
    if (total === null) {
      const cl = res.headers.get("content-length");
      if (cl) { total = parseInt(cl, 10); }
    }
    const limit = settings.headBytes + 64;
    const read = await readUpTo(res, start === null ? limit : Math.max(limit, (end - start + 1) + 64));
    return {
      ok: true, status: res.status, bytes: read.bytes, total: total, partial: res.status === 206 || read.overLimit,
      contentType: res.headers.get("content-type") || "", contentRange: cr || "", overLimit: read.overLimit, finalUrl: res.url,
    };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: (e && e.name === "AbortError") ? "逾時" : String(e && e.message ? e.message : e) };
  }
}

async function fetchAttachment(url, wantFull) {
  const cands = candidates(url);
  let lastErr = { ok: false, status: 0, error: "沒有可用 URL" };
  for (const cand of cands) {
    const head = await fetchRange(cand, 0, settings.headBytes - 1);
    if (!head.ok) { lastErr = head; continue; }
    let bytes = head.bytes;
    const total = head.total;
    let fragment = total !== null ? head.bytes.length < total : !!head.partial;
    // 只有明確要求（深度檢測）或檔案很小時才整份下載，其餘靠首段 + 尾段
    const smallFull = total !== null && total <= settings.smallFullBytes;
    if (fragment && (wantFull || smallFull)) {
      const full = await fetchRange(cand, 0, total - 1);
      if (full.ok && full.bytes.length >= bytes.length) {
        bytes = full.bytes;
        fragment = full.bytes.length < total;
      }
    }
    return { ok: true, bytes: bytes, fragment: fragment, total: total, url: cand, contentType: head.contentType, partialFetch: fragment };
  }
  return lastErr;
}

async function fetchTail(url, total) {
  const cands = candidates(url);
  const start = Math.max(0, total - settings.tailBytes);
  for (const cand of cands) {
    const r = await fetchRange(cand, start, total - 1);
    if (r.ok) { return r; }
  }
  return null;
}

// ---------- 檢查單一附件 ----------
// Discord 對已刪除/失效附件可能回 200 + text/plain 的 36 位元組說明文字
function isUnavailableResponse(got) {
  if (!got || !got.bytes) { return false; }
  const ct = String(got.contentType || "").toLowerCase();
  if (ct.indexOf("text/") === 0 || ct.indexOf("application/json") === 0) { return true; }
  if (got.bytes.length < 64) {
    let s = "";
    for (let i = 0; i < Math.min(got.bytes.length, 48); i++) { s += String.fromCharCode(got.bytes[i]); }
    if (s.indexOf("This content is no longer available") !== -1 || s.indexOf("not found") !== -1) { return true; }
  }
  return false;
}

const UNSUPPORTED_FORMATS = ["video", "gif", "avif", "heic", "riff-other"];

function toStatus(res) {
  if (res.error) { return "error"; }
  if (UNSUPPORTED_FORMATS.indexOf(res.format) !== -1) { return "unsupported"; }
  if (res.source !== "none") { return "ok"; }
  if (res.hasAnyMetadata) { return "other"; }
  return "none";
}

function compact(key, url, res, extra) {
  const out = {
    v: 1, key: key, url: url, t: Date.now(),
    status: toStatus(res), source: res.source, tool: res.tool, format: res.format,
    width: res.width, height: res.height, hasAnyMetadata: res.hasAnyMetadata, truncated: res.truncated,
    prompt: (res.prompt || "").slice(0, 4000), negative: (res.negative || "").slice(0, 2000),
    preview: (res.preview || "").slice(0, 800), paramsString: res.paramsString || "",
    params: res.params || {}, fields: (res.fields || []).slice(0, 40), notes: res.notes || [],
    searchText: (res.searchText || "").slice(0, settings.searchTextLimit),
    bytes: res.bytesRead || 0, deep: !!(extra && extra.deep), error: res.error || "",
    reencoded: !!res.reencoded,
  };
  return out;
}

async function checkOne(key, url, opts) {
  opts = opts || {};
  const got = await fetchAttachment(url, !!opts.full || !!opts.deep);
  const unavailable = isUnavailableResponse(got);
  if (!got.ok || unavailable) {
    let errMsg = got.error || ("HTTP " + got.status);
    if (unavailable) { errMsg = "附件已失效或被删除（Discord 回傳不可用）"; }
    if (got.status === 404 || got.status === 403 || got.status === 401) { errMsg = "附件已失效或被删除（HTTP " + got.status + "）"; }
    const errRes = { error: errMsg, notes: [], entries: [], pngText: {}, source: "none", hasAnyMetadata: false };
    const rec = compact(key, url, errRes, opts);
    cache.set(key, rec);
    scheduleFlush();
    return rec;
  }
  let downloaded = got.bytes.length;
  let md = await extractMetadata(got.bytes, { fragment: got.fragment });
  const cand0 = got.url || candidates(url)[0];   // 用實際成功的那個候選（非 Discord 主機也能正確補抓）
  const total = got.total;

  // 分階段抓取：預設只讀首段，只有「檔案裡確實還有中繼資料」時才精準補抓
  // 第 1 段：很小的檔案（預設 ≤256KB）直接抓完整，成本可忽略
  if (got.fragment && !hasTextMeta(md) && total && total <= settings.smallFullBytes) {
    const full = await fetchRange(cand0, 0, total - 1);
    if (full.ok) { got.bytes = full.bytes; got.fragment = full.bytes.length < total; downloaded = full.bytes.length; md = await extractMetadata(got.bytes, { fragment: got.fragment }); }
  }
  // 第 2 段：首段剛好切在中繼資料 chunk 中間 → 只補抓到該 chunk 結尾（不多讀影像資料）
  if (got.fragment && !hasTextMeta(md) && total) {
    const pf = (md.extra && md.extra.pendingFetch) || 0;
    if (pf > got.bytes.length && pf <= settings.maxFullBytes) {
      const more = await fetchRange(cand0, 0, pf - 1);
      if (more.ok) { got.bytes = more.bytes; got.fragment = more.bytes.length < total; downloaded = more.bytes.length; md = await extractMetadata(got.bytes, { fragment: got.fragment }); }
    }
  }
  // 第 3 段：還沒看到任何影像資料 chunk（中繼資料區異常大）→ 再往前探一倍首段
  if (got.fragment && !hasTextMeta(md) && total && md.extra && md.extra.needProbe) {
    const end = Math.min(settings.headBytes * 2 - 1, total - 1, settings.maxFullBytes - 1);
    if (end + 1 > got.bytes.length) {
      const more = await fetchRange(cand0, 0, end);
      if (more.ok) { got.bytes = more.bytes; got.fragment = more.bytes.length < total; downloaded = more.bytes.length; md = await extractMetadata(got.bytes, { fragment: got.fragment }); }
    }
  }
  // 第 4 段：WebP 首段停在影像資料 chunk 中間 → 依 chunk 表跳到下一個 chunk 開頭抓一小段掃 EXIF/XMP
  if (got.fragment && !hasTextMeta(md) && total && md.format === "webp" && md.extra && md.extra.skipTo) {
    const from = md.extra.skipTo;
    if (from < total) {
      const probe = await fetchRange(cand0, from, Math.min(from + 65535, total - 1));
      if (probe.ok) {
        downloaded += probe.bytes.length;
        const extra = await extractTailFragment(probe.bytes, "webp");
        if (hasTextMeta(extra)) { md = mergeMetadata(md, extra); md.truncated = got.fragment; }
      }
    }
  }
  // 第 5 段（可選，預設關閉）：掃檔案尾段，抓「寫在 IDAT 之後」的中繼資料，每張多花約 128KB
  if (got.fragment && !hasTextMeta(md) && settings.tailScan && total && (md.format === "png" || md.format === "webp")) {
    const tail = await fetchTail(url, total);
    if (tail && tail.ok) {
      downloaded += tail.bytes.length;
      const extra = await extractTailFragment(tail.bytes, md.format);
      if (hasTextMeta(extra)) { md = mergeMetadata(md, extra); md.truncated = got.fragment; }
    }
  }
  let deep = false;
  // alpha 通道隱寫：NovelAI 有些圖完全沒有文字區塊，提示詞只存在像素 LSB 裡。
  // 省流量關鍵：隱寫的前 152 bit 只落在第 0 欄，所以「前 152 列」就足以判斷有沒有 ——
  // 先做低成本預檢（只讀前面一小段），只有確認有隱寫才下整份。
  const stealthMode = settings.stealthScan === undefined ? "off" : settings.stealthScan;
  const wantStealth = md.format === "png" && !!(opts.deep || stealthMode === "always" || (stealthMode === "auto" && !hasTextMeta(md)));
  if (wantStealth) {
    let probeBytes = got.bytes;
    let probe = await probeStealthPrefix(probeBytes);
    const probeCap = Math.min(settings.stealthProbeBytes, total || settings.stealthProbeBytes);
    while (probe.status === "need-more" && total && probeBytes.length < probeCap) {
      const next = Math.min(Math.max(probeBytes.length * 2, settings.headBytes * 2), probeCap);
      if (next <= probeBytes.length) { break; }
      const more = await fetchRange(cand0, 0, next - 1);
      if (!more.ok || more.bytes.length <= probeBytes.length) { break; }
      probeBytes = more.bytes;
      downloaded = more.bytes.length;
      probe = await probeStealthPrefix(probeBytes);
    }
    if (probe.status === "no-channel") {
      deep = true;
      md.notes.push("隐写预检：这张 PNG 没有 alpha 通道，不存在 alpha 隐写（未下载完整文件）");
    } else if (probe.status === "negative") {
      deep = true;
      md.notes.push("隐写预检：前 152 列没有隐写标记（只读了约 " + Math.round(probeBytes.length / 1024) + " KB，未下载完整文件）");
    } else if (probe.status === "positive") {
      // 確認有隱寫 → 這次值得完整下載
      if (got.fragment && total && total <= settings.stealthMaxBytes) {
        const full = await fetchRange(cand0, 0, total - 1);
        if (full.ok) { got.bytes = full.bytes; got.fragment = full.bytes.length < total; downloaded = full.bytes.length; md = await extractMetadata(got.bytes, { fragment: got.fragment }); }
      }
      let s = { ok: false, reason: "unknown" };
      try {
        s = await extractStealthFromPngBytesPure(got.bytes);
        if (!s.ok) {
          const byCanvas = await extractStealthFromPngBytes(got.bytes);
          if (byCanvas && byCanvas.ok) { s = byCanvas; }
        }
      } catch (e) {
        s = { ok: false, reason: String(e && e.message ? e.message : e) };
      }
      if (s && s.ok) {
        deep = true;
        md.stealthJson = s.json;
        md.stealthNovelAi = true;
        md.entries.push({ group: "PNG-stealth", name: "Stealth", value: s.kind === "comp" ? "stealth_pngcomp" : "stealth_pnginfo" });
        md.notes.push("提示词取自 alpha 通道隐写（" + (s.order === "column" ? "逐栏" : "逐列") + "）");
      } else {
        md.notes.push("隐写预检命中，但完整解析失败（" + ((s && s.reason) || "未知") + "）");
      }
    } else if (opts.deep && total && total <= settings.stealthMaxBytes) {
      // 預檢無法判定（非 8bit、交錯、太高…），只有使用者明確要求時才完整下載
      const full = await fetchRange(cand0, 0, total - 1);
      if (full.ok) { got.bytes = full.bytes; got.fragment = false; downloaded = full.bytes.length; }
      let s = await extractStealthFromPngBytesPure(got.bytes);
      if (!s.ok) {
        const byCanvas = await extractStealthFromPngBytes(got.bytes);
        if (byCanvas && byCanvas.ok) { s = byCanvas; }
      }
      if (s && s.ok) {
        deep = true;
        md.stealthJson = s.json;
        md.stealthNovelAI = true;
        md.entries.push({ group: "PNG-stealth", name: "Stealth", value: s.kind === "comp" ? "stealth_pngcomp" : "stealth_pnginfo" });
        md.notes.push("提示词取自 alpha 通道隐写（" + (s.order === "column" ? "逐栏" : "逐列") + "）");
      } else {
        md.notes.push("隐写预检：无法判定（" + (probe.reason || "") + "）");
      }
    } else {
      md.notes.push("隐写预检：无法判定（" + (probe.reason || "") + "），未下载完整文件");
    }
  }
  const res = analyzeMetadata(md);
  res.bytesRead = downloaded;
  const rec = compact(key, url, res, { deep: deep });
  rec.finalUrl = got.url;        // 實際成功抓到的原圖 URL（已去掉縮放參數）
  rec.originalUrl = got.url;
  cache.set(key, rec);
  pruneCache();
  scheduleFlush();
  return rec;
}

// ---------- 訊息處理 ----------
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    await ready;
    try {
      if (!msg || !msg.type) { sendResponse({ ok: false, error: "bad message" }); return; }
      // 總開關：停止識別時，所有會「抓取圖片位元組」的操作一律拒絕
      const heavy = { checkItems: 1, deepCheck: 1, testUrl: 1, downloadOriginal: 1 };
      if (heavy[msg.type] && settings.enabled === false) {
        sendResponse({ ok: false, error: "检测已暂停（在扩展弹窗或设置页重新启用即可）", paused: true });
        return;
      }
      if (msg.type === "openOptions") {
        try { chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "getSettings") { sendResponse({ ok: true, settings: settings, cacheSize: cache.size }); return; }
      if (msg.type === "setSettings") {
        settings = Object.assign({}, settings, msg.patch || {});
        await chrome.storage.local.set({ settings: settings });
        sendResponse({ ok: true, settings: settings });
        return;
      }
      if (msg.type === "getCached") {
        const out = {};
        for (const k of (msg.keys || [])) { if (cache.has(k)) { out[k] = cache.get(k); } }
        sendResponse({ ok: true, results: out });
        return;
      }
      if (msg.type === "checkItems") {
        const items = msg.items || [];
        const results = [];
        const jobs = items.map(function (it) {
          return (async function () {
            await acquire();
            try {
              const key = it.key || normalizeKey(it.url);
              const rec = await checkOne(key, it.url, msg.opts);
              results.push(rec);
            } catch (e) {
              results.push({ key: it.key, url: it.url, status: "error", error: String(e && e.message ? e.message : e) });
            } finally {
              release();
            }
          })();
        });
        await Promise.all(jobs);
        await flushCache();
        sendResponse({ ok: true, results: results });
        return;
      }
      if (msg.type === "deepCheck") {
        await acquire();
        try {
          const key = msg.key || normalizeKey(msg.url);
          const rec = await checkOne(key, msg.url, { deep: true, full: true });
          await flushCache();
          sendResponse({ ok: true, result: rec });
        } finally { release(); }
        return;
      }
      if (msg.type === "testUrl") {
        await acquire();
        try {
          const key = normalizeKey(msg.url);
          const rec = await checkOne(key, msg.url, { deep: !!msg.deep, full: true });
          await flushCache();
          sendResponse({ ok: true, result: rec });
        } finally { release(); }
        return;
      }
      if (msg.type === "stats") {
        let withMeta = 0, novelai = 0, comfyui = 0, other = 0, errors = 0;
        for (const v of cache.values()) {
          withMeta += v.status === "ok" ? 1 : 0;
          novelai += v.source === "novelai" ? 1 : 0;
          comfyui += v.source === "comfyui" ? 1 : 0;
          other += v.status === "other" ? 1 : 0;
          errors += v.status === "error" ? 1 : 0;
        }
        sendResponse({ ok: true, stats: { cached: cache.size, withMeta: withMeta, novelai: novelai, comfyui: comfyui, other: other, errors: errors } });
        return;
      }
      if (msg.type === "clearCache") {
        cache.clear();
        await chrome.storage.local.set({ cache: {} });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "export") {
        const arr = Array.from(cache.values()).sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
        let filtered = arr;
        if (msg.keyword) { filtered = filtered.filter(function (v) { return matchKeyword((v.searchText || "") + " " + (v.preview || ""), msg.keyword); }); }
        if (msg.sourceFilter && msg.sourceFilter !== "all") {
          filtered = filtered.filter(function (v) { return msg.sourceFilter === "other" ? v.status === "other" : v.source === msg.sourceFilter; });
        }
        if (msg.format === "csv") {
          const rows = [["時間", "檔名", "來源", "工具", "狀態", "尺寸", "參數", "提示詞", "URL"]];
          for (const v of filtered) {
            rows.push([new Date(v.t || 0).toLocaleString(), fileNameOf(v.url), v.source, v.tool, v.status,
              (v.width || "?") + "x" + (v.height || "?"), v.paramsString || "", (v.prompt || v.preview || "").replace(/\r?\n/g, " "), v.url]);
          }
          const csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c === undefined ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
          sendResponse({ ok: true, text: "\ufeff" + csv, filename: "discord-metadata-" + Date.now() + ".csv", mime: "text/csv" });
        } else {
          sendResponse({ ok: true, text: JSON.stringify(filtered, null, 2), filename: "discord-metadata-" + Date.now() + ".json", mime: "application/json" });
        }
        return;
      }
      if (msg.type === "badge") {
        const tabId = msg.tabId || (sender && sender.tab && sender.tab.id);
        if (tabId) {
          const text = msg.count > 0 ? (msg.count > 99 ? "99+" : String(msg.count)) : "";
          try {
            chrome.action.setBadgeText({ tabId: tabId, text: text });
            chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: "#c0392b" });
          } catch (e) { /* tab 可能已關閉 */ }
        }
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "downloadOriginal") {
        // 由擴展自己抓原始位元組再下載，保證拿到的是原圖（不會被代理/內容協商換成 webp）
        const rec = msg.key ? cache.get(msg.key) : null;
        const target = (rec && (rec.originalUrl || rec.finalUrl)) || msg.url;
        const got = await fetchAttachment(target, true);
        if (!got.ok || !got.bytes || got.bytes.length < 32) {
          sendResponse({ ok: false, error: (got && got.error) || "抓取原始位元組失敗" });
          return;
        }
        const fmt = sniffFormat(got.bytes);
        const mime = fmt === "png" ? "image/png" : fmt === "webp" ? "image/webp" : fmt === "jpeg" ? "image/jpeg" : "application/octet-stream";
        const ext = fmt === "png" ? ".png" : fmt === "webp" ? ".webp" : fmt === "jpeg" ? ".jpg" : "";
        // 檔名淨化：Windows 不允許 \ / : * ? " < > |，含這些字元 chrome.downloads.download 會直接失敗
        let name = fileNameOf(target) || "image";
        name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^[.\s]+/, "").slice(0, 120) || "image";
        if (ext && name.toLowerCase().slice(-ext.length) !== ext) {
          name = name.replace(/\.[A-Za-z0-9]{1,5}$/, "") + ext;
        }
        const attempts = [];
        // 1) blob：就是我們剛驗證過的那串位元組
        try {
          const url = URL.createObjectURL(new Blob([got.bytes], { type: mime }));
          const id = await chrome.downloads.download({ url: url, filename: name, saveAs: false });
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
          sendResponse({ ok: true, id: id, filename: name, bytes: got.bytes.length, mime: mime, method: "blob" });
          return;
        } catch (e) { attempts.push("blob: " + String(e && e.message ? e.message : e)); }
        // 2) data URL
        try {
          let bin = "";
          for (let i = 0; i < got.bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, got.bytes.subarray(i, i + 8192));
          }
          const id = await chrome.downloads.download({ url: "data:" + mime + ";base64," + btoa(bin), filename: name, saveAs: false });
          sendResponse({ ok: true, id: id, filename: name, bytes: got.bytes.length, mime: mime, method: "data" });
          return;
        } catch (e) { attempts.push("data: " + String(e && e.message ? e.message : e)); }
        // 3) 直接讓瀏覽器下載原圖 URL（最後手段；CDN 會忽略縮放參數，通常仍是原圖）
        try {
          const id = await chrome.downloads.download({ url: target, filename: name, saveAs: false });
          sendResponse({ ok: true, id: id, filename: name, bytes: got.bytes.length, mime: mime, method: "direct" });
          return;
        } catch (e) { attempts.push("direct: " + String(e && e.message ? e.message : e)); }
        sendResponse({ ok: false, error: attempts.join(" | ") });
        return;
      }
      if (msg.type === "download") {
        let url = "";
        try {
          const blob = new Blob([msg.text || ""], { type: (msg.mime || "text/plain") + ";charset=utf-8" });
          url = URL.createObjectURL(blob);
        } catch (e) {
          url = "data:" + (msg.mime || "text/plain") + ";charset=utf-8," + encodeURIComponent(msg.text || "");
        }
        try {
          const id = await chrome.downloads.download({ url: url, filename: msg.filename || "export.txt", saveAs: true });
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
          sendResponse({ ok: true, id: id });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        return;
      }
      sendResponse({ ok: false, error: "unknown type: " + msg.type });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

// ---------- 右鍵選單 ----------
function setupMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: "dmd-check-image", title: "检测该图片的 AI 绘图元数据", contexts: ["image"] });
    chrome.contextMenus.create({ id: "dmd-scan-channel", title: "扫描已加载的图片（视口附近）", contexts: ["page"] });
    chrome.contextMenus.create({ id: "dmd-open-options", title: "Discord 元数据检测器设置", contexts: ["page", "action"] });
  });
}
chrome.runtime.onInstalled.addListener(function () {
  setupMenus();
  chrome.storage.local.get(["settings"]).then(function (got) {
    if (!got.settings) { chrome.storage.local.set({ settings: DEFAULTS }); }
  });
});
chrome.runtime.onStartup.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  (async function () {
    await ready;
    if (info.menuItemId === "dmd-check-image" && info.srcUrl && tab && tab.id) {
      if (settings.enabled === false) {
        try { await chrome.tabs.sendMessage(tab.id, { type: "toast", text: "检测已暂停：请在扩展弹窗或设置页重新启用" }); } catch (e) {}
        return;
      }
      await acquire();
      let rec;
      try {
        rec = await checkOne(normalizeKey(info.srcUrl), info.srcUrl, { deep: true, full: true });
      } finally { release(); }
      try { await chrome.tabs.sendMessage(tab.id, { type: "contextResult", url: info.srcUrl, result: rec }); } catch (e) {}
    } else if (info.menuItemId === "dmd-scan-channel" && tab && tab.id) {
      try { await chrome.tabs.sendMessage(tab.id, { type: "requestScanAll" }); } catch (e) {}
    } else if (info.menuItemId === "dmd-open-options") {
      chrome.runtime.openOptionsPage();
    }
  })();
});


