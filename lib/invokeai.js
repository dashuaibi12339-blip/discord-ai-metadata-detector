// lib/invokeai.js —— InvokeAI 的 sd-metadata / invokeai_metadata / invokeai_graph JSON 解析
export function parseInvokeAi(jsonStr) {
  let json = null;
  if (typeof jsonStr === "string") {
    try { json = JSON.parse(jsonStr); } catch (e) { return null; }
  } else if (jsonStr && typeof jsonStr === "object") { json = jsonStr; }
  else { return null; }
  if (!json || typeof json !== "object") { return null; }

  // 有些檔案會把內容再包一層
  for (const wrap of ["sd-metadata", "invokeai_metadata", "invokeai_graph"]) {
    if (json[wrap] && typeof json[wrap] === "object" && !Array.isArray(json[wrap])) { json = json[wrap]; break; }
  }
  if (json.image && typeof json.image === "object" && !json.images) { json = Object.assign({}, json, { images: [json.image], image: undefined }); }

  const fields = [];
  const push = (title, text) => {
    if (text === undefined || text === null || text === "") { return; }
    if (typeof text === "object") { try { text = JSON.stringify(text); } catch (e) { text = String(text); } }
    fields.push({ title: title, text: String(text).trim() });
  };

  let objImage = null;
  if (typeof json.prompt === "string" && json.prompt.trim()) { json.__promptText = json.prompt; }
  for (const key of Object.keys(json)) {
    const text = json[key];
    if (key === "images" && Array.isArray(text) && text.length > 0) { objImage = text[0]; continue; }
    if (key === "image" && text && typeof text === "object") { objImage = text; continue; }
    if (key === "sd-metadata" || key === "invokeai_metadata" || key === "invokeai_graph") { continue; }
    push(key, text);
  }
  let prompt = typeof json.__promptText === "string" ? json.__promptText : "";
  let negative = typeof json.negative_prompt === "string" ? json.negative_prompt : "";
  const params = {};
  if (prompt) { push("Prompt", prompt); }
  if (negative) { push("Negative prompt", negative); }
  if (objImage && typeof objImage === "object") {
    let p = objImage.prompt;
    if (Array.isArray(p) && p.length > 0 && typeof p[0] === "object") { p = p[0].prompt; }
    push("Prompt", p);
    if (typeof p === "string" && !prompt) { prompt = p; }
    if (objImage.seed !== undefined) { params.seed = String(objImage.seed); }
    if (objImage.steps !== undefined) { params.steps = String(objImage.steps); push("Steps", objImage.steps); }
    if (objImage.cfg_scale !== undefined) { params.cfg_scale = String(objImage.cfg_scale); push("CFG", objImage.cfg_scale); }
    if (objImage.sampler !== undefined) { params.sampler = String(objImage.sampler); push("Sampler", objImage.sampler); }
    if (objImage.width && objImage.height) { params.size = objImage.width + "x" + objImage.height; }
  }
  return { fields: fields, prompt: prompt, negative: negative, params: params, json: json };
}
