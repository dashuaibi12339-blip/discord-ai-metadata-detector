// test/live-test.mjs —— 對真實 Discord CDN 連結做端到端驗證（URL 由命令列參數或 --file 提供）
// 用法：node test/live-test.mjs "https://media.discordapp.net/attachments/..." [更多 url]
import fs from "node:fs";
import { candidates, normalizeKey } from "../lib/discord-url.js";
import { extractMetadata } from "../lib/metadata.js";
import { analyzeMetadata } from "../lib/analyze.js";

const args = process.argv.slice(2);
let urls = args.filter(function (a) { return /^https?:/.test(a); });
const fileArgIndex = args.indexOf("--file");
if (fileArgIndex !== -1 && args[fileArgIndex + 1]) {
  const raw = fs.readFileSync(args[fileArgIndex + 1], "utf8");
  const found = raw.match(/https?:\/\/[^\s"']+/g) || [];
  urls = urls.concat(found);
}
urls = urls.filter(function (u) { return u.indexOf("/attachments/") !== -1; });
const seen = {};
urls = urls.filter(function (u) { if (seen[u]) { return false; } seen[u] = 1; return true; });

if (urls.length === 0) { console.log("沒有可測試的 URL"); process.exit(1); }

const HEAD = 262144;
let okCount = 0;

for (const url of urls.slice(0, 8)) {
  const cands = candidates(url);
  console.log("\n=== " + normalizeKey(url));
  let done = false;
  for (const cand of cands) {
    const host = new URL(cand).hostname;
    let res;
    try {
      res = await fetch(cand, { headers: { Range: "bytes=0-" + (HEAD - 1) }, credentials: "omit" });
    } catch (e) {
      console.log("  " + host + " -> fetch 失敗: " + e.message);
      continue;
    }
    const cr = res.headers.get("content-range") || "";
    const total = cr ? parseInt(cr.split("/")[1], 10) : parseInt(res.headers.get("content-length") || "0", 10);
    const ab = new Uint8Array(await res.arrayBuffer());
    console.log("  " + host + " -> HTTP " + res.status + "  type=" + (res.headers.get("content-type") || "") +
      "  total=" + total + "  取得=" + ab.length + "  CORS=" + (res.headers.get("access-control-allow-origin") || "-"));
    if ((res.status === 200 || res.status === 206) && ab.length > 32) {
      const md = await extractMetadata(ab, { fragment: ab.length < total });
      const an = analyzeMetadata(md);
      console.log("    格式=" + md.format + " 尺寸=" + md.width + "x" + md.height + " 截斷=" + md.truncated +
        " 文字區塊=" + JSON.stringify(Object.keys(md.pngText)) + " EXIF欄位=" + md.exif.length +
        " 來源=" + an.source + " 工具=" + (an.tool || "-"));
      if (an.prompt) { console.log("    提示詞預覽=" + String(an.prompt).replace(/\s+/g, " ").slice(0, 100)); }
      okCount++;
      done = true;
      break;
    }
  }
  if (!done) { console.log("  !! 所有候選網址都失敗"); }
}
console.log("\n完成：成功驗證 " + okCount + " 個連結");
