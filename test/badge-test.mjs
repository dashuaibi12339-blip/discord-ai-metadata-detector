// test/badge-test.mjs —— 徽章疊加回歸測試
// Discord 對同一張附件會渲染多個 DOM 節點（劇透遮罩、燈箱預覽、回覆縮圖…），
// 這裡用最小 DOM 樁模擬「同一附件兩個節點」，斷言全站只出現一個徽章，且掛在最大的可見節點上。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + "  -> " + JSON.stringify(extra)); }
}

// ---------- 最小 DOM 樁 ----------
const ROOT = { tagName: "BODY" };
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], attrs: {}, _text: "", title: "", style: {},
    _rect: { width: 100, height: 100 },
    classList: {
      _s: new Set(),
      add() { for (const c of arguments) { el.classList._s.add(c); } },
      remove() { for (const c of arguments) { el.classList._s.delete(c); } },
      contains(c) { return el.classList._s.has(c); },
      toggle(c, on) { if (on === undefined) { on = !el.classList._s.has(c); } if (on) { el.classList._s.add(c); } else { el.classList._s.delete(c); } return on; },
    },
    get className() { return [...el.classList._s].join(" "); },
    set className(v) { el.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return el._text; },
    set textContent(v) { el._text = String(v); el.children = []; },
    get innerHTML() { return ""; }, set innerHTML(v) {},
    appendChild(c) { el.children.push(c); c.parentElement = el; return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); if (c && c.parentElement === el) { c.parentElement = null; } return c; },
    remove() { if (el.parentElement) { el.parentElement.removeChild(el); } },
    setAttribute(k, v) { el.attrs[k] = String(v); if (k === "id") { el.id = String(v); } },
    getAttribute(k) { return el.attrs[k] === undefined ? null : el.attrs[k]; },
    removeAttribute(k) { delete el.attrs[k]; },
    addEventListener(t, fn) { (el._h = el._h || {})[t] = (el._h[t] || []).concat([fn]); },
    removeEventListener() {},
    querySelector(sel) { return findAll(el, (e) => matchSimple(e, sel))[0] || null; },
    querySelectorAll(sel) { return findAll(el, (e) => matchSimple(e, sel)); },
    closest(sel) { let n = el; while (n) { if (matchSimple(n, sel)) { return n; } n = n.parentElement; } return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: el._rect.width, height: el._rect.height, right: el._rect.width, bottom: el._rect.height }; },
    dispatch(t, ev) { for (const h of ((el._h || {})[t] || [])) { h(ev || {}); } },
    select() {}, click() {}, focus() {},
  };
  Object.defineProperty(el, "isConnected", { get() { let n = el; while (n) { if (n === ROOT) { return true; } n = n.parentElement; } return false; } });
  return el;
}
function walk(el, acc) { acc.push(el); for (const c of el.children || []) { walk(c, acc); } return acc; }
function findAll(el, pred) { return walk(el, []).filter(pred); }
function matchSimple(e, sel) {
  sel = String(sel);
  if (sel.charAt(0) === ".") { return String(e.className).split(/\s+/).indexOf(sel.slice(1)) !== -1; }
  const m = /^([a-z]+)(?:\[([a-z]+)\*="([^"]+)"\])?$/.exec(sel);
  if (!m) { return false; }
  if (e.tagName !== m[1].toUpperCase()) { return false; }
  if (!m[3]) { return true; }
  return String(e.attrs[m[2]] || "").indexOf(m[3]) !== -1;
}
const body = makeEl("body");
Object.defineProperty(body, "tagName", { value: "BODY" });
body.parentElement = ROOT;
body.isRootHost = true;
const htmlEl = makeEl("html");
htmlEl.parentElement = ROOT;

const hostA = makeEl("div"), hostB = makeEl("div"), hostC = makeEl("div");
body.appendChild(hostA); body.appendChild(hostB); body.appendChild(hostC);
const dup1 = makeEl("img"), dup2 = makeEl("img"), other = makeEl("img");
dup1._rect = { width: 200, height: 200 };
dup2._rect = { width: 500, height: 500 };
other._rect = { width: 400, height: 400 };
// 同一張附件、兩個節點（查詢參數不同，正規化後 key 相同）
dup1.attrs.src = "https://media.discordapp.net/attachments/1/2/same.png?ex=1&is=2&hm=3&width=200";
dup2.attrs.src = "https://media.discordapp.net/attachments/1/2/same.png?ex=1&is=2&hm=3&width=500";
other.attrs.src = "https://media.discordapp.net/attachments/1/2/other.png?ex=1&width=400";
hostA.appendChild(dup1); hostB.appendChild(dup2); hostC.appendChild(other);

