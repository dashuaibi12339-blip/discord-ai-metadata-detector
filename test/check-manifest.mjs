// test/check-manifest.mjs —— 校驗 manifest 引用與 HTML id 引用（避免出現點不到的控件）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
let bad = 0;

// 1) manifest 引用的檔案都要存在
const refs = [];
const push = (p) => { if (p) { refs.push(p); } };
push(mf.background && mf.background.service_worker);
for (const cs of mf.content_scripts || []) { (cs.js || []).forEach(push); (cs.css || []).forEach(push); }
push(mf.action && mf.action.default_popup);
for (const v of Object.values((mf.action && mf.action.default_icon) || {})) { push(v); }
for (const v of Object.values(mf.icons || {})) { push(v); }
push(mf.options_ui && mf.options_ui.page);
for (const war of mf.web_accessible_resources || []) {
  for (const r of war.resources || []) { if (r.indexOf("*") === -1) { refs.push(r); } }
}
for (const r of refs) {
  const p = path.join(root, r);
  if (!(fs.existsSync(p) && fs.statSync(p).isFile())) { bad++; console.log("  缺少: " + r); }
}
console.log("manifest 引用檔案 " + refs.length + " 個，" + (bad ? bad + " 個缺失！" : "全部存在 ✓"));

// 2) popup / options 的 JS 用 $("id") 或 getElementById 取用的元素，HTML 裡必須真的存在
const pairs = [
  { js: "popup/popup.js", html: "popup/popup.html" },
  { js: "options/options.js", html: "options/options.html" },
];
for (const pair of pairs) {
  const js = fs.readFileSync(path.join(root, pair.js), "utf8");
  const html = fs.readFileSync(path.join(root, pair.html), "utf8");
  const ids = new Set();
  const re = /\$\("([A-Za-z0-9_-]+)"\)|getElementById\("([A-Za-z0-9_-]+)"\)/g;
  let m;
  while ((m = re.exec(js))) { ids.add(m[1] || m[2]); }
  let miss = 0;
  for (const id of ids) {
    if (html.indexOf('id="' + id + '"') === -1) { miss++; bad++; console.log("  " + pair.js + " 取用了 HTML 裡不存在的 id: " + id); }
  }
  console.log("  " + pair.js + " 取用 " + ids.size + " 個 id" + (miss ? "（" + miss + " 個缺失！）" : "，全部存在 ✓"));
}

// 3) Service Worker 相容性：lib/ 與 background/ 會被 MV3 Service Worker 載入
//    （Node 測試允許動態 import()，但 ServiceWorkerGlobalScope 禁止 → 這類問題必須靠靜態檢查兜住）
const swFiles = [];
for (const dir of ["lib", "background"]) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (f.endsWith(".js")) { swFiles.push(path.join(dir, f)); }
  }
}
let swBad = 0;
for (const rel of swFiles) {
  const lines = fs.readFileSync(path.join(root, rel), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/\bimport\s*\(/.test(code)) { swBad++; bad++; console.log("  " + rel + ":" + (i + 1) + " Service Worker 不能用動態 import()"); }
    if (/\bdocument\s*\.|\bwindow\s*\.|XMLHttpRequest|localStorage/.test(code)) { swBad++; bad++; console.log("  " + rel + ":" + (i + 1) + " Service Worker 不能用頁面 API：" + line.trim().slice(0, 70)); }
  });
}
console.log("Service Worker 相容性：" + swFiles.length + " 個檔案" + (swBad ? "（" + swBad + " 處問題！）" : "，無動態 import / 無頁面 API ✓"));

// 4) 基本資訊
console.log("permissions: " + JSON.stringify(mf.permissions));
console.log("host_permissions: " + JSON.stringify(mf.host_permissions));
console.log("content_scripts matches: " + JSON.stringify((mf.content_scripts || []).map((c) => c.matches)));
process.exit(bad ? 1 : 0);
