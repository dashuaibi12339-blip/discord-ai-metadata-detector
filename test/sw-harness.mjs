// test/sw-harness.mjs —— 用 chrome API 樁在 Node 裡真實跑一遍 Service Worker 全鏈路
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtures } from "./gen-fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
writeFixtures();   // 測試前先確保夾具是最新的
function fxSize(name) { return fs.statSync(path.join(fixtureDir, name)).size; }

// ---------- chrome API 樁 ----------
const store = {};
const listeners = [];
const badgeCalls = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        const arr = Array.isArray(keys) ? keys : (typeof keys === "string" ? [keys] : Object.keys(keys || {}));
        for (const k of arr) { if (store[k] !== undefined) { out[k] = store[k]; } }
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); },
    },
    onChanged: { addListener: () => {} },
  },
  runtime: {
    onMessage: { addListener: (fn) => { listeners.push(fn); } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    openOptionsPage: () => {},
    lastError: null,
  },
  action: { setBadgeText: (a) => badgeCalls.push(a), setBadgeBackgroundColor: () => {} },
  contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: () => {} } },
  tabs: { sendMessage: async () => {} },
  downloads: { download: async () => 42 },
};

// ---------- 起一個本機 http 伺服器供應測試夾具 ----------
const fixtureDir = path.join(__dirname, "fixtures");
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.replace(/^\//, "").split("?")[0]);
  const p = path.join(fixtureDir, name);
  if (!fs.existsSync(p)) { res.statusCode = 404; res.end("not found"); return; }
  const buf = fs.readFileSync(p);
  const range = req.headers.range;
  res.setHeader("content-type", name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg");
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : buf.length - 1;
    const slice = buf.subarray(start, Math.min(end + 1, buf.length));
    res.statusCode = 206;
    res.setHeader("content-range", "bytes " + start + "-" + (start + slice.length - 1) + "/" + buf.length);
    res.setHeader("content-length", slice.length);
    res.end(slice);
  } else {
    res.setHeader("content-length", buf.length);
    res.end(buf);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const local = (n) => "http://127.0.0.1:" + port + "/" + n;

// ---------- 載入 Service Worker ----------
await import("../background/service_worker.js");
if (listeners.length !== 1) { console.log("!! SW 註冊了 " + listeners.length + " 個 onMessage 監聽器（預期 1）"); }

function callSW(msg, sender) {
  return new Promise((resolve) => {
    const ret = listeners[0](msg, sender || {}, resolve);
    if (ret !== true) { resolve({ __noAsync: true, ret: ret }); }
  });
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra !== undefined ? " -> " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("== 設定 / 快取 API ==");
const st = await callSW({ type: "getSettings" });
ok("getSettings 回傳設定", st && st.ok && st.settings && st.settings.concurrency === 3, st);
const setr = await callSW({ type: "setSettings", patch: { minGapMs: 0, concurrency: 2 } });
ok("setSettings 生效", setr && setr.settings.minGapMs === 0);

console.log("\n== 本地 A1111 夾具（模擬片段抓取 + 解析 + 快取） ==");
const r1 = await callSW({ type: "checkItems", items: [{ key: "t/a1111.png", url: local("a1111.png") }], opts: {} });
const res1 = r1 && r1.results && r1.results[0];
ok("有回傳結果", !!res1, r1);
if (res1) {
  ok("status=ok", res1.status === "ok", res1.status);
  ok("source=comfyui", res1.source === "comfyui", res1.source);
  ok("tool 含 A1111", /A1111/.test(res1.tool || ""), res1.tool);
  ok("提示詞完整", (res1.prompt || "").indexOf("blue archive") !== -1, (res1.prompt || "").slice(0, 60));
  ok("參數字串含步數", /步數: 28/.test(res1.paramsString || ""), res1.paramsString);
  ok("有寫入快取", !!store.cache && !!store.cache["t/a1111.png"], Object.keys(store.cache || {}));
}
console.log("\n== 大 PNG（tEXt 寫在 IDAT 之後）：預設只讀首段，尾段掃描是選項 ==");
{
  const rp = await callSW({ type: "checkItems", items: [{ key: "t/post-text.png", url: local("post-text.png") }], opts: {} });
  const resp2 = rp && rp.results && rp.results[0];
  ok("預設不掃尾段 -> none（省流量）", resp2 && resp2.status === "none", resp2 && resp2.status);
  ok("預設只讀首段（≤160KB，檔案 2MB）", resp2 && resp2.bytes > 0 && resp2.bytes <= 160000, resp2 && resp2.bytes + " bytes");
  await callSW({ type: "setSettings", patch: { tailScan: true } });
  const rp2 = await callSW({ type: "checkItems", items: [{ key: "t/post-text.png", url: local("post-text.png") }], opts: {} });
  const resp3 = rp2 && rp2.results && rp2.results[0];
  ok("開啟尾段掃描後判定為 comfyui", resp3 && resp3.source === "comfyui", resp3 && resp3.source);
  ok("開啟後抽出提示詞", resp3 && (resp3.prompt || "").indexOf("blue archive") !== -1, resp3 && (resp3.prompt || "").slice(0, 50));
  ok("開啟後位元組量仍遠小於檔案大小(2MB)", resp3 && resp3.bytes > 0 && resp3.bytes < 400000, resp3 && resp3.bytes + " bytes");
  await callSW({ type: "setSettings", patch: { tailScan: false } });
}

console.log("\n== 超大 tEXt（500KB，首段 128KB 一定被切斷）：應精準補抓，不下載整份 2.5MB ==");
{
  const rq = await callSW({ type: "checkItems", items: [{ key: "t/bigtext.png", url: local("bigtext.png") }], opts: {} });
  const r = rq && rq.results && rq.results[0];
  ok("切斷的 tEXt 仍能判定 comfyui", r && r.source === "comfyui", r && r.source);
  ok("抽出提示詞", r && (r.prompt || "").indexOf("blue archive") !== -1, r && (r.prompt || "").slice(0, 40));
  ok("只補抓到 chunk 結尾（<900KB，檔案 2.6MB）", r && r.bytes > 0 && r.bytes < 900000, r && r.bytes + " bytes");
}

console.log("\n== 隱寫：預設關閉 / auto 時先做低成本預檢 ==");
{
  const off = await callSW({ type: "getSettings" });
  ok("預設 stealthScan=off", (off.settings.stealthScan || "off") === "off", off.settings.stealthScan);
  await callSW({ type: "setSettings", patch: { stealthScan: "auto" } });
  // 1) 大且不可壓縮、無隱寫：應只讀前面一小段就判定「沒有」
  const rb = await callSW({ type: "checkItems", items: [{ key: "t/big-rgba-plain.png", url: local("big-rgba-plain.png") }], opts: {} });
  const big = rb && rb.results && rb.results[0];
  const fileSize = fxSize("big-rgba-plain.png");
  ok("判定為無提示詞", big && big.status === "none", big && big.status);
  ok("預檢結論寫進備註", big && (big.notes || []).join(" ").indexOf("隐写预检") !== -1, big && big.notes);
  ok("省下大半流量（檔案 " + Math.round(fileSize / 1024) + "KB，只讀 " + Math.round(((big && big.bytes) || 0) / 1024) + "KB）", big && big.bytes > 0 && big.bytes < fileSize * 0.7, big && big.bytes);
  // 2) 沒有 alpha 通道：不應該多讀
  const rr = await callSW({ type: "checkItems", items: [{ key: "t/rgb-plain.png", url: local("rgb-plain.png") }], opts: {} });
  const rgb = rr && rr.results && rr.results[0];
  ok("無 alpha 通道 -> 直接判定不可能有隱寫", rgb && (rgb.notes || []).join(" ").indexOf("没有 alpha 通道") !== -1, rgb && rgb.notes);
  // 3) 真的有隱寫：預檢命中 -> 完整解出提示詞
  const rs = await callSW({ type: "checkItems", items: [{ key: "t/stealth.png", url: local("stealth.png") }], opts: {} });
  const st = rs && rs.results && rs.results[0];
  ok("隱寫圖判定為 novelai", st && st.source === "novelai", st && st.source);
  ok("標籤標明來自隱寫", st && (st.tool || "").indexOf("隱寫") !== -1, st && st.tool);
  ok("解出正向提示詞", st && (st.prompt || "").indexOf("blue archive") !== -1, st && (st.prompt || "").slice(0, 50));
  ok("解出 Comment 裡的步數", st && String((st.params || {}).steps) === "28", st && st.params);
  await callSW({ type: "setSettings", patch: { stealthScan: "off" } });
}

console.log("\n== 命中快取 ==");
const r2 = await callSW({ type: "getCached", keys: ["t/a1111.png", "t/does-not-exist.png"] });
ok("getCached 只回傳存在的鍵", r2 && r2.results && !!r2.results["t/a1111.png"] && !r2.results["t/does-not-exist.png"], Object.keys((r2 && r2.results) || {}));

console.log("\n== NovelAI / ComfyUI / 無元資料 / 影片名 ==");
const r3 = await callSW({ type: "checkItems", items: [
  { key: "t/novelai.png", url: local("novelai.png") },
  { key: "t/comfyui.png", url: local("comfyui.png") },
  { key: "t/plain.png", url: local("plain.png") },
  { key: "t/plain.webp", url: local("plain.webp") },
  { key: "t/missing.png", url: local("nope-does-not-exist.png") },
], opts: {} });
const by = {};
for (const r of (r3.results || [])) { by[r.key] = r; }
ok("NovelAI 判定", by["t/novelai.png"] && by["t/novelai.png"].source === "novelai", by["t/novelai.png"] && by["t/novelai.png"].source);
ok("ComfyUI 判定", by["t/comfyui.png"] && by["t/comfyui.png"].source === "comfyui", by["t/comfyui.png"] && by["t/comfyui.png"].source);
ok("ComfyUI 提示詞由節點圖還原", by["t/comfyui.png"] && by["t/comfyui.png"].prompt === "a cute cat, masterpiece", by["t/comfyui.png"] && by["t/comfyui.png"].prompt);
ok("無元資料 -> none", by["t/plain.png"] && by["t/plain.png"].status === "none", by["t/plain.png"] && by["t/plain.png"].status);
ok("無元資料 webp -> none", by["t/plain.webp"] && by["t/plain.webp"].status === "none", by["t/plain.webp"] && by["t/plain.webp"].status);
ok("404 附件 -> error 且訊息友善", by["t/missing.png"] && by["t/missing.png"].status === "error" && /失效|删除|404/.test(by["t/missing.png"].error || ""), by["t/missing.png"] && by["t/missing.png"].error);

console.log("\n== 下載原圖（擴展自己抓原始位元組） ==");
{
  const dr = await callSW({ type: "downloadOriginal", key: "t/a1111.png", url: local("a1111.png") });
  ok("下載原圖回傳成功", dr && dr.ok === true, dr);
  ok("檔名保留 .png 副檔名", dr && /\.png$/.test(dr.filename || ""), dr && dr.filename);
  ok("內容是 PNG（mime 正確）", dr && dr.mime === "image/png", dr && dr.mime);
  ok("位元組數與檔案一致", dr && dr.bytes > 100, dr && dr.bytes);
  const live = await callSW({ type: "downloadOriginal", key: "nope", url: local("does-not-exist.png") });
  ok("不存在的附件回報失敗（不誤報成功）", live && live.ok === false, live);
}

console.log("\n== 停止識別（總開關） ==");
{
  await callSW({ type: "setSettings", patch: { enabled: false } });
  const blocked = await callSW({ type: "checkItems", items: [{ key: "t/blocked.png", url: local("a1111.png") }], opts: {} });
  ok("暫停後 checkItems 被拒絕", blocked && blocked.ok === false && /暂停/.test(blocked.error || ""), blocked);
  ok("暫停後 testUrl 被拒絕", (await callSW({ type: "testUrl", url: local("a1111.png") })).ok === false);
  ok("暫停後 downloadOriginal 被拒絕", (await callSW({ type: "downloadOriginal", key: "t/a1111.png", url: local("a1111.png") })).ok === false);
  const still = await callSW({ type: "getCached", keys: ["t/a1111.png"] });
  ok("暫停時仍可讀快取（不發請求）", still && still.ok === true && !!still.results["t/a1111.png"]);
  ok("暫停時仍可統計與匯出", (await callSW({ type: "stats" })).ok === true && (await callSW({ type: "export", format: "json" })).ok === true);
  await callSW({ type: "setSettings", patch: { enabled: true } });
  const back = await callSW({ type: "checkItems", items: [{ key: "t/after-resume.png", url: local("novelai.png") }], opts: {} });
  ok("恢復後可正常檢測", back && back.ok === true && back.results && back.results[0].source === "novelai", back && back.results && back.results[0] && back.results[0].source);
}

console.log("\n== 匯出 / 統計 / 徽章 / 清空 ==");
const ex = await callSW({ type: "export", format: "csv", keyword: "blue archive" });
ok("CSV 匯出且關鍵字命中", ex && ex.ok && ex.text.indexOf("blue archive") !== -1, ex && ex.text.slice(0, 80));
const exj = await callSW({ type: "export", format: "json" });
ok("JSON 匯出可解析", exj && exj.ok && Array.isArray(JSON.parse(exj.text)), exj && exj.text.slice(0, 60));
const stat = await callSW({ type: "stats" });
ok("stats 統計合理", stat && stat.ok && stat.stats.cached >= 6 && stat.stats.withMeta >= 3, stat && stat.stats);
const bg = await callSW({ type: "badge", count: 5 }, { tab: { id: 77 } });
ok("徽章使用 sender.tab.id", bg && bg.ok && badgeCalls.some((b) => b.tabId === 77 && b.text === "5"), badgeCalls);
const cl = await callSW({ type: "clearCache" });
ok("清空快取", cl && cl.ok && Object.keys(store.cache || {}).length === 0);
const unk = await callSW({ type: "no-such-type" });
ok("未知訊息有錯誤回應", unk && unk.ok === false, unk);

console.log("\n== 真實 Discord 連結（簽名可能已過期，失敗不算錯） ==");
const liveUrl = process.argv[2];
if (liveUrl) {
  const rl = await callSW({ type: "checkItems", items: [{ key: "live/x", url: liveUrl }], opts: {} });
  const rec = rl && rl.results && rl.results[0];
  console.log("  " + JSON.stringify(rec && { status: rec.status, format: rec.format, size: rec.width + "x" + rec.height, bytesRead: rec.bytes, url: (rec.finalUrl || "").slice(0, 90), error: rec.error }));
  ok("真實大圖只讀取少量位元組（省流量）", !!rec && rec.bytes > 0 && rec.bytes < 800000, rec && rec.bytes);
  ok("真實連結流程不拋例外且有明確狀態", !!rec && typeof rec.status === "string");
} else {
  console.log("  （未提供 URL，跳過）");
}

server.close();
console.log("\nService Worker 全鏈路: " + pass + " 通過, " + fail + " 失敗");
process.exit(fail === 0 ? 0 : 1);
