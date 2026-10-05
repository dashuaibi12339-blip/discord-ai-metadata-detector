// lib/comfyui.js —— ComfyUI 的 prompt(API 格式) / workflow(UI 格式) 解析
const TEXT_KEYS = ["text", "prompt", "string", "positive", "negative", "text_g", "text_l", "t5xxl",
  "populated_text", "text_positive", "text_negative", "n_prompt", "text_enc", "any", "value",
  "caption", "wildcard_text", "base_ctx", "positive_prompt", "negative_prompt", "wildcard"];

export function parseComfyWorkflow(promptJson, workflowJson) {
  const out = { fields: [], prompt: "", negative: "", params: {}, nodes: 0, kind: "" };
  let promptObj = null;
  if (typeof promptJson === "string") {
    try { promptObj = JSON.parse(fixJson(promptJson)); } catch (e) { promptObj = null; }
  } else if (promptJson && typeof promptJson === "object") { promptObj = promptJson; }

  if (promptObj && typeof promptObj === "object" && !Array.isArray(promptObj)) {
    const nodes = promptObj;
    const ids = Object.keys(nodes);
    out.nodes = ids.length;
    if (ids.length > 0 && nodes[ids[0]] && typeof nodes[ids[0]] === "object" && nodes[ids[0]].class_type) {
      out.kind = "prompt";
      resolveFromApiGraph(out, nodes);
    }
  }
  if (!out.prompt && workflowJson) {
    let wf = null;
    if (typeof workflowJson === "string") { try { wf = JSON.parse(fixJson(workflowJson)); } catch (e) { wf = null; } }
    else if (workflowJson && typeof workflowJson === "object") { wf = workflowJson; }
    if (wf && Array.isArray(wf.nodes)) {
      out.kind = out.kind || "workflow";
      resolveFromUiWorkflow(out, wf);
    }
  }
  if (!out.prompt && !out.negative && out.fields.length === 0) { return null; }
  return out;
}

