// lib/discord-url.js —— Discord 附件 URL 的正規化與「原圖」候選（與 SW、測試共用）
// Discord 在網頁上顯示的是媒體代理圖（media.discordapp.net，可能被重新編碼成 webp 而丟失 tEXt/EXIF），
// 原圖在 cdn.discordapp.com。兩者用同一組 ex/is/hm 簽名，因此可以互換主機。
const DROP_PARAMS = ["width", "height", "quality", "format", "size", "animated", "passthrough"];

// 固定 base，讓內容腳本與 Service Worker 對同一個 URL 得到完全相同的鍵
const FIXED_BASE = "https://discord.com/";

export function normalizeKey(url) {
  try {
    const u = new URL(url, FIXED_BASE);
    return u.pathname.replace(/^\/+/, "");
  } catch (e) {
    return String(url).split("?")[0];
  }
}

export function fileNameOf(url) {
  const key = normalizeKey(url);
  const parts = key.split("/");
  const n = parts[parts.length - 1] || "image";
  try { return decodeURIComponent(n); } catch (e) { return n; }
}

// 去掉會讓代理重新編碼的縮放參數，其餘（ex/is/hm/backend…）原樣保留
export function originalQuery(rawUrl) {
  try {
    const u = new URL(rawUrl);
    for (const p of DROP_PARAMS) { u.searchParams.delete(p); }
    return u.search;
  } catch (e) {
    return "";
  }
}

export function candidates(rawUrl) {
  const out = [];
  let u;
  try { u = new URL(rawUrl); } catch (e) { return [rawUrl]; }
  const qs = originalQuery(rawUrl);
  const path = u.pathname;
  const proto = u.protocol + "//";
  const isMedia = u.hostname === "media.discordapp.net" || u.hostname === "media.discordapp.com";
  const isCdn = u.hostname === "cdn.discordapp.com";
  if (isMedia) {
    out.push(proto + "cdn.discordapp.com" + path + qs);
    out.push(proto + u.hostname + path + qs);
  } else if (isCdn) {
    out.push(proto + u.hostname + path + qs);
    out.push(proto + "media.discordapp.net" + path + qs);
  } else {
    // 非 Discord 主機（例如設定頁拿來測的一般圖片網址）：只去掉縮放參數，不動主機與協定
    out.push(proto + u.host + path + qs);
  }
  out.push(rawUrl);
  const seen = {};
  return out.filter(function (v) { if (!v || seen[v]) { return false; } seen[v] = 1; return true; });
}
