// test/gen-fixtures.mjs —— 產生合成測試檔（不依賴任何外部套件）
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const fixtureDir = path.join(__dirname, "fixtures");

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) { c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ -1) >>> 0;
}

function u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u16be(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }

export function pngChunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const body = Buffer.concat([t, Buffer.from(data)]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
}

export function textChunk(key, text) {
  return pngChunk("tEXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]));
}
export function itxtChunk(key, text) {
  return pngChunk("iTXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0, 0, 0]), Buffer.from([0]), Buffer.from([0]), Buffer.from(text, "utf8")]));
}
export function ztxtChunk(key, text) {
  return pngChunk("zTXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(text, "utf8"))]));
}

// 產生 IDAT 之後才放中繼資料的 PNG（部分工具會這樣寫），並可指定 IDAT 大小
export function buildPngWithPostChunks(postChunks, idatBytes) {
  const w = 2, h = 2;
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 2, 0, 0, 0])]);
  const idat = idatBytes ? idatBytes : zlib.deflateSync(Buffer.concat([Buffer.alloc(1 + 2 * 3), Buffer.alloc(1 + 2 * 3)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    ...postChunks,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function buildPng(extraChunks, width, height, alphaRaw) {
  const w = width || 2, h = height || 2;
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, alphaRaw ? 6 : 2, 0, 0, 0])]);
  // 全 0 像素 + filter byte 0
  const channels = alphaRaw ? 4 : 3;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * channels);
    if (alphaRaw) { alphaRaw.copy(row, 1, y * w * 4, (y + 1) * w * 4); }
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...extraChunks,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- TIFF / EXIF builder ----
const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };
// entries -> IFD0；exifEntries -> Exif SubIFD（真實相機/工具都把 UserComment 放這裡）
export function buildTiff(entries, exifEntries) {
  const hasExif = Array.isArray(exifEntries) && exifEntries.length > 0;
  const n0 = entries.length + (hasExif ? 1 : 0);
  const ifd0Size = 2 + n0 * 12 + 4;
  const ifd1Size = hasExif ? 2 + exifEntries.length * 12 + 4 : 0;
  const headerSize = 8;
  const ifd1Offset = headerSize + ifd0Size;
  let dataOffset = headerSize + ifd0Size + ifd1Size;
  const dataParts = [];
  const layout = (list) => list.map((e) => {
    const buf = e.value;
    const size = (TYPE_BYTES[e.type] || 1) * (e.count || buf.length);
    if (size <= 4) {
      const inline = Buffer.alloc(4);
      buf.copy(inline, 0);
      return { tag: e.tag, type: e.type, count: e.count || buf.length, valueField: inline };
    }
    const valField = u32le(dataOffset);
    dataParts.push(buf);
    if (buf.length % 2 === 1) { dataParts.push(Buffer.alloc(1)); dataOffset += 1; }
    dataOffset += buf.length;
    return { tag: e.tag, type: e.type, count: e.count || buf.length, valueField: valField };
  });
  const ifd0 = layout(entries);
  if (hasExif) { ifd0.push({ tag: 0x8769, type: 4, count: 1, valueField: u32le(ifd1Offset) }); }
  const ifd1 = hasExif ? layout(exifEntries) : [];
  const serialize = (list, nextOffset) => {
    const parts = [u16le(list.length)];
    for (const e of list) { parts.push(u16le(e.tag), u16le(e.type), u32le(e.count), e.valueField); }
    parts.push(u32le(nextOffset));
    return Buffer.concat(parts);
  };
  const parts = [Buffer.from("II", "latin1"), u16le(0x2a), u32le(headerSize)];
  parts.push(serialize(ifd0, hasExif ? 0 : 0));
  if (hasExif) { parts.push(serialize(ifd1, 0)); }
  return Buffer.concat([...parts, ...dataParts]);
}