function fixJson(s) { return String(s).replace(/":\s*NaN/g, '": null').replace(/":\s*\[NaN/g, '": [null'); }

function resolveFromApiGraph(out, nodes) {
  const ids = Object.keys(nodes);
  const isSampler = (n) => {
    const ct = String((n && n.class_type) || "");
    if (/KSampler|SamplerCustom|Sampler\b|KSamplerAdvanced|SamplerCustomAdvanced|SamplerEfficient|SampleSettings/i.test(ct)) { return true; }
    const inp = (n && n.inputs) || {};
    return inp.steps !== undefined && (inp.cfg !== undefined || inp.seed !== undefined || inp.noise_seed !== undefined) && (inp.positive !== undefined || inp.model !== undefined);
  };
  let sampler = null;
  for (const id of ids) { if (nodes[id] && isSampler(nodes[id])) { sampler = nodes[id]; break; } }

  let prompt = "", negative = "";
  if (sampler && sampler.inputs) {
    if (sampler.inputs.positive !== undefined) { prompt = collectText(sampler.inputs.positive, nodes, 0, {}); }
    if (sampler.inputs.negative !== undefined) { negative = collectText(sampler.inputs.negative, nodes, 0, {}); }
    if (!prompt && sampler.inputs.sdxl_tuple !== undefined) { prompt = collectText(sampler.inputs.sdxl_tuple, nodes, 0, {}); }
    if (!negative && sampler.inputs.sdxl_tuple !== undefined) { negative = collectText(sampler.inputs.sdxl_tuple, nodes, 0, {}); }
  }

  // 找不到就退而求其次：掃描所有文字節點
  if (!prompt) {
    const texts = [];
    for (const id of ids) {
      const n = nodes[id];
      if (!n || !n.inputs) { continue; }
      const ct = String(n.class_type || "");
      if (!/CLIPTextEncode|TextEncode|Prompt|Text\b|String|Textbox/i.test(ct)) { continue; }
      const t = directText(n.inputs);
      if (t) { texts.push(t); }
    }
    if (texts.length > 0) { prompt = texts[0]; if (!negative && texts.length > 1) { negative = texts[1]; } }
  }

  const params = {};
  const samplerNode = sampler || findFirst(nodes, (n) => n.inputs && (n.inputs.steps !== undefined || n.inputs.cfg !== undefined));
  if (samplerNode && samplerNode.inputs) {
    const i = samplerNode.inputs;
    if (i.steps !== undefined) { params.steps = String(i.steps); }
    if (i.cfg !== undefined) { params.cfg_scale = String(i.cfg); }
    if (i.guidance !== undefined) { params.guidance = String(i.guidance); }
    if (i.sampler_name !== undefined) { params.sampler = String(i.sampler_name); }
    if (i.scheduler !== undefined) { params.scheduler = String(i.scheduler); }
    if (i.denoise !== undefined) { params.denoising_strength = String(i.denoise); }
    if (i.seed !== undefined) { params.seed = String(i.seed); }
    else if (i.noise_seed !== undefined) { params.seed = String(i.noise_seed); }
  }
  const ckpt = findFirst(nodes, (n) => n.class_type === "CheckpointLoaderSimple" || n.class_type === "CheckpointLoader" || /CheckpointLoader/i.test(String(n.class_type || "")));
  if (ckpt && ckpt.inputs && ckpt.inputs.ckpt_name) { params.model = String(ckpt.inputs.ckpt_name); }
  else {
    const unet = findFirst(nodes, (n) => n.inputs && n.inputs.unet_name);
    if (unet) { params.model = String(unet.inputs.unet_name); }
  }
  const vae = findFirst(nodes, (n) => n.inputs && (n.inputs.vae_name || n.inputs.vae));
  if (vae && vae.inputs && (vae.inputs.vae_name || typeof vae.inputs.vae === "string")) { params.vae = String(vae.inputs.vae_name || vae.inputs.vae); }

  // LoRA / 自訂節點摘要
  const extras = [];
  for (const id of ids) {
    const n = nodes[id];
    if (!n || !n.inputs) { continue; }
    const ct = String(n.class_type || "");
    if (/LoraLoader|LoRA/i.test(ct)) {
      const nm = n.inputs.lora_name || n.inputs.lora;
      if (nm) { extras.push(String(nm)); }
    }
  }
  if (extras.length) { params.loras = extras.join(", "); }

  for (const [k, v] of Object.entries(params)) {
    const title = k === "cfg_scale" ? "CFG" : k === "denoising_strength" ? "Denoise" : k === "model" ? "Model" : k === "loras" ? "LoRA" : k.charAt(0).toUpperCase() + k.slice(1);
    out.fields.push({ title: title, text: v });
  }
  if (prompt) { out.prompt = prompt; out.fields.unshift({ title: "Prompt", text: prompt }); }
  if (negative) { out.negative = negative; out.fields.splice(prompt ? 1 : 0, 0, { title: "Negative prompt", text: negative }); }
  out.params = params;
}

function findFirst(nodes, pred) {
  for (const id of Object.keys(nodes)) { const n = nodes[id]; if (n && typeof n === "object" && pred(n)) { return n; } }
  return null;
}

function directText(inputs) {
  let best = "";
  for (const k of Object.keys(inputs || {})) {
    const v = inputs[k];
    if (typeof v === "string" && v.trim() && TEXT_KEYS.indexOf(k) !== -1 && v.length > best.length) { best = v; }
  }
  return best;
}

// 依 link 遞迴收集文字；[nodeId, outputIndex]
function collectText(ref, nodes, depth, seen) {
  if (depth > 12) { return ""; }
  if (typeof ref === "string") { return ref.trim(); }
  if (Array.isArray(ref) && ref.length >= 1) {
    const id = String(ref[0]);
    if (seen[id]) { return ""; }
    const node = nodes[id];
    if (!node) { return ""; }
    seen[id] = 1;
    const inputs = node.inputs || {};
    const direct = directText(inputs);
    if (direct) { return direct; }
    const parts = [];
    for (const k of Object.keys(inputs)) {
      const v = inputs[k];
      if (Array.isArray(v) && typeof v[0] === "string" && nodes[v[0]]) {
        const t = collectText(v, nodes, depth + 1, Object.assign({}, seen));
        if (t) { parts.push(t); }
      }
    }
    if (parts.length) { return parts.join(" + "); }
    return "";
  }
  return "";
}

function resolveFromUiWorkflow(out, wf) {
  const texts = [];
  const nodes = wf.nodes || [];
  for (const n of nodes) {
    const type = String(n.type || n.class_type || "");
    const wv = n.widgets_values;
    if (type.indexOf("CLIPTextEncode") !== -1 && Array.isArray(wv) && typeof wv[0] === "string") { texts.push({ t: type, text: wv[0] }); }
    else if (Array.isArray(wv)) {
      for (const v of wv) { if (typeof v === "string" && v.length > 8 && /\s|,/.test(v) && /Text|Prompt|String/i.test(type)) { texts.push({ t: type, text: v }); break; } }
    }
  }
  const positive = texts.find((x) => x.t.indexOf("CLIPTextEncode") !== -1);
  const positiveText = positive ? positive.text : (texts[0] ? texts[0].text : "");
  const negCandidate = texts.filter((x) => x.text !== positiveText && x.t.indexOf("CLIPTextEncode") !== -1);
  const negative = negCandidate.length ? negCandidate[negCandidate.length - 1].text : "";
  if (positiveText) { out.prompt = positiveText; out.fields.push({ title: "Prompt", text: positiveText }); }
  if (negative) { out.negative = negative; out.fields.push({ title: "Negative prompt", text: negative }); }
  for (const n of nodes) {
    const type = String(n.type || "");
    if (/KSampler/i.test(type) && Array.isArray(n.widgets_values)) {
      const wv = n.widgets_values;
      const names = ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"];
      for (let i = 0; i < Math.min(wv.length, names.length); i++) {
        if (wv[i] === undefined || wv[i] === null) { continue; }
        out.params[names[i]] = String(wv[i]);
      }
      break;
    }
  }
}
