"use strict";
var FIELDS = ["enabled", "autoScan", "stealthScan", "autoScanLimit", "concurrency", "minGapMs", "showBadge", "pendingBadge", "fabHidden", "badgeMode", "dimNoMeta", "keyword", "sourceFilter", "cacheLimit", "tailScan", "smallFullBytes", "pageBudgetMB"];
function $(id) { return document.getElementById(id); }
function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (resp) {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp || null);
    });
  });
}
function fmtBytes(n) { if (!n) { return "0 B"; } if (n < 1024) { return n + " B"; } if (n < 1048576) { return (n / 1024).toFixed(1) + " KB"; } return (n / 1048576).toFixed(2) + " MB"; }

async function load() {
  var resp = await send({ type: "getSettings" });
  if (!resp || !resp.ok) { return; }
  var s = resp.settings;
  $("enabled").checked = s.enabled !== false;
  $("autoScan").checked = !!s.autoScan;
  $("stealthScan").value = s.stealthScan || "off";
  $("autoScanLimit").value = s.autoScanLimit;
  $("concurrency").value = s.concurrency;
  $("minGapMs").value = s.minGapMs;
  $("headKB").value = Math.round((s.headBytes || 262144) / 1024);
  $("maxFullMB").value = Math.round((s.maxFullBytes || 8388608) / 1048576);
  $("smallFullKB").value = Math.round((s.smallFullBytes || 262144) / 1024);
  $("pageBudgetMB").value = s.pageBudgetMB || 30;
  $("tailScan").checked = !!s.tailScan;
  $("showBadge").checked = !!s.showBadge;
  $("fabHidden").checked = !!s.fabHidden;
  $("pendingBadge").checked = !!s.pendingBadge;
  $("badgeAll").checked = (s.badgeMode || "ai") === "all";
  $("dimNoMeta").checked = !!s.dimNoMeta;
  $("keyword").value = s.keyword || "";
  $("sourceFilter").value = s.sourceFilter || "all";
  $("cacheLimit").value = s.cacheLimit;
  await refreshStats();
}
async function refreshStats() {
  var st = await send({ type: "stats" });
  if (st && st.ok) {
    $("cacheStat").textContent = "缓存 " + st.stats.cached + " 条 · 有 AI 提示词 " + st.stats.withMeta + "（NovelAI " + st.stats.novelai + " / 本地 " + st.stats.comfyui + "）· 非AI元数据 " + st.stats.other + " · 失败 " + st.stats.errors;
  }
}
function collect() {
  var patch = {};
  patch.enabled = $("enabled").checked;
  patch.autoScan = $("autoScan").checked;
  patch.stealthScan = $("stealthScan").value;
  patch.autoScanLimit = parseInt($("autoScanLimit").value, 10) || 60;
  patch.concurrency = Math.max(1, Math.min(8, parseInt($("concurrency").value, 10) || 3));
  patch.minGapMs = Math.max(0, Math.min(5000, parseInt($("minGapMs").value, 10) || 0));
  patch.headBytes = Math.max(16384, (parseInt($("headKB").value, 10) || 256) * 1024);
  patch.maxFullBytes = Math.max(1048576, (parseInt($("maxFullMB").value, 10) || 8) * 1048576);
  patch.smallFullBytes = Math.max(0, (parseInt($("smallFullKB").value, 10) || 0) * 1024);
  patch.pageBudgetMB = Math.max(1, parseInt($("pageBudgetMB").value, 10) || 30);
  patch.tailScan = $("tailScan").checked;
  patch.showBadge = $("showBadge").checked;
  patch.fabHidden = $("fabHidden").checked;
  patch.pendingBadge = $("pendingBadge").checked;
  patch.badgeMode = $("badgeAll").checked ? "all" : "ai";
  patch.dimNoMeta = $("dimNoMeta").checked;
  patch.keyword = $("keyword").value;
  patch.sourceFilter = $("sourceFilter").value;
  patch.cacheLimit = Math.max(100, parseInt($("cacheLimit").value, 10) || 4000);
  return patch;
}

document.addEventListener("DOMContentLoaded", function () {
  load();
  $("save").addEventListener("click", async function () {
    await send({ type: "setSettings", patch: collect() });
    $("saveMsg").textContent = "已保存（Discord 页面会立即生效）";
    setTimeout(function () { $("saveMsg").textContent = ""; }, 2500);
  });
  $("testBtn").addEventListener("click", async function () {
    var url = $("testUrl").value.trim();
    if (!url) { $("testOut").textContent = "请输入图片直链"; return; }
    $("testOut").textContent = "检测中…（会实际下载图片位元组）";
    var resp = await send({ type: "testUrl", url: url, deep: $("testDeep").checked });
    if (!resp || !resp.ok) { $("testOut").textContent = "失败：" + ((resp && resp.error) || "未知错误"); return; }
    var r = resp.result;
    var lines = [];
    lines.push("状态：" + r.status + "   来源：" + (r.source || "-") + "   工具：" + (r.tool || "-"));
    lines.push("格式：" + r.format + "  尺寸：" + (r.width || "?") + "x" + (r.height || "?") + "  读取：" + fmtBytes(r.bytes) + (r.truncated ? "（已截断）" : ""));
    if (r.paramsString) { lines.push("参数：" + r.paramsString); }
    if (r.error) { lines.push("错误：" + r.error); }
    if (r.notes && r.notes.length) { lines.push("备注：" + r.notes.join("；")); }
    if (r.prompt) { lines.push("", "正向提示词：", r.prompt); }
    if (r.negative) { lines.push("", "负面提示词：", r.negative); }
    if (!r.prompt && !r.error) { lines.push("", "没有解析到提示词。"); }
    $("testOut").textContent = lines.join("\n");
    refreshStats();
  });
  function downloadText(text, filename, mime) {
    try {
      var blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename || "export.txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
      return true;
    } catch (e) {
      send({ type: "download", text: text, filename: filename, mime: mime });
      return false;
    }
  }
  $("exportCsv").addEventListener("click", async function () {
    var resp = await send({ type: "export", format: "csv" });
    if (resp && resp.ok) { downloadText(resp.text, resp.filename, resp.mime); }
  });
  $("exportJson").addEventListener("click", async function () {
    var resp = await send({ type: "export", format: "json" });
    if (resp && resp.ok) { downloadText(resp.text, resp.filename, resp.mime); }
  });
  $("clearCache").addEventListener("click", async function () {
    await send({ type: "clearCache" });
    await refreshStats();
    $("saveMsg").textContent = "缓存已清空";
  });
});