globalThis.window = { __dmdContentLoaded: false, innerHeight: 900, open() {}, addEventListener() {}, removeEventListener() {} };
globalThis.location = { href: "https://discord.com/channels/1/2" };
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });
globalThis.getComputedStyle = () => ({ position: "static" });
globalThis.MutationObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
globalThis.IntersectionObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
globalThis.URL.createObjectURL = () => "blob:fake";
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class { constructor(p) { this.p = p; } };
globalThis.document = {
  readyState: "complete", body: body, documentElement: htmlEl,
  createElement: (t) => makeEl(t),
  getElementById: (id) => walk(body, []).filter((e) => e.id === id)[0] || null,
  querySelector: (s) => walk(body, []).filter((e) => matchSimple(e, s))[0] || null,
  querySelectorAll: (s) => String(s).split(",").reduce((acc, one) => acc.concat(walk(body, []).filter((e) => matchSimple(e, one.trim()))), []),
  addEventListener() {}, execCommand: () => true,
};

const REC = {
  "attachments/1/2/same.png": { v: 1, key: "attachments/1/2/same.png", url: "https://cdn.discordapp.com/attachments/1/2/same.png", status: "ok", source: "comfyui", tool: "A1111", format: "png", hasAnyMetadata: true, prompt: "1girl", negative: "", preview: "1girl", paramsString: "", params: {}, fields: [], notes: [], searchText: "1girl", bytes: 10, deep: false, reencoded: false },
  "attachments/1/2/other.png": { v: 1, key: "attachments/1/2/other.png", url: "https://cdn.discordapp.com/attachments/1/2/other.png", status: "none", source: "none", tool: "", fields: [], notes: [], searchText: "", bytes: 10 },
};
const runtimeListeners = [];
const settingsPatches = [];
const storageListeners = [];
globalThis.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: "test" }),
    sendMessage: (msg, cb) => {
      let resp = { ok: false, error: "unknown: " + msg.type };
      if (msg.type === "getSettings") { resp = { ok: true, settings: { enabled: true, autoScan: true, showBadge: true, badgeMode: "ai", dimNoMeta: false, keyword: "", sourceFilter: "all", autoScanLimit: 60, stealthScan: "off" } }; }
      else if (msg.type === "getCached") { resp = { ok: true, results: REC }; }
      else if (msg.type === "checkItems") { resp = { ok: true, results: msg.items.map((it) => REC[it.key] || { v: 1, key: it.key, url: it.url, status: "none", source: "none", tool: "", fields: [], notes: [], searchText: "" }) }; }
      else if (msg.type === "badge") { resp = { ok: true }; }
      else if (msg.type === "setSettings") { settingsPatches.push(msg.patch || {}); resp = { ok: true }; }
      setTimeout(() => cb(resp), 0);
    },
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    openOptionsPage() {},
  },
  storage: { onChanged: { addListener: (fn) => storageListeners.push(fn) } },
};

const errors = [];
process.on("unhandledRejection", (e) => errors.push("unhandledRejection: " + ((e && e.message) || e)));
process.on("uncaughtException", (e) => errors.push("uncaughtException: " + ((e && e.message) || e)));
const R = (t, payload) => { let resp = null; try { runtimeListeners[0](Object.assign({ type: t }, payload || {}), {}, (r) => { resp = r; }); } catch (e) { return { __threw: String(e && e.message) }; } return resp; };

console.log("== 徽章唯一性（同一附件兩個節點） ==");
try { await import("file:///" + root.replace(/\\/g, "/") + "/content/content.js"); }
catch (e) { console.log("  !! content.js 載入失敗: " + e.message); fail++; }
await delay(400);

const KEY = "attachments/1/2/same.png";
const badgesFor = (k) => walk(body, []).filter((e) => String(e.className).indexOf("dmd-badge") !== -1 && e.getAttribute("data-dmd-badge") === k);
const allBadges = () => walk(body, []).filter((e) => String(e.className).indexOf("dmd-badge") !== -1);

ok("同一附件的徽章只有 1 個（载入后）", badgesFor(KEY).length === 1, badgesFor(KEY).length);
ok("徽章掛在較大的節點上（500x500 的 hostB）", badgesFor(KEY)[0] && badgesFor(KEY)[0].parentElement === hostB, badgesFor(KEY)[0] && badgesFor(KEY)[0].parentElement && badgesFor(KEY)[0].parentElement === hostA ? "hostA" : "其他");
ok("徽章總數 = 2（另一個附件各 1 個）", allBadges().length === 2, allBadges().length);
ok("兩個節點都標上了狀態屬性", dup1.getAttribute("data-dmd-status") === "ok" && dup2.getAttribute("data-dmd-status") === "ok", [dup1.getAttribute("data-dmd-status"), dup2.getAttribute("data-dmd-status")]);

// 模擬 React 把大的那個節點換掉（移除）→ 徽章應轉移到還活著的節點，且仍然只有 1 個
hostB.removeChild(dup2);
R("scanNow");
await delay(400);
ok("大節點消失後，徽章轉移到存活的節點仍然只有 1 個", badgesFor(KEY).length === 1, badgesFor(KEY).length);
ok("轉移後的徽章掛在 hostA 上", badgesFor(KEY)[0] && badgesFor(KEY)[0].parentElement === hostA, badgesFor(KEY)[0] && badgesFor(KEY)[0].parentElement === hostA);
ok("另一個附件的徽章不受影響", badgesFor("attachments/1/2/other.png").length === 1, badgesFor("attachments/1/2/other.png").length);