function asciiVal(s) { return Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]); }
function userCommentVal(s) { return Buffer.concat([Buffer.from("ASCII\0\0\0", "latin1"), Buffer.from(s, "utf8")]); }
function xpVal(s) {
  const b = Buffer.alloc(s.length * 2 + 2);
  for (let i = 0; i < s.length; i++) { b.writeUInt16LE(s.charCodeAt(i), i * 2); }
  return b;
}

export function buildJpeg(tiffBytes, comment) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (tiffBytes) {
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffBytes]);
    parts.push(Buffer.from([0xff, 0xe1]), u16be(payload.length + 2), payload);
  }
  if (comment) {
    const c = Buffer.from(comment, "utf8");
    parts.push(Buffer.from([0xff, 0xfe]), u16be(c.length + 2), c);
  }
  // 最小 SOF0，讓解析器能拿到尺寸
  const sof = Buffer.concat([Buffer.from([8]), u16be(2), u16be(2), Buffer.from([1, 1, 0x11, 0])]);
  parts.push(Buffer.from([0xff, 0xc0]), u16be(sof.length + 2), sof);
  parts.push(Buffer.from([0xff, 0xda]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

export function buildWebp(exifTiff, xmp) {
  const chunks = [];
  const vp8x = Buffer.concat([Buffer.from([0x00, 0, 0, 0]), Buffer.from([1, 0, 0]), Buffer.from([1, 0, 0])]);
  chunks.push(Buffer.from("VP8X", "latin1"), u32le(vp8x.length), vp8x);
  if (exifTiff) { chunks.push(Buffer.from("EXIF", "latin1"), u32le(exifTiff.length), exifTiff); if (exifTiff.length % 2) { chunks.push(Buffer.alloc(1)); } }
  if (xmp) { const x = Buffer.from(xmp, "utf8"); chunks.push(Buffer.from("XMP ", "latin1"), u32le(x.length), x); if (x.length % 2) { chunks.push(Buffer.alloc(1)); } }
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(body.length), body]);
}

// ---- 各工具的實際中繼資料字串 ----
export const A1111_PARAMETERS = "masterpiece, best quality, 1girl, blue archive, solo\nNegative prompt: lowres, bad anatomy, worst quality\nSteps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234567890, Size: 832x1216, Model hash: 6ce0161689, Model: anything-v5, Denoising strength: 0.5, Clip skip: 2, Hires upscale: 2, Hires upscaler: R-ESRGAN 4x+ Anime6B";

export const NAI_COMMENT = JSON.stringify({
  prompt: "1girl, solo, blue archive, masterpiece, best quality",
  uc: "lowres, bad anatomy, bad hands",
  steps: 28, sampler: "k_euler_ancestral", scale: 5.5, seed: 987654321,
  width: 832, height: 1216, cfg_rescale: 0, noise_schedule: "karras",
  Software: "NovelAI", Source: "Stable Diffusion XL C1E... / novelai.net",
});

export const COMFY_PROMPT = JSON.stringify({
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "a cute cat, masterpiece", clip: ["1", 1] } },
  "3": { class_type: "CLIPTextEncode", inputs: { text: "bad quality, worst quality", clip: ["1", 1] } },
  "4": { class_type: "KSampler", inputs: { seed: 123456, steps: 25, cfg: 7.0, sampler_name: "euler", scheduler: "normal", denoise: 1.0, model: ["1", 0], positive: ["2", 0], negative: ["3", 0] } },
  "5": { class_type: "VAEDecode", inputs: { samples: ["4", 0], vae: ["1", 2] } },
  "6": { class_type: "LoraLoader", inputs: { lora_name: "add_detail.safetensors", strength_model: 0.8, model: ["1", 0], clip: ["1", 1] } },
});

export const COMFY_WORKFLOW = JSON.stringify({
  nodes: [
    { id: 2, type: "CLIPTextEncode", widgets_values: ["a cute cat, masterpiece"] },
    { id: 3, type: "CLIPTextEncode", widgets_values: ["bad quality, worst quality"] },
    { id: 4, type: "KSampler", widgets_values: [123456, "randomize", 25, 7.0, "euler", "normal", 1.0] },
  ],
});

