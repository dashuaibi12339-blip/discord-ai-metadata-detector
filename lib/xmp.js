// lib/xmp.js —— 從 XMP 文字中抽取常用欄位（含 AI 工具寫入的提示詞）
export function parseXmp(raw) {
  const out = { raw: raw || "", creatorTool: "", description: "", title: "", software: "", subjects: [] };
  if (!raw) { return out; }
  out.creatorTool = firstTag(raw, ["xmp:CreatorTool", "photoshop:Credit", "tiff:Software"]);
  out.description = firstTag(raw, ["dc:description", "photoshop:Instructions", "Iptc4xmpCore:AltTextAccessibility"]);
  out.title = firstTag(raw, ["dc:title"]);
  out.software = firstTag(raw, ["xmp:CreatorTool", "tiff:Software"]);
  const kw = firstTag(raw, ["pdf:Keywords", "dc:subject"]);
  if (kw) { out.subjects = [kw]; }
  return out;
}

function firstTag(raw, names) {
  for (const n of names) {
    const i = raw.indexOf("<" + n);
    if (i === -1) { continue; }
    const gt = raw.indexOf(">", i);
    if (gt === -1) { continue; }
    const inner = raw.slice(gt + 1, raw.indexOf("</" + n, gt) === -1 ? raw.length : raw.indexOf("</" + n, gt));
    const li = inner.indexOf("<rdf:li");
    let text = inner;
    if (li !== -1) {
      const s = inner.indexOf(">", li);
      const e = inner.indexOf("</rdf:li>", s);
      text = inner.slice(s + 1, e === -1 ? inner.length : e);
    }
    text = text.replace(/<[^>]*>/g, "").trim();
    if (text) { return text; }
  }
  return "";
}

// XMP 裡有沒有 AI 提示詞的痕跡
export function xmpHasAiHint(raw) {
  if (!raw) { return false; }
  return raw.indexOf("Steps: ") !== -1 || raw.indexOf("Negative prompt:") !== -1 ||
    raw.indexOf("sui_image_params") !== -1 || raw.indexOf("sd-metadata") !== -1 ||
    raw.indexOf("invokeai_metadata") !== -1 || raw.indexOf("class_type") !== -1 ||
    raw.indexOf("NovelAI") !== -1 || raw.indexOf("parameters") !== -1;
}