// 反覆掃描不應該長出多餘徽章
for (let i = 0; i < 5; i++) { R("scanNow"); }
await delay(300);
ok("反覆掃描後仍然只有 1 個", badgesFor(KEY).length === 1, badgesFor(KEY).length);
ok("沒有未處理例外", errors.length === 0, errors.slice(0, 3));


// ---------- 面板捲動保持（松手回頂回歸） ----------
console.log("== 面板捲動保持 ==");
const byId = (id) => walk(body, []).filter((e) => e.id === id)[0] || null;
const listEl = byId("dmd-list");
// 讓第一列展開（點列主體 = 展開/收起）
const mains = walk(body, []).filter((e) => String(e.className).indexOf("dmd-item-main") !== -1);
ok("面板有列可以展開", !!listEl && mains.length >= 1, mains.length);
if (mains[0]) { mains[0].dispatch("click"); }
await delay(400);
const pres = walk(body, []).filter((e) => e.tagName === "PRE");
ok("展開後出現提示詞框", pres.length >= 1, pres.length);
if (pres[0]) { pres[0].scrollTop = 120; pres[0].dispatch("scroll"); }
if (listEl) { listEl.scrollTop = 30; }
// 插一張新圖，讓列表內容真的變了（會觸發重建，這正是原本「回頂」的時機）
const imNew2 = makeEl("img");
imNew2._rect = { width: 300, height: 300 };
imNew2.attrs.src = "https://media.discordapp.net/attachments/1/2/added.png?ex=1&width=300";
hostC.appendChild(imNew2);
R("scanNow");
await delay(500);
ok("重建後內層提示詞框仍在原位（120）", pres[0] && pres[0].scrollTop === 120, pres[0] && pres[0].scrollTop);
ok("重建後列表仍在原位（30）", listEl && listEl.scrollTop === 30, listEl && listEl.scrollTop);
const presAfter = walk(body, []).filter((e) => e.tagName === "PRE");
ok("沒有多出重複的提示詞框", presAfter.length === pres.length, [pres.length, presAfter.length]);


// ---------- 懸浮球：拖動 / 歸位 / 隱藏 ----------
console.log("== 悬浮球拖动与隐藏 ==");
const fabEl = walk(body, []).filter((e) => String(e.className).split(/\s+/).indexOf("dmd-fab") !== -1)[0];
ok("找到悬浮球", !!fabEl, !!fabEl);
const panelWrap = byId("dmd-panel");
const dispBefore = panelWrap ? panelWrap.style.display : "";
const p0 = settingsPatches.length;
fabEl.dispatch("pointerdown", { clientX: 100, clientY: 100, button: 0 });
fabEl.dispatch("pointermove", { clientX: 300, clientY: 220 });
fabEl.dispatch("pointerup", {});
await delay(50);
const posPatch = settingsPatches.slice(p0).filter((p) => p.fabPos).pop();
ok("拖动后保存了位置（200,120）", !!posPatch && posPatch.fabPos.x === 200 && posPatch.fabPos.y === 120, posPatch);
ok("球的位置同步更新", fabEl.style.left === "200px" && fabEl.style.top === "120px", [fabEl.style.left, fabEl.style.top]);
fabEl.dispatch("click", {});
await delay(50);
ok("刚拖完的那次点击不会展开面板", (panelWrap ? panelWrap.style.display : "") === dispBefore, [dispBefore, panelWrap && panelWrap.style.display]);
const p1 = settingsPatches.length;
fabEl.dispatch("dblclick", {});
ok("双击回到默认位置（fabPos=null）", settingsPatches.slice(p1).some((p) => p.fabPos === null), settingsPatches.slice(p1));
const hideEl = walk(fabEl, []).filter((e) => String(e.className).split(/\s+/).indexOf("dmd-fab-hide") !== -1)[0];
ok("悬浮球上有隐藏按钮（×）", !!hideEl, !!hideEl);
const p2 = settingsPatches.length;
if (hideEl) { hideEl.dispatch("click", {}); }
const hidePatch = settingsPatches.slice(p2).filter((p) => p.fabHidden === true);
ok("点 × 会写入 fabHidden", hidePatch.length > 0, settingsPatches.slice(p2));
ok("隐藏后球不再显示", fabEl.style.display === "none", fabEl.style.display);
if (storageListeners[0]) {
  storageListeners[0]({ settings: { newValue: { enabled: true, fabHidden: false, autoScan: false } } }, "local");
  await delay(250);
  ok("设定改回后球重新出现", fabEl.style.display === "" , fabEl.style.display);
} else { ok("有 storage 監聽可重新顯示", false, "no listener"); }

console.log("徽章回歸: " + pass + " 通過, " + fail + " 失敗");
process.exit(fail ? 1 : 0);