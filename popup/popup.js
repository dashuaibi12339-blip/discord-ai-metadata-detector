"use strict";
var DEFAULTS = { enabled: true, autoScan: true, stealthScan: "off", showBadge: true, dimNoMeta: false, fabHidden: false };
var STEALTH_HINT = {
  off: "off：完全不自动检测隐写。只有你点图上的「隐写检测」按钮、右键菜单或面板批量按钮时才做——不花额外流量。",
  auto: "auto：只对「扫完首段完全没有文字元数据」的 PNG（本来会标成无提示词的那些）自动预检。没 alpha 通道 0 额外字节；预检不中即停；只有命中才下载整份。",
  always: "always：每张 PNG 都预检，连已经有文字元数据的也查（基本没必要，最费流量）。"
};
var settings = Object.assign({}, DEFAULTS);
var tabId = null;

function $(id) { return document.getElementById(id); }
function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (resp) {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp || null);
    });
  });
}
function sendTab(msg) {
  return new Promise(function (resolve) {
    if (tabId === null) { resolve(null); return; }
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp || null);
    });
  });
}

async function init() {
  var st = await send({ type: "getSettings" });
  if (st && st.ok) { settings = Object.assign({}, DEFAULTS, st.settings); }
  $("tEnabled").checked = settings.enabled !== false;
  $("tAuto").checked = !!settings.autoScan;
  $("tDim").checked = !!settings.dimNoMeta;
  $("tBadge").checked = !!settings.showBadge;
  $("tFab").checked = !!settings.fabHidden;
  $("selStealth").value = settings.stealthScan || "off";
  $("stealthHint").textContent = STEALTH_HINT[settings.stealthScan || "off"] || "";

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (tab) { tabId = tab.id; }
  var isDiscord = tab && /^https:\/\/(ptb\.|canary\.)?discord\.com\//.test(tab.url || "");
  if (!isDiscord) {
    $("pageInfo").textContent = "当前不是 Discord 网页版（请打开 discord.com 的频道页）";
  } else {
    var ps = await sendTab({ type: "getPageStats" });
    if (ps && ps.ok) {
      $("pageInfo").textContent = "已加载图片 " + ps.stats.images + " 张 · 已检测 " + ps.stats.scanned;
      $("sAI").textContent = String(ps.stats.ai);
      $("sNAI").textContent = String(ps.stats.novelai);
      $("sLocal").textContent = String(ps.stats.comfyui);
      $("sNone").textContent = String(ps.stats.none);
    } else {
      $("pageInfo").textContent = "页面尚未就绪，刷新 Discord 页面后重试";
    }
  }
  var stats = await send({ type: "stats" });
  if (stats && stats.ok) {
    var ver = "";
    try { ver = chrome.runtime.getManifest().version; } catch (e) { ver = ""; }
    $("cacheInfo").textContent = (ver ? "v" + ver + " · " : "") + "缓存 " + stats.stats.cached + " 条 · 有提示词 " + stats.stats.withMeta + " 条";
  }
}

function setSetting(patch) {
  return send({ type: "setSettings", patch: patch });
}

document.addEventListener("DOMContentLoaded", function () {
  init();
  $("tEnabled").addEventListener("change", async function (e) {
    await setSetting({ enabled: e.target.checked });
    $("pageInfo").textContent = e.target.checked ? "已恢复检测" : "已停止识别（不再检测、不再发请求）";
  });
  $("tAuto").addEventListener("change", function (e) { setSetting({ autoScan: e.target.checked }); });
  $("tDim").addEventListener("change", function (e) { setSetting({ dimNoMeta: e.target.checked }); });
  $("tBadge").addEventListener("change", function (e) { setSetting({ showBadge: e.target.checked }); });
  $("tFab").addEventListener("change", function (e) {
    setSetting({ fabHidden: e.target.checked });
    $("pageInfo").textContent = e.target.checked ? "已隐藏悬浮球（弹窗可重新显示）" : "已显示悬浮球";
  });
  $("selStealth").addEventListener("change", function (e) {
    setSetting({ stealthScan: e.target.value });
    $("stealthHint").textContent = STEALTH_HINT[e.target.value] || "";
  });
  $("btnPanel").addEventListener("click", async function () {
    var r = await sendTab({ type: "openPanel" });
    if (r && r.ok) { window.close(); }
    else { $("pageInfo").textContent = "无法打开面板：请确认页面已加载完成"; }
  });
  $("btnScan").addEventListener("click", async function () {
    var r = await sendTab({ type: "scanNow" });
    if (r && r.ok) { window.close(); } else { $("pageInfo").textContent = "无法扫描：请刷新 Discord 页面"; }
  });
  $("btnOptions").addEventListener("click", function () { chrome.runtime.openOptionsPage(); });
  $("btnClear").addEventListener("click", async function () {
    await send({ type: "clearCache" });
    await sendTab({ type: "clearPageResults" });
    $("cacheInfo").textContent = "缓存已清空";
  });
});
