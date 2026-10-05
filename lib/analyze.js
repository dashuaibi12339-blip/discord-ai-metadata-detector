// lib/analyze.js —— 位元組 -> 完整分析結果（來源分類 + 提示詞抽取）
import { extractMetadata } from "./metadata.js";
import { detectSource, detectTool, isNovelAiComment } from "./classify.js";
import { parseA1111Parameters } from "./a1111.js";
import { parseNovelAi } from "./novelai.js";
import { parseInvokeAi } from "./invokeai.js";
import { parseComfyWorkflow } from "./comfyui.js";
import { trimText } from "./util.js";

const PROMPT_BEARING = ["prompt", "workflow", "generation_data", "ComfyScript", "parameters", "Comment",
  "User Comment", "Image Description", "Description", "Make", "Model", "sd-metadata", "invokeai_metadata",
  "Dream", "Textual Data", "XMP", "Creator Tool"];

const SEARCH_TEXT_LIMIT = 8192;   // 關鍵字搜尋用，不需要把 8MB 的文字區塊整份串起來

export function searchTextOf(md) {
  const parts = [];
  let total = 0;
  for (const e of md.entries || []) {
    if (!e.value) { continue; }
    const v = String(e.value);
    const take = v.slice(0, Math.max(0, SEARCH_TEXT_LIMIT - total));
    if (!take) { break; }
    parts.push(take);
    total += take.length;
    if (total >= SEARCH_TEXT_LIMIT) { break; }
  }
  return parts.join("\n");
}

export function previewOf(md, fields) {
  let best = "";
  for (const f of fields || []) {
    if (f.title === "Prompt" && f.text) { return trimText(f.text, 800); }
  }
  for (const f of fields || []) { if (f.text && f.text.length > best.length) { best = f.text; } }
  if (best.length > 20) { return trimText(best, 800); }
  for (const e of md.entries || []) {
    if (!e.value || !e.name) { continue; }
    if (PROMPT_BEARING.indexOf(e.name) === -1 && e.name !== "Textual Data") { continue; }
    if (e.text && e.text.length > best.length) { best = e.text; }
    else if (e.value.length > best.length) { best = e.value; }
  }
  if (!best) {
    for (const e of md.entries || []) { if (e.value && e.value.length > best.length && e.value.length > 20) { best = e.value; } }
  }
  return trimText(best, 800);
}

export async function analyzeBytes(bytes, opts) {
  const md = await extractMetadata(bytes, opts);
  return analyzeMetadata(md);
}

export function analyzeMetadata(md) {
  const res = {
    format: md.format, width: md.width, height: md.height,
    source: "none", tool: "", hasAnyMetadata: (md.entries || []).length > 0,
    prompt: "", negative: "", fields: [], params: {}, preview: "", searchText: "",
    entryCount: (md.entries || []).length, truncated: !!md.truncated, notes: md.notes || [],
    pngTextKeys: Object.keys(md.pngText || {}), exifNames: (md.exif || []).map((e) => e.name),
  };
  const pngText = md.pngText || {};
  const fields = [];

  const useA1111 = (text) => {
    const r = parseA1111Parameters(text);
    if (r && (r.fields.length || r.prompt)) { fields.push.apply(fields, r.fields); res.prompt = res.prompt || r.prompt; res.negative = res.negative || r.negative; Object.assign(res.params, r.params); return true; }
    return false;
  };
  const useComfy = (p, w) => {
    const r = parseComfyWorkflow(p, w);
    if (r) { fields.push.apply(fields, r.fields); res.prompt = res.prompt || r.prompt; res.negative = res.negative || r.negative; Object.assign(res.params, r.params); return true; }
    return false;
  };
  const useNovelAi = (text) => {
    const r = parseNovelAi(text);
    if (r) { fields.push.apply(fields, r.fields); res.prompt = res.prompt || r.prompt; res.negative = res.negative || r.negative; Object.assign(res.params, r.params); return true; }
    return false;
  };
  const useInvoke = (text) => {
    const r = parseInvokeAi(text);
    if (r) { fields.push.apply(fields, r.fields); res.prompt = res.prompt || r.prompt; res.negative = res.negative || r.negative; Object.assign(res.params, r.params); return true; }
    return false;
  };

  // 1) PNG 文字區塊（最常見）
  if (pngText.parameters) { useA1111(pngText.parameters); }
  if (pngText.prompt || pngText.workflow) { useComfy(pngText.prompt, pngText.workflow); }
  if (!res.prompt && pngText.Comment && isNovelAiComment(pngText.Comment)) { useNovelAi(pngText.Comment); }
  if (!res.prompt && pngText.Description && isNovelAiComment(pngText.Description)) { useNovelAi(pngText.Description); }
  if (!res.prompt && pngText["sd-metadata"]) { useInvoke(pngText["sd-metadata"]); }
  if (!res.prompt && pngText.invokeai_metadata) { useInvoke(pngText.invokeai_metadata); }
  if (!res.prompt && pngText["invokeai_graph"]) { useInvoke(pngText["invokeai_graph"]); }
  if (!res.prompt && pngText.Dream) { useInvoke(pngText.Dream); }
  if (!res.prompt && pngText.ComfyScript) { useComfy(pngText.ComfyScript, null); }

  // 2) EXIF / WebP：ComfyUI 會把 prompt:{...} 寫進 Make/Model/Image Description
  const exifMap = md.exifMap || {};
  const exifCandidates = [["Image Description", exifMap["Image Description"]], ["User Comment", exifMap["User Comment"]],
    ["Comment", exifMap["Comment"] || md.comment], ["Windows XP Comment", exifMap["Windows XP Comment"]],
    ["Make", exifMap["Make"]], ["Model", exifMap["Model"]], ["Software", exifMap["Software"]],
    ["Description", exifMap["Description"]], ["XMP", md.xmp], ["Creator Tool", exifMap["Creator Tool"]]];
  for (const pair of exifCandidates) {
    const name = pair[0];
    let value = pair[1];
    if (!value || typeof value !== "string") { continue; }
    const v = value.trim();
    const innerPrompt = v.indexOf("prompt:{") === 0 ? v.slice("prompt:".length) : (v.indexOf("workflow:{") === 0 ? null : null);
    if (innerPrompt) { if (!res.prompt) { useComfy(innerPrompt, null); } continue; }
    if (v.indexOf("workflow:{") === 0) { if (!res.prompt) { useComfy(null, v.slice("workflow:".length)); } continue; }
    if (v.indexOf("Steps: ") !== -1 && !res.prompt) { useA1111(v); continue; }
    if (v[0] === "{" && v.indexOf('"class_type"') !== -1 && !res.prompt) { useComfy(v, null); continue; }
    if (v[0] === "{" && isNovelAiComment(v) && !res.prompt) { useNovelAi(v); continue; }
    if (v[0] === "{" && v.indexOf('"sd-metadata"') !== -1 && !res.prompt) { useInvoke(v); continue; }
    if (name !== "Make" && name !== "Model" && v[0] === "{" && !res.prompt) { useInvoke(v); }
  }
  if (!res.prompt && md.stealthJson) { useStealthWrapper(md, fields, res, useNovelAi, useA1111); }
  if (!res.prompt && md.stealthComment) { useNovelAi(md.stealthComment); }

  // 3) 都沒有：把最長的文字值當成純文字提示詞
  if (!res.prompt) {
    let best = "";
    for (const e of md.entries || []) {
      const t = e.name === "Textual Data" ? (e.text || "") : (e.value || "");
      if (t && t.length > best.length && !/^\{[\s\S]*\}$/.test(t.trim())) { best = t; }
    }
    if (best.length > 20) { res.prompt = trimText(best, 4000); fields.unshift({ title: "Text", text: res.prompt }); }
  }

  res.source = detectSource(md.entries);
  if (res.source === "none" && (md.stealthNovelAi || md.stealthJson || md.stealthComment)) { res.source = "novelai"; }
  res.tool = detectTool(md);
  res.fields = dedupeFields(fields);
  res.preview = previewOf(md, res.fields);
  res.searchText = searchTextOf(md);
  res.hasAiPrompt = res.source !== "none";
  res.reencoded = detectDiscordReencode(md);
  res.category = res.source;
  res.paramsString = paramString(res.params);
  if (res.truncated && res.source === "none") { res.notes.push("位元組被截斷，可能漏掉後段中繼資料"); }
  return res;
}

