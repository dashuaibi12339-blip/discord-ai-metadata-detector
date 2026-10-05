// test/stealth-url.mjs —— 命令列驗證某張圖有沒有 alpha 通道隱寫（NovelAI）
// 用法：node test/stealth-url.mjs "<圖片直鏈>"   或   node test/stealth-url.mjs 本機檔案.png
import fs from "node:fs";
import { decodePngToRgba } from "./png-rgba.mjs";
import { extractStealthFromRgba } from "../lib/stealth.js";
import { analyzeMetadata } from "../lib/analyze.js";
import { candidates } from "../lib/discord-url.js";

const arg = process.argv[2];
if (!arg) { console.log("用法: node test/stealth-url.mjs <圖片直鏈|本機檔案>"); process.exit(1); }

let bytes;
if (/^https?:/.test(arg)) {
  const url = candidates(arg)[0];
  console.log("請求:", url.slice(0, 120));
  const res = await fetch(url, { credentials: "omit" });
  console.log("HTTP", res.status, res.headers.get("content-type"), res.headers.get("content-length") || "");
  if (!res.ok) { console.log("→ 下載失敗（Discord 簽名約 24 小時過期）"); process.exit(1); }
  bytes = new Uint8Array(await res.arrayBuffer());
} else {
  bytes = new Uint8Array(fs.readFileSync(arg));
}
console.log("位元組:", bytes.length);

const d = decodePngToRgba(bytes);
if (d.error) { console.log("不是可解的 PNG：", d.error); process.exit(1); }
console.log("尺寸:", d.w + "x" + d.h);
const alphaSet = new Map();
for (let i = 3; i < d.rgba.length; i += 4) { alphaSet.set(d.rgba[i], (alphaSet.get(d.rgba[i]) || 0) + 1); }
console.log("alpha 值分佈（前 4）:", Array.from(alphaSet.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0] + "×" + x[1]).join(", "));

const s = await extractStealthFromRgba(d.rgba, d.w, d.h);
if (!s.ok) { console.log("\n沒有可讀的 alpha 隱寫資料。"); process.exit(0); }
console.log("\n找到隱寫資料:", JSON.stringify({ kind: s.kind, order: s.order, rows: s.rows }));
console.log("內容前 400 字:\n" + s.json.slice(0, 400));
const md = { format: "png", width: d.w, height: d.h, pngText: {}, exif: [], exifMap: {}, entries: [{ group: "PNG-stealth", name: "Stealth", value: "stealth_pngcomp" }], notes: [], stealthJson: s.json, stealthNovelAi: true };
const an = analyzeMetadata(md);
console.log("\n解析結果: source=" + an.source + " tool=" + an.tool + " params=" + JSON.stringify(an.params));
console.log("正向提示詞:\n" + (an.prompt || "(空)").slice(0, 500));
if (an.negative) { console.log("負面提示詞:\n" + an.negative.slice(0, 300)); }
