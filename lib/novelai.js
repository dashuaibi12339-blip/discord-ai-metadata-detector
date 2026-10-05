// lib/novelai.js —— NovelAI 的 Comment / Description JSON 解析（含 V4 / V4.5 的 caption 結構）
export function parseNovelAi(jsonStr) {
  let json = null;
  if (typeof jsonStr === "string") {
    try { json = JSON.parse(jsonStr); } catch (e) { return null; }
  } else if (jsonStr && typeof jsonStr === "object") {
    json = jsonStr;
  } else { return null; }
  if (!json || typeof json !== "object") { return null; }

  const fields = [];
  const push = (title, text) => {
    if (text === undefined || text === null || text === "") { return; }
    if (typeof text === "object") { try { text = JSON.stringify(text); } catch (e) { text = String(text); } }
    fields.push({ title: title, text: String(text).trim() });
  };
  const order = ["prompt", "uc", "steps", "sampler", "cfg_rescale", "seed", "width", "height", "request_type", "scale",
    "noise_schedule", "sm", "sm_dyn", "dynamic_thresholding", "controlnet_strength", "add_original_image", "uncond_scale"];
  const used = {};
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(json, key)) { push(key, json[key]); used[key] = 1; }
  }
  for (const key of Object.keys(json)) {
    if (!used[key] && key.indexOf("__") !== 0) { push(key, json[key]); }
  }

  const params = {};
  if (json.steps !== undefined) { params.steps = String(json.steps); }
  if (json.sampler !== undefined) { params.sampler = String(json.sampler); }
  if (json.seed !== undefined) { params.seed = String(json.seed); }
  if (json.scale !== undefined) { params.cfg_scale = String(json.scale); }
  if (json.cfg_rescale !== undefined) { params.cfg_rescale = String(json.cfg_rescale); }
  if (json.width && json.height) { params.size = json.width + "x" + json.height; }
  const modelName = json["Software"] || json["Source"];
  if (modelName) { params.model = String(modelName); }

  // V3：prompt / uc 都是字串。V4/V4.5：prompt 仍是字串，額外的 v4_prompt / v4_negative_prompt 才是 caption 物件。
  let prompt = pickReadable(json.prompt);
  let negative = pickReadable(json.uc) || pickReadable(json.v4_negative_prompt) || pickReadable(json.negative_prompt);
  if (!prompt) { prompt = pickReadable(json.v4_prompt) || pickReadable(json.prompt); }
  if (!negative) { negative = pickReadable(json.uc); }
  const charLines = charCaptionLines(json.v4_prompt) || charCaptionLines(json.prompt);
  if (charLines) { prompt = (prompt ? prompt + "\n" : "") + charLines; }
  return { fields: fields, prompt: prompt.trim(), negative: negative.trim(), params: params, json: json };
}

function looksLikeJsonText(s) {
  const t = String(s || "").trim();
  return t.charAt(0) === "{" || t.charAt(0) === "[";
}
// 只接受「看起來像提示詞」的文字，避免把整段 JSON 當成提示詞顯示
function pickReadable(value) {
  if (value === undefined || value === null || value === "") { return ""; }
  if (typeof value === "object") {
    const inline = inlineCaption(value);
    if (inline) { return inline; }
  }
  const t = extractPromptText(value);
  if (!t || looksLikeJsonText(t)) { return ""; }
  return t.trim();
}
// 物件裡若有 caption.base_caption 就直接用它（不整段 JSON 化）
function inlineCaption(value) {
  if (!value || typeof value !== "object") { return ""; }
  const cap = value.caption !== undefined && value.caption !== null ? value.caption : value;
  if (cap && typeof cap === "object" && typeof cap.base_caption === "string" && cap.base_caption.trim()) {
    return cap.base_caption.trim();
  }
  if (typeof cap === "string" && cap.trim()) { return cap.trim(); }
  return "";
}
function charCaptionLines(value) {
  if (!value || typeof value !== "object") { return ""; }
  const cap = value.caption !== undefined && value.caption !== null ? value.caption : value;
  if (!cap || typeof cap !== "object" || !Array.isArray(cap.char_captions)) { return ""; }
  const lines = [];
  for (const c of cap.char_captions) {
    const t = c && c.char_caption !== undefined ? String(c.char_caption).trim() : "";
    if (!t) { continue; }
    let label = "char";
    if (c && c.centers) { try { label = JSON.stringify(c.centers); } catch (e) { label = "char"; } }
    lines.push("[" + label + "] " + t);
  }
  return lines.join("\n");
}

export function extractPromptText(value) {
  if (value === undefined || value === null) { return ""; }
  if (typeof value === "string") { return value; }
  if (Array.isArray(value)) {
    const parts = [];
    for (const v of value) { const t = extractPromptText(v); if (t) { parts.push(t); } }
    return parts.join(" ");
  }
  if (typeof value === "object") {
    const inline = inlineCaption(value);
    if (inline) {
      let out = inline;
      const chars = charCaptionLines(value);
      if (chars) { out = out + "\n" + chars; }
      return out.trim();
    }
    if (value.base_caption !== undefined) { return extractPromptText(value.base_caption); }
    if (value.char_captions !== undefined) { return charCaptionLines({ caption: value }); }
    try { return JSON.stringify(value); } catch (e) { return ""; }
  }
  return String(value);
}
