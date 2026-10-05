// lib/classify.js —— 來源判定（novelai / 本地 AI 工具 / 無）
// V4/V4.5：{ caption: { base_caption, char_captions } }
function isV4Caption(value) {
  if (!value || typeof value !== "object") { return false; }
  const cap = value.caption !== undefined && value.caption !== null ? value.caption : value;
  if (!cap || typeof cap !== "object") { return false; }
  if (typeof cap.base_caption === "string" && cap.base_caption.trim()) { return true; }
  if (Array.isArray(cap.char_captions) && cap.char_captions.length > 0) { return true; }
  return false;
}

export function isNovelAiComment(content) {
  if (!content || typeof content !== "string") { return false; }
  const s = content.trim();
  if (s[0] !== "{") { return false; }
  try {
    const j = JSON.parse(s);
    if (j && typeof j === "object") {
      if (typeof j.prompt === "string" && j.prompt.trim()) { return true; }
      if (isV4Caption(j.v4_prompt) || isV4Caption(j.v4_negative_prompt)) { return true; }
      if (typeof j.prompt === "object" && isV4Caption(j.prompt)) { return true; }
      if (typeof j.Comment === "string") {
        try {
          const inner = JSON.parse(j.Comment);
          if (inner && typeof inner.prompt === "string" && inner.prompt.trim()) { return true; }
          if (inner && typeof inner === "object" && isV4Caption(inner.v4_prompt)) { return true; }
        } catch (e) { /* ignore */ }
      }
      if (typeof j.steps !== "undefined" && j.uc !== undefined && (j.v4_prompt !== undefined || typeof j.prompt === "string")) { return true; }
      return false;
    }
  } catch (e) { /* 不是 JSON，退回字串特徵 */ }
  return s.indexOf('"prompt"') !== -1 && s.indexOf('"steps"') !== -1;
}

// 回傳 "novelai" | "comfyui" | "none"
export function detectSource(entries) {
  let hasNovelAiFeature = false;
  let hasComfyUiFeature = false;
  let hasLocalAiFeature = false;

  for (const item of entries || []) {
    const name = item.name || "";
    const rawValue = item.value || "";
    const value = String(rawValue).trim();

    if (name === "Textual Data") {
      const sep = rawValue.indexOf(": ");
      const key = sep === -1 ? rawValue : rawValue.slice(0, sep);
      const content = sep === -1 ? "" : rawValue.slice(sep + 2).trim();
      switch (key) {
        case "Software":
          if (/NovelAI/i.test(content)) { hasNovelAiFeature = true; }
          break;
        case "Source":
          if (/NovelAI/i.test(content) || /novelai\.net/i.test(content)) { hasNovelAiFeature = true; }
          break;
        case "Comment":
          if (isNovelAiComment(content)) { hasNovelAiFeature = true; }
          break;
        case "prompt":
        case "workflow":
        case "generation_data":
        case "ComfyScript":
          hasComfyUiFeature = true;
          break;
        case "parameters":
          if (content.indexOf("Steps: ") !== -1 || content.indexOf('"sui_image_params":') !== -1) { hasLocalAiFeature = true; }
          break;
        case "sd-metadata":
        case "invokeai_metadata":
        case "invokeai_graph":
        case "Dream":
          hasLocalAiFeature = true;
          break;
        default:
          break;
      }
      continue;
    }

    // ComfyUI 的 webp：Make/Model/Image Description 開頭為 prompt:{ 或 workflow:{
    if ((name === "Make" || name === "Model" || name === "Image Description")
      && (value.indexOf("prompt:{") === 0 || value.indexOf("workflow:{") === 0)) {
      hasComfyUiFeature = true;
    }
    // 某些 ComfyUI 資料放在 User Comment
    if (name === "User Comment" && value.indexOf('{"prompt":') === 0 && value.indexOf("class_type") !== -1) {
      hasComfyUiFeature = true;
    }
    // NovelAI：Comment / User Comment 直接是 JSON
    if ((name === "Comment" || name === "User Comment") && isNovelAiComment(value)) { hasNovelAiFeature = true; }
    // A1111 的 jpg/webp
    if ((name === "Comment" || name === "User Comment" || name === "Windows XP Comment" || name === "Image Description")
      && value.indexOf("Steps: ") !== -1
      && (value.indexOf("Size: ") !== -1 || value.indexOf("Samplers: ") !== -1 || value.indexOf("Model: ") !== -1)) {
      hasLocalAiFeature = true;
    }
    // InvokeAI
    if (name === "sd-metadata" || name === "invokeai_metadata" || name === "invokeai_graph" || name === "Dream") {
      hasLocalAiFeature = true;
    }
    // NovelAI 隱寫（由深度檢測注入）
    if (name === "Stealth" && value === "stealth_pngcomp") { hasNovelAiFeature = true; }
  }

  if (hasNovelAiFeature) { return "novelai"; }
  if (hasComfyUiFeature || hasLocalAiFeature) { return "comfyui"; }
  return "none";
}

// 更細的工具標籤（僅用於顯示）
export function detectTool(md) {
  const pngText = (md && md.pngText) || {};
  const exifMap = (md && md.exifMap) || {};
  const join = (obj) => Object.keys(obj).map((k) => k + "=" + obj[k]).join("\n");
  const all = (join(pngText) + "\n" + join(exifMap) + "\n" + ((md && md.xmp) || "")).toLowerCase();

  if (pngText.parameters) {
    const p = pngText.parameters;
    if (p.indexOf("sui_image_params") !== -1) { return "SwarmUI"; }
    if (/Fooocus/i.test(p)) { return "Fooocus"; }
    if (/Forge/i.test(p)) { return "A1111/Forge"; }
    if (/^(Version:\s*)?(f|v)\d/i.test((p.match(/(?:^|\n)Version:\s*[^\n]*/i) || [""])[0].trim())) { return "A1111/Forge"; }
    return "A1111/Stable Diffusion WebUI";
  }
  if (pngText.prompt || pngText.workflow || pngText.ComfyScript || pngText.generation_data) { return "ComfyUI"; }
  if (pngText["sd-metadata"] || pngText.invokeai_metadata || pngText.invokeai_graph || pngText.Dream) { return "InvokeAI"; }
  if (/novelai/i.test(pngText.Software || "") || /novelai/i.test(pngText.Source || "")) { return "NovelAI"; }
  if (pngText.Comment && isNovelAiComment(pngText.Comment)) { return "NovelAI"; }
  if (md && md.stealthNovelAi) { return "NovelAI (隱寫)"; }
  if (all.indexOf("draw things") !== -1) { return "Draw Things"; }
  if (all.indexOf("midjourney") !== -1) { return "Midjourney"; }
  if (all.indexOf("comfyui") !== -1) { return "ComfyUI"; }
  if (all.indexOf("invokeai") !== -1) { return "InvokeAI"; }
  if (all.indexOf("stable diffusion") !== -1 || all.indexOf("a1111") !== -1) { return "A1111/Stable Diffusion WebUI"; }
  if (/^prompt:\{/m.test(join(exifMap)) || /^workflow:\{/m.test(join(exifMap))) { return "ComfyUI"; }
  if (Object.keys(pngText).length > 0) { return "其他文字資料"; }
  if (md && (md.exif || []).length > 0) { return "EXIF(非AI)"; }
  return "";
}
