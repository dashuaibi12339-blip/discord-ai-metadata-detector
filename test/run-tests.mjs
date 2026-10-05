// test/run-tests.mjs —— 解析器回歸測試（node test/run-tests.mjs）
import { writeFixtures, buildStealthPng, A1111_PARAMETERS, NAI_COMMENT, COMFY_PROMPT } from "./gen-fixtures.mjs";
import { decodePngToRgba } from "./png-rgba.mjs";
import { analyzeMetadata } from "../lib/analyze.js";
import { analyzeBytes } from "../lib/analyze.js";
import { matchKeyword } from "../lib/filter.js";
import { extractStealthFromRgba } from "../lib/stealth.js";
import zlib from "node:zlib";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function section(t) { console.log("\n== " + t + " =="); }

const fx = writeFixtures();

section("A1111 PNG");
{
  const r = await analyzeBytes(fx["a1111.png"]);
  ok("source=comfyui", r.source === "comfyui", r.source);
  ok("tool 標籤含 A1111", /A1111/.test(r.tool), r.tool);
  ok("prompt", r.prompt.indexOf("blue archive") !== -1, r.prompt.slice(0, 60));
  ok("negative", r.negative.indexOf("lowres") !== -1, r.negative);
  ok("steps=28", r.params.steps === "28", r.params);
  ok("sampler", (r.params.sampler || "").indexOf("DPM++ 2M") !== -1, r.params);
  ok("cfg_scale=7", String(r.params.cfg_scale) === "7", r.params);
  ok("seed", r.params.seed === "1234567890", r.params);
  ok("size", r.params.size === "832x1216", r.params);
  ok("model", (r.params.model || "") === "anything-v5", r.params);
  ok("文字關鍵字 blue_archive 可命中 blue archive", matchKeyword(r.searchText, "blue_archive"));
  ok("關鍵字大小寫不敏感", matchKeyword(r.searchText, "BLUE ARCHIVE"));
  ok("不存在的關鍵字不命中", !matchKeyword(r.searchText, "zzzz-not-exist"));
}

section("NovelAI PNG");
{
  const r = await analyzeBytes(fx["novelai.png"]);
  ok("source=novelai", r.source === "novelai", r.source);
  ok("tool=NovelAI", r.tool === "NovelAI", r.tool);
  ok("prompt", r.prompt.indexOf("blue archive") !== -1, r.prompt);
  ok("negative(uc)", r.negative.indexOf("bad hands") !== -1, r.negative);
  ok("steps=28", String(r.params.steps) === "28", r.params);
  ok("size=832x1216", r.params.size === "832x1216", r.params);
  ok("負面提示詞不誤判為 ComfyUI", r.source !== "comfyui", r.source);
}

section("NovelAI V4.5 PNG（prompt 是 caption 物件）");
{
  const r = await analyzeBytes(fx["novelai-v4.png"]);
  ok("source=novelai", r.source === "novelai", r.source);
  ok("正向提示詞取 base_caption（不是一坨 JSON）", r.prompt.indexOf("year 2026") !== -1 && r.prompt.indexOf('{"caption"') === -1, r.prompt);
  ok("角色提示詞有帶上", r.prompt.indexOf("blue_archive") !== -1, r.prompt);
  ok("負面提示詞取 uc.caption.base_caption", r.negative.indexOf("lowres") !== -1, r.negative);
  ok("提示詞不是 JSON 開頭", r.prompt.trim()[0] !== "{", r.prompt.trim().slice(0, 20));
}