// Discord 的媒體服務在重新編碼過的附件裡會寫入自己的標記（實測樣本見過這兩個值）
function detectDiscordReencode(md) {
  for (const e of md.entries || []) {
    const v = String(e.value || "");
    if (v.indexOf("Optimized for web") !== -1 || v.indexOf("Processed by MediaService") !== -1) { return true; }
  }
  return false;
}

// 隱寫內容通常是 { Description, Software, Source, "Generation time", Comment } 這種包裝，
// 真正的 NovelAI 提示詞 JSON 在 Comment 裡；Description 則直接是提示詞文字。
function useStealthWrapper(md, fields, res, useNovelAi, useA1111) {
  let wrapper = null;
  try { wrapper = JSON.parse(md.stealthJson); } catch (e) { wrapper = null; }
  if (!wrapper || typeof wrapper !== "object") { useNovelAi(md.stealthJson); return; }
  for (const k of Object.keys(wrapper)) {
    const v = wrapper[k];
    if (v === undefined || v === null || v === "") { continue; }
    md.entries.push({ group: "PNG-stealth", name: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
  }
  if (typeof wrapper.Comment === "string" && isNovelAiComment(wrapper.Comment)) { useNovelAi(wrapper.Comment); }
  if (!res.prompt && typeof wrapper.Description === "string" && wrapper.Description.trim()) {
    res.prompt = wrapper.Description.trim();
    fields.unshift({ title: "Description", text: res.prompt });
  }
  if (!res.prompt && typeof wrapper.Parameters === "string") { useA1111(wrapper.Parameters); }
  if (!res.negative && typeof wrapper.uc === "string") { res.negative = wrapper.uc; }
}

function paramString(params) {
  const order = ["model", "loras", "sampler", "scheduler", "steps", "cfg_scale", "guidance", "seed", "size", "denoising_strength", "vae"];
  const label = { model: "模型", loras: "LoRA", sampler: "取樣器", scheduler: "排程器", steps: "步數", cfg_scale: "CFG", guidance: "Guidance", seed: "Seed", size: "尺寸", denoising_strength: "Denoise", vae: "VAE" };
  const out = [];
  for (const k of order) { if (params[k] !== undefined && params[k] !== "") { out.push(label[k] + ": " + params[k]); } }
  return out.join(" · ");
}

function dedupeFields(fields) {
  const seen = {};
  const out = [];
  for (const f of fields || []) {
    if (!f || !f.text) { continue; }
    const key = (f.title || "") + "\u0000" + f.text;
    if (seen[key]) { continue; }
    seen[key] = 1;
    out.push({ title: f.title || "", text: f.text });
  }
  return out;
}