export const INVOKE_META = JSON.stringify({
  "sd-metadata": { model: "stable-diffusion-1.5", image: { prompt: [{ prompt: "a dragon, fantasy art", weight: 1 }], seed: 42, steps: 30, cfg_scale: 7.5, sampler: "k_lms", width: 512, height: 512 } },
});

export const NAI_V4_COMMENT = JSON.stringify({
  prompt: "2.0::year 2026, 1girl, masterpiece, best quality",
  uc: "lowres, bad quality, worst quality",
  v4_prompt: { caption: { base_caption: "2.0::year 2026, 1girl, masterpiece, best quality", char_captions: [{ char_caption: "blue_archive, halo", centers: [{ x: 0.4, y: 0.3 }] }] }, use_coords: false, use_order: true },
  v4_negative_prompt: { caption: { base_caption: "lowres, bad quality, worst quality" } },
  steps: 28, sampler: "k_euler_ancestral", scale: 5, seed: 1234567890, width: 832, height: 1216, cfg_rescale: 0,
});

// 超大 tEXt（500KB）+ 大 IDAT（2MB）：用來驗證「精準補抓」
export function buildPngBigText(textPad, idatSize) {
  const ihdr = Buffer.concat([u32be(2), u32be(2), Buffer.from([8, 2, 0, 0, 0])]);
  const pad = "pad,".repeat(Math.ceil((textPad || 500000) / 4));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    textChunk("parameters", A1111_PARAMETERS + " " + pad),
    pngChunk("IDAT", Buffer.alloc(idatSize || 2097152, 7)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// 產生「alpha 通道 LSB 隱寫」的 PNG（逐欄排布：bit k -> 欄 floor(k/rows)、列 k%rows）
export function buildStealthPng(width, height, payloadText) {
  const comp = zlib.gzipSync(Buffer.from(payloadText, "utf8"));
  const magic = Buffer.from("stealth_pngcomp", "latin1");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(comp.length * 8, 0);
  const all = Buffer.concat([magic, lenBuf, comp]);
  const bits = [];
  for (const byte of all) { for (let b = 7; b >= 0; b--) { bits.push((byte >> b) & 1); } }
  const R = Math.min(height, bits.length);
  const alpha = new Uint8Array(width * height).fill(255);
  for (let k = 0; k < bits.length; k++) {
    const x = Math.floor(k / R), y = k % R;
    if (x >= width || y >= height) { break; }
    alpha[y * width + x] = (alpha[y * width + x] & 0xfe) | bits[k];
  }
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const off = 1 + x * 4;
      row[off] = 200; row[off + 1] = 180; row[off + 2] = 160; row[off + 3] = alpha[y * width + x];
    }
    rows.push(row);
  }
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// 隨機 RGB、alpha 全 255 的 RGBA PNG（不可壓縮，用來驗證隱寫預檢真的省下整份下載）
export function buildPngRandomRgba(width, height) {
  const rows = [];
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const off = 1 + x * 4;
      row[off] = seed & 0xff;
      row[off + 1] = (seed >> 8) & 0xff;
      row[off + 2] = (seed >> 16) & 0xff;
      row[off + 3] = 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writeFixtures() {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const out = {};
  const write = (name, buf) => { fs.writeFileSync(path.join(fixtureDir, name), buf); out[name] = buf; };

  // 1) A1111 PNG
  write("a1111.png", buildPng([textChunk("parameters", A1111_PARAMETERS), textChunk("Software", "AUTOMATIC1111")]));
  // 2) NovelAI PNG
  write("novelai.png", buildPng([textChunk("Software", "NovelAI"), textChunk("Source", "Stable Diffusion XL C1E... / novelai.net"), textChunk("Comment", NAI_COMMENT), textChunk("Description", "1girl, solo, blue archive, masterpiece, best quality")]));
  // 3) ComfyUI PNG（prompt 用 zTXt、workflow 用 iTXt）
  write("comfyui.png", buildPng([ztxtChunk("prompt", COMFY_PROMPT), itxtChunk("workflow", COMFY_WORKFLOW)]));
  // 4) InvokeAI PNG
  write("invokeai.png", buildPng([textChunk("sd-metadata", INVOKE_META)]));
  // 4b) NovelAI V4.5（prompt 是 caption 物件）
  write("novelai-v4.png", buildPng([textChunk("Software", "NovelAI"), textChunk("Source", "novelai.net"), textChunk("Comment", NAI_V4_COMMENT)]));
  // 5) 純 PNG（無中繼資料）
  write("plain.png", buildPng([]));
  // 6) 一般相機 EXIF（非 AI）
  write("camera.jpg", buildJpeg(buildTiff([
    { tag: 0x010e, type: 2, value: asciiVal("My holiday photo") },
    { tag: 0x010f, type: 2, value: asciiVal("Canon") },
    { tag: 0x0110, type: 2, value: asciiVal("EOS R6") },
  ])));
  // 7) JPEG 內含 A1111 參數（UserComment）
  write("a1111.jpg", buildJpeg(buildTiff(
    [{ tag: 0x010f, type: 2, value: asciiVal("stable diffusion") }],
    [
      { tag: 0x9286, type: 7, value: userCommentVal("Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 555, Size: 512x512, Model: anything-v5, Model hash: 1234ab, Negative prompt: lowres, Prompt: 1girl, masterpiece") },
      { tag: 0x9c9c, type: 1, value: xpVal("XP comment text") },
    ])));
  // 8) WebP：ComfyUI 把 prompt 寫在 EXIF Make
  write("comfyui.webp", buildWebp(buildTiff([
    { tag: 0x010f, type: 2, value: asciiVal("prompt:" + COMFY_PROMPT) },
    { tag: 0x0110, type: 2, value: asciiVal("workflow:" + COMFY_WORKFLOW) },
  ])));
  // 7b) 大 PNG：tEXt 寫在 IDAT 之後（測尾段 CRC 掃描）—— IDAT 用不可壓縮資料撐到 ~2MB
  {
    const big = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) { big[i] = (i * 2654435761) & 0xff; }
    write("post-text.png", buildPngWithPostChunks([textChunk("parameters", A1111_PARAMETERS)], big));
  }
  // 7d) 帶 alpha 隱寫的 PNG（逐欄排布 + NovelAI 包裝結構）
  write("stealth.png", buildStealthPng(512, 768, JSON.stringify({
    Description: "masterpiece, best quality, blue archive, 1girl",
    Software: "NovelAI",
    Source: "novelai.net",
    "Generation time": "1.2s",
    Comment: NAI_COMMENT,
  })));
  // 7e) 沒有 alpha 通道的普通 PNG（預檢應直接判定不可能有隱寫）
  write("rgb-plain.png", buildPng([]));
  // 7f) 大且不可壓縮的 RGBA PNG（無隱寫）：預檢只應讀前面一小段
  write("big-rgba-plain.png", buildPngRandomRgba(400, 400));
  // 7c) 超大 tEXt（首段一定被切斷，需精準補抓）
  write("bigtext.png", buildPngBigText(500000, 2097152));
  // 8b) Discord 重新編碼過的 JPEG（EXIF 帶 Discord 媒體服務標記）
  write("discord-reencoded.jpg", buildJpeg(buildTiff([
    { tag: 0x010e, type: 2, value: asciiVal("uid:1234567890") },
    { tag: 0x0131, type: 2, value: asciiVal("Optimized for web") },
  ])));
  // 9) 無中繼資料的 WebP
  write("plain.webp", buildWebp(null, null));
  // 10) 帶 XMP 的 WebP（Draw Things 風格）
  write("xmp.webp", buildWebp(null, '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Draw Things" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">Steps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 1, Size: 512x512</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>'));
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("gen-fixtures.mjs")) {
  const out = writeFixtures();
  console.log("已產生檔案：");
  for (const k of Object.keys(out)) { console.log("  " + k + "  " + out[k].length + " bytes"); }
}