section("ComfyUI PNG (zTXt prompt + iTXt workflow)");
{
  const r = await analyzeBytes(fx["comfyui.png"]);
  ok("source=comfyui", r.source === "comfyui", r.source);
  ok("tool=ComfyUI", r.tool === "ComfyUI", r.tool);
  ok("prompt 由節點圖還原", r.prompt === "a cute cat, masterpiece", r.prompt);
  ok("negative 由節點圖還原", r.negative === "bad quality, worst quality", r.negative);
  ok("steps=25", String(r.params.steps) === "25", r.params);
  ok("cfg=7", String(r.params.cfg_scale) === "7", r.params);
  ok("sampler=euler", r.params.sampler === "euler", r.params);
  ok("model", r.params.model === "sd_xl_base_1.0.safetensors", r.params);
  ok("lora", (r.params.loras || "").indexOf("add_detail") !== -1, r.params);
}

section("InvokeAI PNG");
{
  const r = await analyzeBytes(fx["invokeai.png"]);
  ok("source=comfyui(本地工具)", r.source === "comfyui", r.source);
  ok("tool=InvokeAI", r.tool === "InvokeAI", r.tool);
  ok("prompt", r.prompt.indexOf("dragon") !== -1, r.prompt);
}

section("無中繼資料");
{
  const r = await analyzeBytes(fx["plain.png"]);
  ok("source=none", r.source === "none", r.source);
  ok("hasAnyMetadata=false", r.hasAnyMetadata === false);
  const j = await analyzeBytes(fx["plain.webp"]);
  ok("webp source=none", j.source === "none", j.source);
}

section("EXIF / WebP");
{
  const cam = await analyzeBytes(fx["camera.jpg"]);
  ok("相機 EXIF 不誤判為 AI", cam.source === "none", cam.source);
  ok("相機 EXIF 仍算有中繼資料", cam.hasAnyMetadata === true);
  ok("EXIF Make 讀到 Canon", (cam.exifNames || []).length > 0, cam.exifNames);

  const a1111jpg = await analyzeBytes(fx["a1111.jpg"]);
  ok("JPEG UserComment A1111 -> comfyui", a1111jpg.source === "comfyui", a1111jpg.source);
  ok("JPEG 提示詞抽到", /1girl/.test(a1111jpg.searchText), a1111jpg.prompt.slice(0, 40));

  const w = await analyzeBytes(fx["comfyui.webp"]);
  ok("WebP EXIF Make=prompt:{...} -> comfyui", w.source === "comfyui", w.source);
  ok("WebP 抽到 ComfyUI 提示詞", w.prompt === "a cute cat, masterpiece", w.prompt);

  {
    const post = await analyzeBytes(fx["post-text.png"]);
    ok("尾段 tEXt 也能判為 comfyui", post.source === "comfyui", post.source);
    ok("尾段 tEXt 提示詞抽取正常", (post.prompt || "").indexOf("blue archive") !== -1, (post.prompt || "").slice(0, 50));
  }
  const re = await analyzeBytes(fx["discord-reencoded.jpg"]);
  ok("Discord 重編碼痕跡 -> reencoded", re.reencoded === true, re.reencoded);
  ok("Discord 重編碼不誤判為 AI", re.source === "none", re.source);
  ok("Discord 重編碼仍算有中繼資料", re.hasAnyMetadata === true);

  const x = await analyzeBytes(fx["xmp.webp"]);
  ok("WebP XMP 提示詞抽到", x.searchText.indexOf("Steps: 30") !== -1, x.searchText.slice(0, 60));
}

section("PNG 截斷（只給前 40 位元組）");
{
  const head = fx["a1111.png"].subarray(0, 40);
  const r = await analyzeBytes(head, { fragment: true });
  ok("截斷不崩潰", typeof r.source === "string");
}

