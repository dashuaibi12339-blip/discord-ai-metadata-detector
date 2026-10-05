// test/consistency-test.mjs —— 校驗內容腳本裡重複實作的工具函式與 lib 版本完全一致
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeKey as libNormalize, fileNameOf as libFileName, candidates } from "../lib/discord-url.js";
import { matchKeyword } from "../lib/filter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "content", "content.js"), "utf8");

function grabFunction(name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) { throw new Error("找不到函式 " + name); }
  let depth = 0, i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") { depth++; }
    else if (src[i] === "}") { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
  }
  throw new Error("函式 " + name + " 括號不平衡");
}
const imgRe = /\n\s*var (IMG_RE|VID_RE) = ([^\n]+);/g;
const extras = [];
let m;
while ((m = imgRe.exec(src))) { extras.push("var " + m[1] + " = " + m[2] + ";"); }

const code = [grabFunction("normalizeKey"), grabFunction("fileNameOf"), grabFunction("matchKeywordLocal"), ...extras,
  "return { normalizeKey: normalizeKey, fileNameOf: fileNameOf, matchKeywordLocal: matchKeywordLocal, IMG_RE: IMG_RE, VID_RE: VID_RE };"].join("\n");
const contentFns = new Function(code)();

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log("  FAIL  " + name + (extra !== undefined ? " -> " + JSON.stringify(extra) : "")); } }

const urls = [
  "https://media.discordapp.net/attachments/1/2/file.png?ex=abc&is=def&hm=ghi&width=800&height=800",
  "https://cdn.discordapp.com/attachments/1/2/%E4%B8%AD%E6%96%87%20file.webp?ex=1&is=2&hm=3",
  "https://media.discordapp.net/attachments/0/0/no-extension?ex=1",
  "https://cdn.discordapp.com/attachments/99/88/a_b-c.d.PNG?ex=1&is=2&hm=3",
  "https://media.discordapp.net/external/xxx/https%3A%2F%2Fexample.com%2Fa.png",
  "not-a-url",
  "",
];
for (const u of urls) {
  ok("normalizeKey 一致: " + u.slice(0, 60), contentFns.normalizeKey(u) === libNormalize(u), [contentFns.normalizeKey(u), libNormalize(u)]);
  ok("fileNameOf 一致: " + u.slice(0, 60), contentFns.fileNameOf(u) === libFileName(u), [contentFns.fileNameOf(u), libFileName(u)]);
  ok("candidates 不會拋例外: " + u.slice(0, 40), Array.isArray(candidates(u)));
}

// 原圖 URL 改寫：media → cdn、丟掉縮放參數、保留 ex/is/hm
const proxy = "https://media.discordapp.net/attachments/1/2/image.png?ex=abc&is=def&hm=ghi&width=800&height=800&format=webp&quality=lossless";
const cands = candidates(proxy);
ok("第一個候選是 cdn 原圖", cands[0] === "https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc&is=def&hm=ghi", cands[0]);
ok("縮放參數已被移除", cands[0].indexOf("width=") === -1 && cands[0].indexOf("height=") === -1 && cands[0].indexOf("format=") === -1, cands[0]);
ok("簽名參數完整保留", cands[0].indexOf("ex=abc") !== -1 && cands[0].indexOf("is=def") !== -1 && cands[0].indexOf("hm=ghi") !== -1, cands[0]);
ok("媒體代理只當備援", cands[1].indexOf("media.discordapp.net") !== -1, cands[1]);
ok("原始 URL 也在候選中", cands.indexOf(proxy) !== -1);

const kwCases = [["blue archive 1girl", "1girl, blue_archive, masterpiece"], ["BLUE ARCHIVE", "blue archive"], ["蓝色 归档", "蓝色_归档 test"], ["a b", "b a"], ["a c", "a b"], ["", "anything"], ["   ", "anything"]];
for (const [kw, text] of kwCases) {
  ok("matchKeyword 一致: " + JSON.stringify(kw), contentFns.matchKeywordLocal(text, kw) === matchKeyword(text, kw), [contentFns.matchKeywordLocal(text, kw), matchKeyword(text, kw)]);
}

const files = ["a.png", "a.PNG", "a.jpeg", "a.webp", "a.gif", "a.mp4", "a.webm", "a.txt", "noext", "a.avif"];
ok("IMG_RE 判斷合理", files.map((f) => contentFns.IMG_RE.test(f)).join(",") === "true,true,true,true,true,false,false,false,false,true", files.map((f) => f + "=" + contentFns.IMG_RE.test(f)).join(" "));
ok("VID_RE 判斷合理", files.map((f) => contentFns.VID_RE.test(f)).join(",") === "false,false,false,false,false,true,true,false,false,false", files.map((f) => f + "=" + contentFns.VID_RE.test(f)).join(" "));

console.log("內容腳本 / lib 一致性: " + pass + " 通過, " + fail + " 失敗");
process.exit(fail === 0 ? 0 : 1);
