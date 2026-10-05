// lib/a1111.js —— Automatic1111 / Forge / Fooocus / SwarmUI 的 parameters 文本解析
export function parseA1111Parameters(val) {
  const fields = [];
  if (!val || typeof val !== "string") { return { fields: fields, prompt: "", negative: "", params: {} }; }
  let v = val;
  if (v.indexOf("Negative prompt:") !== 0 && v.indexOf("Steps:") !== 0) { v = "Prompt: " + v; }

  const parts = parseString(v);
  for (const item of parts) {
    if (item.key === "Steps") {
      const others = parseParameters("Steps: " + item.value);
      for (const o of others) { if (o.title && o.text) { fields.push(o); } }
    } else if (item.value) {
      fields.push({ title: item.key, text: item.value });
    }
  }
  const result = { fields: fields, prompt: "", negative: "", params: {} };
  for (const f of fields) {
    const t = (f.title || "").toLowerCase();
    if (t === "prompt" && !result.prompt) { result.prompt = f.text; }
    else if (t === "negative prompt" && !result.negative) { result.negative = f.text; }
    else {
      const key = t.replace(/\s+/g, "_");
      if (["steps", "sampler", "schedule_type", "scheduler", "cfg_scale", "distilled_cfg_scale", "guidance", "seed", "size", "model", "model_hash", "vae", "vae_hash", "clip_skip", "denoising_strength", "version", "hires_upscale", "hires_steps", "hires_upscaler"].indexOf(key) !== -1) {
        if (result.params[key] === undefined) { result.params[key] = f.text; }
      }
    }
  }
  return result;
}

function parseParameters(input) {
  input = String(input).replace(/\\"/g, "\uFDD9");
  const parts = [];
  const stack = [];
  let partStart = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "[") { stack.push("["); }
    else if (c === "]") { if (stack.length && stack[stack.length - 1] === "[") { stack.pop(); } }
    else if (c === "{") { stack.push("{"); }
    else if (c === "}") { if (stack.length && stack[stack.length - 1] === "{") { stack.pop(); } }
    else if (c === '"') { if (stack.length && stack[stack.length - 1] === '"') { stack.pop(); } else { stack.push('"'); } }
    else if (c === "," && stack.length === 0) { parts.push(input.slice(partStart, i)); partStart = i + 1; }
  }
  parts.push(input.slice(partStart));

  const result = [];
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i].replace(/\uFDD9/g, '\\"').trim();
    const sub = p.split(":");
    const title = sub[0].trim();
    let text = sub.slice(1).join(":").trim();
    if (text.length > 1 && text[0] === '"' && text[text.length - 1] === '"') {
      text = text.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    if (title) { result.push({ title: title, text: text }); }
  }
  return result;
}

function parseString(str) {
  const result = [];
  const keys = ["Prompt", "Negative prompt", "Steps", "\nTemplate", "\nNegative Template"];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const index = str.indexOf(key + ":");
    if (index === -1) { continue; }
    let endIndex = str.length;
    for (let j = i + 1; j < keys.length; j++) {
      const nextIndex = str.indexOf(keys[j] + ":");
      if (nextIndex !== -1) { endIndex = nextIndex; break; }
    }
    result.push({ key: key.replace(/^\n/, ""), value: str.slice(index + key.length + 1, endIndex).trim() });
  }
  return result;
}