section("NovelAI alpha 隱寫（stealth_pngcomp）");
{
  const width = 64, height = 64;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 128; rgba[i + 3] = 254; }
  // 把 magic + 長度 + gzip(JSON) 的位元依 raster 順序寫進 alpha 的 LSB
  const json = NAI_COMMENT;
  const comp = zlib.gzipSync(Buffer.from(json, "utf8"));
  const magic = Buffer.from("stealth_pngcomp", "latin1");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(comp.length * 8, 0);
  const payload = Buffer.concat([magic, lenBuf, comp]);
  let bitIndex = 0;
  for (const byte of payload) {
    for (let b = 7; b >= 0; b--) {
      const bit = (byte >> b) & 1;
      const p = bitIndex++;
      rgba[p * 4 + 3] = (rgba[p * 4 + 3] & 0xfe) | bit;
    }
  }
  const s = await extractStealthFromRgba(rgba, width, height);
  ok("隱寫可解出 JSON", s.ok === true, s);
  if (s.ok) {
    ok("隱寫 JSON 內含 prompt", s.json.indexOf('"prompt"') !== -1, s.json.slice(0, 40));
    const parsed = JSON.parse(s.json);
    ok("隱寫 prompt 正確", parsed.prompt.indexOf("blue archive") !== -1, parsed.prompt);
  }
}

section("alpha 隱寫：逐欄排布 + 包裝結構（{Description, Software, Source, Comment}）");
{
  const wrapper = JSON.stringify({
    Description: "masterpiece, best quality, blue archive",
    Software: "NovelAI",
    Source: "novelai.net",
    "Generation time": "1.2s",
    Comment: NAI_COMMENT,
  });
  const png = buildStealthPng(64, 64, wrapper);
  const d = decodePngToRgba(png);
  ok("PNG 可解成 RGBA", !d.error && d.w === 64, d.error || d.w);
  const s = await extractStealthFromRgba(d.rgba, d.w, d.h);
  ok("隱寫可解出", s.ok === true, s);
  ok("解出的順序是逐欄", s.order === "column", s.order);
  ok("內容是包裝 JSON", s.ok && s.json.indexOf('"Software"') !== -1, s.ok && s.json.slice(0, 60));
  const md = { format: "png", width: d.w, height: d.h, pngText: {}, exif: [], exifMap: {}, entries: [{ group: "PNG-stealth", name: "Stealth", value: "stealth_pngcomp" }], notes: [], stealthJson: s.json, stealthNovelAi: true };
  const an = analyzeMetadata(md);
  ok("包裝 JSON -> source=novelai", an.source === "novelai", an.source);
  ok("提示詞取自 Description", (an.prompt || "").indexOf("blue archive") !== -1, (an.prompt || "").slice(0, 60));
  ok("Comment 內的參數也解析出來", String(an.params.steps) === "28", an.params);
  ok("標籤標明來自隱寫", an.tool.indexOf("隱寫") !== -1, an.tool);
}

section("隱寫低成本預檢（純 JS，不需要 canvas）");
{
  const { probeStealthPrefix, extractStealthFromPngBytesPure } = await import("../lib/png-alpha.js");
  const stealthPng = fx["stealth.png"];
  const probe = await probeStealthPrefix(stealthPng);
  ok("有隱寫 -> positive", probe.status === "positive", probe);
  const pure = await extractStealthFromPngBytesPure(stealthPng);
  ok("純 JS 也能完整解出", pure.ok === true, pure);
  ok("解出的內容含提示詞", pure.ok && pure.json.indexOf("blue archive") !== -1, pure.ok && pure.json.slice(0, 50));
  const rgb = await probeStealthPrefix(fx["rgb-plain.png"]);
  ok("沒有 alpha 通道 -> no-channel（連位元組都不用多讀）", rgb.status === "no-channel", rgb);
  const big = fx["big-rgba-plain.png"];
  const probeBigFull = await probeStealthPrefix(big);
  ok("大圖無隱寫 -> negative", probeBigFull.status === "negative", probeBigFull);
  const head = big.subarray(0, 131072);
  const probeHead = await probeStealthPrefix(head);
  ok("只給前 128KB -> need-more（需要再抓一點才夠判斷）", probeHead.status === "need-more", probeHead);
}

console.log("\\n總計: " + pass + " 通過, " + fail + " 失敗");
process.exit(fail === 0 ? 0 : 1);
