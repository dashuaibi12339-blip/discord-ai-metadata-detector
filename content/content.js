// content/content.js —— Discord 頁面上的徽章、面板與掃描排程（classic script，不可用 import）
(function () {
  "use strict";
  if (window.__dmdContentLoaded) { return; }
  window.__dmdContentLoaded = true;

  var DEFAULTS = {
    enabled: true, autoScan: true, scanMode: "visible", stealthScan: "off", showBadge: true, badgeMode: "ai",
    fabPos: null, fabHidden: false,
    dimNoMeta: false, keyword: "", sourceFilter: "all", autoScanLimit: 60, pageBudgetMB: 30,
  };
  var settings = Object.assign({}, DEFAULTS);
  var records = new Map();      // key -> record（SW 回傳）
  var targets = new Map();      // key -> [{el, badge, inline, url}]
  var checked = Object.create(null);   // key -> true（本次頁面已請求過）
  var queue = [];               // 待送出
  var inFlight = 0;
  var pageScanned = 0;
  var expanded = Object.create(null);  // key -> true（面板中展開）
  var panel = null;
  var panelOpen = false;
  var lastListBuild = 0;
  var pageBytes = 0;          // 本頁已讀取的位元組（流量預算用）
  var budgetWarned = false;

  // ---------- 工具 ----------
  // 與 lib/discord-url.js 保持完全一致（固定 base，避免兩邊算出不同的鍵）
  function normalizeKey(url) {
    try { var u = new URL(url, "https://discord.com/"); return u.pathname.replace(/^\/+/, ""); } catch (e) { return String(url).split("?")[0]; }
  }
  function fileNameOf(url) {
    var key = normalizeKey(url); var parts = key.split("/");
    var n = parts[parts.length - 1] || "image";
    try { return decodeURIComponent(n); } catch (e) { return n; }
  }
  var IMG_RE = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif|jxl)$/i;
  var VID_RE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;

  function bestUrlFromImg(img) {
    var srcset = img.getAttribute("srcset") || "";
    var best = "";
    var bestW = -1;
    if (srcset) {
      var parts = srcset.split(",");
      for (var i = 0; i < parts.length; i++) {
        var seg = parts[i].trim().split(/\s+/);
        var url = seg[0];
        var w = 0;
        if (seg[1]) { w = parseInt(seg[1].replace(/[^\d]/g, ""), 10) || 0; }
        if (url && url.indexOf("/attachments/") !== -1 && w >= bestW) { bestW = w; best = url; }
      }
    }
    if (!best) { best = img.currentSrc || img.getAttribute("src") || ""; }
    return best;
  }
  function ensurePositioned(el) {
    try {
      if (getComputedStyle(el).position === "static") { el.style.position = "relative"; }
    } catch (e) { /* ignore */ }
  }
  // 徽章只留兩大類：NovelAI / 本地工具（ComfyUI、A1111、InvokeAI…）；無資料不顯示
  function shortLabel(rec) {
    if (!rec) { return ""; }
    if (rec.status === "error") { return "!"; }
    if (rec.status !== "ok") { return ""; }
    if (rec.source === "novelai") { return "NAI"; }
    if (rec.source === "comfyui") { return "CF"; }
    return "AI";
  }
  function badgeClass(rec) {
    if (!rec) { return "dmd-st-pending"; }
    if (rec.status === "ok") { return rec.source === "novelai" ? "dmd-st-novelai" : "dmd-st-ai"; }
    if (rec.status === "error") { return "dmd-st-error"; }
    return "dmd-st-none";
  }
  function statusText(rec) {
    if (!rec) { return "等待检测"; }
    if (rec.status === "error") { return "抓取失败：" + (rec.error || "未知错误"); }
    if (rec.status === "unsupported") { return (rec.notes || []).join("；") || "不支援的格式"; }
    if (rec.status === "ok") { return "有 AI 提示词"; }
    if (rec.reencoded) { return "被 Discord 重新编码，原提示词已被剥离"; }
    if (rec.status === "other") { return "有元数据但不是 AI 提示词"; }
    return "没有元数据";
  }
  function titleFor(rec, name) {
    if (!rec) { return "Discord 元数据检测器（等待检测）"; }
    var lines = [name, statusText(rec)];
    if (rec.tool) { lines.push("来源：" + rec.tool); }
    if (rec.paramsString) { lines.push(rec.paramsString); }
    if (rec.preview) { lines.push(String(rec.preview).slice(0, 400)); }
    if (rec.status !== "error") { lines.push("（共读取 " + (rec.bytes || 0) + " 字节）"); }
    return lines.join("\n");
  }
  function shouldShowBadge(rec) {
    if (!settings.showBadge) { return false; }
    if (settings.badgeMode === "all") { return !!shortLabel(rec); }
    // 預設：只有「有 AI 提示詞」與「抓取失敗」才顯示徽章
    if (!rec) { return false; }
    return rec.status === "ok" || rec.status === "error";
  }

  // ---------- 徽章 ----------
  // 選出這張附件「最適合掛徽章」的元素：面積最大的可見節點
  function pickOwner(key) {
    var list = targets.get(key) || [];
    var best = null;
    var bestArea = -1;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it.el || !it.el.isConnected) { continue; }
      var area = 0;
      try {
        var r = it.el.getBoundingClientRect();
        area = r ? Math.round(r.width) * Math.round(r.height) : 0;
      } catch (e) { area = 0; }
      if (area > bestArea) { best = it; bestArea = area; }
    }
    return best;
  }
  function ensureBadge(item, key) {
    if (item.badge && item.badge.isConnected && isAncestor(item.badge.parentElement, item.el)) { return item.badge; }
    if (item.badge && item.badge.isConnected) { item.badge.remove(); item.badge = null; }
    var host = item.inline ? item.el : (item.el.parentElement || item.el);
    if (!item.inline) { ensurePositioned(host); }
    host.classList.add("dmd-host");
    // 容器裡已經有同一個附件的徽章就直接沿用
    var kids = host.children || [];
    for (var b = 0; b < kids.length; b++) {
      var kcls = String(kids[b].className || "");
      if (kcls.indexOf("dmd-badge") !== -1 && kids[b].getAttribute("data-dmd-badge") === key) {
        item.badge = kids[b];
        return item.badge;
      }
    }
    var badge = document.createElement("div");
    badge.className = "dmd-badge " + (item.inline ? "dmd-badge-inline" : "dmd-badge-abs");
    badge.setAttribute("data-dmd-badge", key);
    badge.textContent = "";
    badge.addEventListener("click", function (ev) { onBadgeClick(ev, key, badge, item.el); });
    host.appendChild(badge);
    item.badge = badge;
    return badge;
  }
  // 讓一個附件的徽章收斂成「全站只有一個，且掛在最大的可見元素上」
  // （Discord 對同一張附件會渲染多個節點：劇透遮罩、燈箱預覽、回覆縮圖…）
  function syncBadgeForKey(key) {
    var list = targets.get(key) || [];
    var owner = pickOwner(key);
    var ownerBadge = owner ? owner.badge : null;
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it !== owner && it.badge && it.badge.isConnected) { it.badge.remove(); it.badge = null; }
    }
    var divs = document.querySelectorAll(".dmd-badge");
    for (var j = 0; j < divs.length; j++) {
      if (divs[j].getAttribute("data-dmd-badge") === key && divs[j] !== ownerBadge) { divs[j].remove(); }
    }
    if (owner) { ensureBadge(owner, key); }
    for (var m = 0; m < list.length; m++) { applyRecordToTarget(list[m], records.get(key)); }
  }
  function registerTarget(el, key, url, inline) {
    var list = targets.get(key);
    if (!list) { list = []; targets.set(key, list); }
    for (var i = 0; i < list.length; i++) { if (list[i].el === el) { return; } }
    var item = { el: el, badge: null, inline: inline, url: url };
    list.push(item);
    el.setAttribute("data-dmd-key", key);
    el.classList.add("dmd-target");
    syncBadgeForKey(key);
  }

  // 移除孤兒徽章：Discord（React）換掉 <img> 後，舊徽章還留在容器上會造成疊加
  function isAncestor(host, el) {
    var n = el;
    while (n) {
      if (n === host) { return true; }
      n = n.parentElement;
    }
    return false;
  }
  function sweepTargets() {
    var removed = 0;
    targets.forEach(function (list, key) {
      var live = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        if (item.el && item.el.isConnected) { live.push(item); continue; }
        if (item.badge && item.badge.isConnected) { item.badge.remove(); }
        else if (item.badge && item.badge.parentNode) { item.badge.parentNode.removeChild(item.badge); }
        item.badge = null;
        removed++;
      }
      if (live.length === 0) { targets.delete(key); } else { targets.set(key, live); }
    });
    // 每個附件收斂成只有一個徽章（React 換節點/多節點渲染都會被這裡收掉）
    targets.forEach(function (list, key) { syncBadgeForKey(key); });
    // 沒有存活目標的孤兒徽章一律清掉
    var all = document.querySelectorAll(".dmd-badge, .dmd-inspect");
    for (var i = 0; i < all.length; i++) {
      var k = all[i].getAttribute("data-dmd-badge") || all[i].getAttribute("data-dmd-inspect");
      var lst = k ? targets.get(k) : null;
      var okHere = false;
      if (lst) {
        for (var j = 0; j < lst.length; j++) {
          if ((lst[j].badge === all[i] || lst[j].inspect === all[i]) && lst[j].el.isConnected) { okHere = true; break; }
        }
      }
      if (!okHere) { all[i].remove(); removed++; }
    }
    return removed;
  }

  function applyRecordToTarget(item, rec) {
    var b = item.badge;
    // 沒有徽章（例如同一張附件由另一個節點持有徽章）也要更新狀態屬性與暗淡
    if (b && b.isConnected) {
      var label = shortLabel(rec);
      b.className = "dmd-badge " + (item.inline ? "dmd-badge-inline" : "dmd-badge-abs") + " " + badgeClass(rec);
      b.textContent = label;
      b.title = titleFor(rec, fileNameOf(item.url));
      b.style.display = shouldShowBadge(rec) && label ? "" : "none";
    }
    item.el.setAttribute("data-dmd-status", rec ? rec.status : "pending");
    item.el.setAttribute("data-dmd-source", rec ? (rec.source || "none") : "unknown");
    applyDim(item.el, rec);
  }

  // 暗淡：直接加類別到圖片（或其外層連結），不依賴 html 類別 + 屬性選擇器
  function applyDim(el, rec) {
    var host = el;
    if (el.tagName === "IMG" && el.parentElement && el.parentElement.tagName === "A") { host = el.parentElement; }
    var dim = !!settings.dimNoMeta && (!rec || rec.status !== "ok");
    if (dim) { host.classList.add("dmd-dim"); } else { host.classList.remove("dmd-dim"); }
  }

  function updateKey(key) {
    var list = targets.get(key) || [];
    for (var i = 0; i < list.length; i++) { applyRecordToTarget(list[i], records.get(key)); }
  }
  function updateAll() {
    targets.forEach(function (list, key) {
      for (var i = 0; i < list.length; i++) { applyRecordToTarget(list[i], records.get(key)); }
    });
  }

  // ---------- DOM 掃描 ----------
  function isEnabled() { return settings.enabled !== false; }
  function removeAllBadges() {
    var nodes = document.querySelectorAll(".dmd-badge");
    for (var i = 0; i < nodes.length; i++) { if (nodes[i].parentNode) { nodes[i].parentNode.removeChild(nodes[i]); } }
    targets.forEach(function (list) {
      for (var j = 0; j < list.length; j++) {
        var el = list[j].el;
        if (!el) { continue; }
        try {
          el.removeAttribute("data-dmd-key");
          el.removeAttribute("data-dmd-status");
          el.removeAttribute("data-dmd-source");
        } catch (e) { /* ignore */ }
        if (el.classList) { el.classList.remove("dmd-dim"); el.classList.remove("dmd-mark"); el.classList.remove("dmd-target"); }
      }
    });
    targets.clear();
  }
  // 暫停／恢復識別
  function setPaused(paused) {
    buildPanel();
    panel.root.classList.toggle("dmd-paused", !!paused);
    var icon = panel.fabIcon || null;
    if (icon) { icon.textContent = paused ? "⏸" : "AI"; }
    if (panel.fab) { panel.fab.title = paused ? "检测已暂停（点开面板可恢复）" : "Discord 元数据检测器（点击展开）"; }
    if (panel.banner) { panel.banner.style.display = paused ? "" : "none"; }
    if (paused) {
      queue.length = 0;
      visibleKeys.length = 0;
      removeAllBadges();
      if (io) { try { io.disconnect(); } catch (e) {} io = null; }
      if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
      if (panel.list) { panel.list.textContent = ""; }
      if (panel.stats) { panel.stats.textContent = "已暂停：不检测任何图片，也不会发起任何网络请求。"; }
      if (panel.fabCount) { panel.fabCount.style.display = "none"; }
      send({ type: "badge", count: 0 });
    } else {
      collect();
      watchDom();
      applyVisualSettings();
      updatePanel();
      updateBadge();
    }
  }
  function collect() {
    if (!isEnabled()) { return 0; }
    sweepTargets();
    var nodes = document.querySelectorAll('img[src*="/attachments/"], img[srcset*="/attachments/"], a[href*="/attachments/"]');
    var added = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute("data-dmd-key")) { continue; }
      if (el.tagName === "IMG") {
        if (el.closest && el.closest("#dmd-panel")) { continue; }
        var src = bestUrlFromImg(el);
        if (!src || src.indexOf("/attachments/") === -1) { continue; }
        registerTarget(el, normalizeKey(src), src, false);
        added++;
      } else {
        if (el.querySelector("img")) { continue; }
        var href = el.getAttribute("href") || "";
        if (href.indexOf("/attachments/") === -1) { continue; }
        var name = fileNameOf(href);
        if (!IMG_RE.test(name) && !VID_RE.test(name)) { continue; }
        registerTarget(el, normalizeKey(href), href, true);
        added++;
      }
    }
    if (added > 0) { requestCached(); if (settings.autoScan) { scheduleVisibleScan(); } }
    return added;
  }

  // ---------- 與 SW 溝通 ----------
  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }
  function requestCached() {
    var keys = [];
    targets.forEach(function (v, key) { if (!records.has(key)) { keys.push(key); } });
    if (keys.length === 0) { return; }
    for (var i = 0; i < keys.length; i += 200) {
      send({ type: "getCached", keys: keys.slice(i, i + 200) }).then(function (resp) {
        if (!resp || !resp.ok) { return; }
        var any = false;
        for (var k in resp.results) { records.set(k, resp.results[k]); any = true; }
        if (any) { updateAll(); updatePanel(); updateBadge(); }
      });
    }
  }
  function enqueue(key, url) {
    if (!isEnabled()) { return; }
    if (checked[key]) { return; }
    checked[key] = true;
    queue.push({ key: key, url: url });
    pump();
  }
  function pump() {
    if (!isEnabled()) { queue.length = 0; return; }
    if (inFlight >= 2 || queue.length === 0) { return; }
    var batch = queue.splice(0, 4);
    inFlight++;
    var items = batch.map(function (b) { return { key: b.key, url: b.url, name: fileNameOf(b.url) }; });
    send({ type: "checkItems", items: items, opts: {} }).then(function (resp) {
      inFlight--;
      if (resp && resp.ok && resp.results) {
        for (var i = 0; i < resp.results.length; i++) {
          var rec = resp.results[i];
          records.set(rec.key, rec);
          pageBytes += (rec.bytes || 0);
          updateKey(rec.key);
          pageScanned++;
        }
        updatePanel(); updateBadge();
      }
      setTimeout(pump, 180);
    });
    setTimeout(function () { if (queue.length > 0) { pump(); } }, 400);
  }
  function scanKeys(keys) {
    var n = 0;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var list = targets.get(key);
      if (!list || !list.length || records.has(key)) { continue; }
      enqueue(key, list[0].url);
      n++;
    }
    return n;
  }
  function allKeys(onlyUnchecked) {
    var keys = [];
    targets.forEach(function (v, key) {
      if (onlyUnchecked && records.has(key)) { return; }
      keys.push(key);
    });
    return keys;
  }
  function updateBadge() {
    var count = 0;
    records.forEach(function (rec, key) { if (rec.status === "ok" && targets.has(key)) { count++; } });
    send({ type: "badge", count: count });
  }

  // ---------- 可見範圍自動掃描 ----------
  var visibleKeys = [];
  var visibleTimer = null;
  var io = null;
  function scheduleVisibleScan() {
    if (!("IntersectionObserver" in window)) { scanKeys(allKeys(true)); return; }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        if (!isEnabled()) { return; }
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) { continue; }
          var el = entries[i].target;
          var key = el.getAttribute("data-dmd-key");
          if (!key || records.has(key) || checked[key]) { continue; }
          if (pageScanned >= settings.autoScanLimit && settings.scanMode === "visible") { continue; }
          if (pageBytes >= (settings.pageBudgetMB || 30) * 1048576) {
            if (!budgetWarned) {
              budgetWarned = true;
              toast("本页已读取约 " + Math.round(pageBytes / 1048576) + "MB，达到流量预算，已停止自动检测（可点「扫描已加载的图」继续，或在设置里调高预算）");
            }
            continue;
          }
          visibleKeys.push(key);
        }
        flushVisible();
      }, { root: null, rootMargin: "200px 0px", threshold: 0.05 });
    }
    targets.forEach(function (list, key) {
      if (records.has(key) || checked[key]) { return; }
      for (var i = 0; i < list.length; i++) { try { io.observe(list[i].el); } catch (e) { /* ignore */ } }
    });
  }
  function flushVisible() {
    if (visibleTimer) { return; }
    visibleTimer = setTimeout(function () {
      visibleTimer = null;
      scanKeys(visibleKeys.splice(0, visibleKeys.length));
    }, 250);
  }

  // ---------- 圖片旁的浮動說明（點徽章或 hover 小標籤） ----------
  function onBadgeClick(ev, key, anchor, targetEl) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    if (ev && ev.stopPropagation) { ev.stopPropagation(); }
    openPopover(key, anchor);
  }
  function closePopover() {
    var p = document.getElementById("dmd-pop");
    if (p && p.parentNode) { p.parentNode.removeChild(p); }
  }
  function popBtn(label, title, fn) {
    var b = el("button", "dmd-mini", label);
    b.type = "button";
    if (title) { b.title = title; }
    if (fn) { b.addEventListener("click", fn); }
    return b;
  }
  function openPopover(key, anchor) {
    closePopover();
    var rec = records.get(key);
    var url = (rec && rec.url) || (targets.get(key) && targets.get(key)[0] ? targets.get(key)[0].url : "");
    var pop = el("div", "dmd-pop");
    pop.id = "dmd-pop";
    var head = el("div", "dmd-pop-head");
    head.appendChild(el("span", "dmd-chip " + badgeClass(rec), chipLabel(rec)));
    head.appendChild(el("span", "dmd-pop-title", fileNameOf(url || key)));
    var x = el("button", "dmd-icon-btn", "×");
    x.type = "button";
    x.addEventListener("click", function () { closePopover(); });
    head.appendChild(x);
    pop.appendChild(head);
    pop.appendChild(el("div", "dmd-pop-status", rec ? statusText(rec) : "尚未检测（可以点「重新检测」）"));
    if (rec && rec.status === "ok") {
      pop.appendChild(el("div", "dmd-full-label", "正向提示词"));
      pop.appendChild(el("pre", "dmd-full-text", rec.prompt || "（未解析到）"));
      if (rec.negative) {
        pop.appendChild(el("div", "dmd-full-label", "负面提示词"));
        pop.appendChild(el("pre", "dmd-full-text", rec.negative));
      }
      var meta = [];
      if (rec.tool) { meta.push("来源：" + rec.tool); }
      if (rec.paramsString) { meta.push(rec.paramsString); }
      if (rec.width) { meta.push("尺寸：" + rec.width + "x" + rec.height); }
      if (meta.length) {
        pop.appendChild(el("div", "dmd-full-label", "参数"));
        pop.appendChild(el("pre", "dmd-full-text", meta.join("\n")));
      }
    } else {
      var lines = [];
      if (rec && rec.paramsString) { lines.push(rec.paramsString); }
      if (rec && rec.notes && rec.notes.length) { lines.push("备注：" + rec.notes.join("；")); }
      if (rec && rec.error) { lines.push("错误：" + rec.error); }
      if (rec && rec.reencoded) { lines.push("这张图被 Discord 重新编码过，原图提示词已被剥离。"); }
      if (!lines.length) { lines.push(rec && rec.status === "none" ? "这张图没有可读的 AI 提示词元数据。" : "还没有检测结果。"); }
      pop.appendChild(el("pre", "dmd-full-text", lines.join("\n")));
    }
    var bar = el("div", "dmd-pop-bar");
    var pPrompt = rec && rec.prompt ? rec.prompt : "";
    var pNeg = rec && rec.negative ? rec.negative : "";
    if (pPrompt) { bar.appendChild(popBtn("复制正向", "只复制正向提示词（不含采样器等参数）", function () { copyText(pPrompt, null); toast("已复制正向提示词"); })); }
    if (pNeg) { bar.appendChild(popBtn("复制负面", "只复制负面提示词", function () { copyText(pNeg, null); toast("已复制负面提示词"); })); }
    if (pPrompt && pNeg) { bar.appendChild(popBtn("复制正+负", "正向与负面各占一行，仍然不含参数", function () { copyText(pPrompt + "\nNegative prompt: " + pNeg, null); toast("已复制正+负"); })); }
    bar.appendChild(popBtn("复制原图链接", "粘贴到别的地方也能下载原图", function () { copyText(url, null); toast("已复制原图链接"); }));
    bar.appendChild(popBtn("下载原图", "由扩展抓原始字节下载，保证是原图", function () { downloadOriginal(rec || { key: key, url: url }, null); }));
    bar.appendChild(popBtn("重新检测", "忽略缓存重新读取", function () { recheck(key, url); }));
    bar.appendChild(popBtn("隐写检测", "先做低成本预检（只读前面一小段）；确认有隐写才下载整份并解码像素", function () { deepCheckOne(key, url); }));
    bar.appendChild(popBtn("在面板中查看", "打开面板并定位到这一条", function () { togglePanel(true); locate(key); }));
    pop.appendChild(bar);
    (document.body || document.documentElement).appendChild(pop);
    // 依錨點定位：預設在徽章下方，空間不夠就翻到上方
    var r = (anchor && anchor.getBoundingClientRect) ? anchor.getBoundingClientRect() : { left: 8, top: 8, bottom: 8 };
    var vw = window.innerWidth || 1000, vh = window.innerHeight || 800;
    var pw = pop.offsetWidth || 380, ph = pop.offsetHeight || 340;
    var left = Math.min(Math.max(8, r.left), Math.max(8, vw - pw - 8));
    var top = r.bottom + 8;
    if (top + ph > vh - 8) { top = Math.max(8, r.top - ph - 8); }
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  function recheck(key, url, deep) {
    toast("重新检测中…");
    send({ type: "checkItems", items: [{ key: key, url: url }], opts: { deep: !!deep } }).then(function (resp) {
      if (resp && resp.ok && resp.results && resp.results[0]) {
        var rec = resp.results[0];
        records.set(rec.key, rec);
        updateKey(rec.key);
        updatePanel();
        updateBadge();
        toast("重新检测完成：" + statusText(rec));
      } else { toast("重新检测失败"); }
    });
  }
  // 面板某一行 hover → 頻道裡對應的圖加外框
  function mark(key, on) {
    var list = targets.get(key) || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i].el.classList[on ? "add" : "remove"]("dmd-mark"); } catch (e) { /* ignore */ }
    }
  }
  // 縮圖只用「頁面已經載入過的網址」→ 直接命中瀏覽器快取，不額外耗流量
  function thumbUrlFor(key) {
    var list = targets.get(key) || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i].el;
      if (e && e.tagName === "IMG") {
        var u = e.currentSrc || e.getAttribute("src") || "";
        if (u && u.indexOf("/attachments/") !== -1) { return u; }
      }
    }
    return "";
  }

  // ---------- 面板 ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }
  function matchKeywordLocal(text, keyword) {
    var tokens = String(keyword || "").trim().split(/[^a-zA-Z0-9\u4e00-\u9fff]+/).filter(function (t) { return t.length > 0; });
    if (!tokens.length) { return true; }
    var hay = String(text || "").replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, " ").toLowerCase();
    for (var i = 0; i < tokens.length; i++) { if (hay.indexOf(tokens[i].toLowerCase()) === -1) { return false; } }
    return true;
  }
  var TABS = [
    { id: "all", label: "全部" },
    { id: "novelai", label: "NovelAI", hint: "NovelAI（含 V4/V4.5 与 alpha 隐写）" },
    { id: "comfyui", label: "AI 本地工具", hint: "本地跑图工具：ComfyUI / A1111(WebUI) / Forge / Fooocus / SwarmUI / InvokeAI" },
    { id: "none", label: "无提示词", hint: "没有 AI 提示词：没有元数据、只有普通 EXIF（例如手机截图）、或被 Discord 重新编码剥离" },
    { id: "error", label: "失败", hint: "抓取失败或格式不支持（附件失效等）" },
  ];
  // ---------- 懸浮球：拖動、隱藏、歸位 ----------
  function applyFab() {
    if (!panel || !panel.fab) { return; }
    var btn = panel.fab;
    btn.style.display = settings.fabHidden ? "none" : "";
    var p = settings.fabPos || null;
    if (!p) {
      btn.style.left = ""; btn.style.top = ""; btn.style.right = ""; btn.style.bottom = "";
      return;
    }
    var w = window.innerWidth || 0;
    var h = window.innerHeight || 0;
    var size = 46;
    var x = Math.max(0, p.x || 0);
    var y = Math.max(0, p.y || 0);
    if (w > 0) { x = Math.min(x, Math.max(0, w - size)); }
    if (h > 0) { y = Math.min(y, Math.max(0, h - size)); }
    btn.style.left = x + "px";
    btn.style.top = y + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  }
  function hideFab() {
    saveSettings({ fabHidden: true });
    settings.fabHidden = true;
    applyFab();
    toast("已隐藏悬浮球 —— 可在扩展弹窗或设置页重新显示");
  }
  function bindFabGesture(btn) {
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    var hideEl = null;
    try { hideEl = btn.querySelector ? btn.querySelector(".dmd-fab-hide") : null; } catch (e) { hideEl = null; }
    if (hideEl && hideEl.addEventListener) {
      hideEl.addEventListener("click", function (ev) {
        if (ev && ev.stopPropagation) { ev.stopPropagation(); }
        if (ev && ev.preventDefault) { ev.preventDefault(); }
        hideFab();
      });
    }
    btn.addEventListener("contextmenu", function (ev) {
      if (ev && ev.preventDefault) { ev.preventDefault(); }
      hideFab();
    });
    btn.addEventListener("dblclick", function (ev) {
      if (ev && ev.preventDefault) { ev.preventDefault(); }
      saveSettings({ fabPos: null });
      settings.fabPos = null;
      applyFab();
      toast("悬浮球已回到默认位置");
    });
    btn.addEventListener("pointerdown", function (ev) {
      if (!ev || ev.clientX === undefined) { return; }
      if (ev.button !== undefined && ev.button !== 0 && ev.button !== null) { return; }
      dragging = true; moved = false;
      sx = ev.clientX; sy = ev.clientY;
      var r = null;
      try { r = btn.getBoundingClientRect(); } catch (e2) { r = null; }
      ox = r ? (sx - r.left) : 0;
      oy = r ? (sy - r.top) : 0;
      btn.classList.add("dmd-dragging");
      try { if (btn.setPointerCapture && ev.pointerId !== undefined) { btn.setPointerCapture(ev.pointerId); } } catch (e3) { /* ignore */ }
      if (ev.preventDefault) { ev.preventDefault(); }
    });
    var onMove = function (ev) {
      if (!dragging || !ev || ev.clientX === undefined) { return; }
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) { moved = true; }
      btn.style.left = (ev.clientX - ox) + "px";
      btn.style.top = (ev.clientY - oy) + "px";
      btn.style.right = "auto";
      btn.style.bottom = "auto";
    };
    var onUp = function () {
      if (!dragging) { return; }
      dragging = false;
      btn.classList.remove("dmd-dragging");
      if (!moved) { return; }                       // 沒拖動 → 交給 click 開面板
      var x = parseFloat(btn.style.left);
      var y = parseFloat(btn.style.top);
      if (!isNaN(x) && !isNaN(y)) { saveSettings({ fabPos: { x: Math.round(x), y: Math.round(y) } }); }
      btn.__dmdDragged = Date.now();
    };
    btn.addEventListener("pointermove", onMove);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);
    if (document.addEventListener) {          // 就算指標移出球外（沒有 pointer capture）也接得住
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      document.addEventListener("pointercancel", onUp, true);
    }
    btn.addEventListener("click", function (ev) {
      if (btn.__dmdDragged && Date.now() - btn.__dmdDragged < 400) {
        if (ev && ev.stopPropagation) { ev.stopPropagation(); }
        return;                                     // 拖動剛結束，不要把這次點擊當成「展開面板」
      }
      togglePanel(!panelOpen);
    });
  }
  function buildPanel() {
    if (panel) { return panel; }
    var root = el("div", "dmd-root");
    root.id = "dmd-root";
    var btn = el("button", "dmd-fab");
    btn.type = "button";
    var fabIcon = el("span", "dmd-fab-icon", "AI");
    var fabCount = el("span", "dmd-fab-count", "0");
    fabCount.style.display = "none";
    var fabHide = el("span", "dmd-fab-hide", "×");
    fabHide.title = "隐藏悬浮球（弹窗或设置页可重新显示）";
    btn.appendChild(fabIcon);
    btn.appendChild(fabCount);
    btn.appendChild(fabHide);
    btn.title = "Discord 元数据检测器（点击展开 · 按住可拖动 · 双击回到默认位置 · 右键隐藏）";
    bindFabGesture(btn);

    var wrap = el("div", "dmd-panel");
    wrap.id = "dmd-panel";
    wrap.style.display = "none";

    var head = el("div", "dmd-head");
    var ver = "";
    try { ver = chrome.runtime.getManifest().version; } catch (e) { ver = ""; }
    head.appendChild(el("div", "dmd-title", "AI 绘图元数据检测" + (ver ? " v" + ver : "")));
    var closeBtn = el("button", "dmd-icon-btn", "×");
    closeBtn.type = "button";
    closeBtn.addEventListener("click", function () { togglePanel(false); });
    head.appendChild(closeBtn);
    wrap.appendChild(head);

    var banner = el("div", "dmd-paused-banner");
    banner.style.display = "none";
    banner.appendChild(el("span", null, "已暂停识别：不检测任何图片，也不发起任何网络请求"));
    var resumeBtn = el("button", "dmd-btn dmd-btn-primary", "恢复检测");
    resumeBtn.type = "button";
    resumeBtn.addEventListener("click", function () { saveSettings({ enabled: true }); });
    banner.appendChild(resumeBtn);
    wrap.appendChild(banner);

    var stats = el("div", "dmd-stats");
    stats.id = "dmd-stats";
    wrap.appendChild(stats);
    var hint = el("div", "dmd-hint", "Discord 只把视口附近的消息留在页面上（虚拟滚动），所以只能检测「已加载」的图；往下滚动会自动加载并补测。已检测过的命中缓存，不会重新下载。隐写自动检测模式（off / auto / always）在扩展弹窗顶部切换。");
    wrap.appendChild(hint);

    var ctrl = el("div", "dmd-controls");
    var search = el("input", "dmd-input");
    search.type = "search";
    search.placeholder = "关键词筛选（blue_archive 也能命中 blue archive）";
    search.value = settings.keyword || "";
    search.addEventListener("input", function () { settings.keyword = search.value; renderList(); });
    ctrl.appendChild(search);

    var tabsRow = el("div", "dmd-tabs");
    var tabEls = {};
    for (var i = 0; i < TABS.length; i++) {
      (function (t) {
        var tb = el("button", "dmd-tab");
        tb.type = "button";
        if (t.hint) { tb.title = t.hint; }
        tb.appendChild(el("span", "dmd-tab-label", t.label));
        var n = el("span", "dmd-tab-n", "0");
        tb.appendChild(n);
        tb.addEventListener("click", function () { settings.sourceFilter = t.id; renderList(); });
        tabEls[t.id] = { btn: tb, n: n };
        tabsRow.appendChild(tb);
      })(TABS[i]);
    }
    ctrl.appendChild(tabsRow);

    var row2 = el("div", "dmd-row");
    var dimCb = el("label", "dmd-check");
    var dimInput = el("input");
    dimInput.type = "checkbox";
    dimInput.id = "dmd-dim-toggle";
    dimInput.addEventListener("change", function () { saveSettings({ dimNoMeta: dimInput.checked }); });
    dimCb.appendChild(dimInput);
    dimCb.appendChild(el("span", null, "暗淡没有提示词的图"));
    row2.appendChild(dimCb);

    var allBadgeCb = el("label", "dmd-check");
    var allBadgeInput = el("input");
    allBadgeInput.type = "checkbox";
    allBadgeInput.addEventListener("change", function () { saveSettings({ badgeMode: allBadgeInput.checked ? "all" : "ai" }); });
    allBadgeCb.appendChild(allBadgeInput);
    allBadgeCb.appendChild(el("span", null, "显示全部状态徽章"));
    row2.appendChild(allBadgeCb);
    ctrl.appendChild(row2);

    var actions = el("div", "dmd-actions");
    var btnScan = el("button", "dmd-btn dmd-btn-primary", "扫描已加载的图");
    btnScan.type = "button";
    btnScan.title = "扫描「当前已加载」消息里的全部图片附件。Discord 是虚拟滚动，只把视口附近的消息留在页面上，所以扫不到频道历史；往下滚动会加载更多，扩展会自动补测。已检测过的直接命中缓存，不重新下载。";
    btnScan.addEventListener("click", function () { scanChannel(); });
    var btnDeep = el("button", "dmd-btn", "隐写检测可见图");
    btnDeep.type = "button";
    btnDeep.title = "对当前可见的 PNG 逐个做 alpha 隐写检测（先预检，命中才整份下载）。自动模式在扩展弹窗顶部的 off / auto / always 切换。";
    btnDeep.addEventListener("click", function () { deepScanVisible(); });
    var btnCsv = el("button", "dmd-btn", "导出 CSV");
    btnCsv.type = "button";
    btnCsv.addEventListener("click", function () { doExport("csv"); });
    var btnJson = el("button", "dmd-btn", "导出 JSON");
    btnJson.type = "button";
    btnJson.addEventListener("click", function () { doExport("json"); });
    var btnOpt = el("button", "dmd-btn", "设置");
    btnOpt.type = "button";
    btnOpt.addEventListener("click", function () { send({ type: "openOptions" }); });
    var btnPause = el("button", "dmd-btn", "暂停检测");
    btnPause.type = "button";
    btnPause.title = "停止识别：移除所有徽章、不再检测任何图片、不再发起任何网络请求";
    btnPause.addEventListener("click", function () { saveSettings({ enabled: false }); });
    actions.appendChild(btnScan);
    actions.appendChild(btnDeep);
    actions.appendChild(btnCsv);
    actions.appendChild(btnJson);
    actions.appendChild(btnOpt);
    actions.appendChild(btnPause);
    ctrl.appendChild(actions);
    wrap.appendChild(ctrl);

    var list = el("div", "dmd-list");
    list.id = "dmd-list";
    wrap.appendChild(list);

    root.appendChild(wrap);
    root.appendChild(btn);
    (document.body || document.documentElement).appendChild(root);
    panel = { root: root, fab: btn, fabIcon: fabIcon, fabCount: fabCount, wrap: wrap, stats: stats, banner: banner, list: list, search: search, tabEls: tabEls, dimInput: dimInput, allBadgeInput: allBadgeInput };
    applyFab();
    return panel;
  }
  function togglePanel(open) {
    panelOpen = open;
    buildPanel();
    panel.wrap.style.display = open ? "flex" : "none";
    if (open) { renderList(); }
  }
  function counts() {
    var c = { all: 0, novelai: 0, comfyui: 0, none: 0, other: 0, error: 0, unsupported: 0, ai: 0 };
    records.forEach(function (rec, key) {
      if (!targets.has(key)) { return; }
      c.all++;
      if (rec.status === "ok") { c.ai++; c[rec.source === "novelai" ? "novelai" : "comfyui"]++; }
      else if (rec.status === "error") { c.error++; }
      else if (rec.status === "other") { c.other++; }
      else if (rec.status === "unsupported") { c.unsupported++; }
      else { c.none++; }
    });
    return c;
  }
  function updatePanel() {
    if (!panel) { return; }
    var c = counts();
    if (panel.fabCount) {
      panel.fabCount.textContent = String(c.ai);
      panel.fabCount.style.display = c.ai > 0 ? "" : "none";
    }
    if (!panel.stats) { return; }
    panel.stats.textContent = "已加载图片 " + targets.size + " 张 · 已检测 " + c.all + " · 有提示词 " + c.ai +
      "（NAI " + c.novelai + " / 本地 " + c.comfyui + "）· 无提示词 " + (c.none + c.other + c.unsupported) +
      (c.error ? " · 失败 " + c.error : "") + (queue.length + inFlight * 4 > 0 ? " · 队列 " + (queue.length + inFlight * 4) : "");
    if (panel.tabEls) {
      var setN = function (id, n) { if (panel.tabEls[id]) { panel.tabEls[id].n.textContent = String(n); } };
      setN("all", c.all);
      setN("novelai", c.novelai);
      setN("comfyui", c.comfyui);
      setN("none", c.none + c.other + c.unsupported);
      setN("error", c.error);
    }
    renderList();
  }
  function matchesTab(rec, tab) {
    if (tab === "all") { return true; }
    if (tab === "novelai") { return rec.status === "ok" && rec.source === "novelai"; }
    if (tab === "comfyui") { return rec.status === "ok" && rec.source !== "novelai"; }
    if (tab === "none") { return rec.status === "none" || rec.status === "other" || rec.status === "unsupported"; }
    if (tab === "error") { return rec.status === "error" || rec.status === "unsupported"; }
    return true;
  }
  function visibleRecords() {
    var order = [];
    targets.forEach(function (v, key) { order.push(key); });
    var pos = {};
    for (var i = 0; i < order.length; i++) { pos[order[i]] = i; }
    var kw = settings.keyword || "";
    var tab = settings.sourceFilter || "all";
    var arr = [];
    records.forEach(function (rec, key) {
      if (!targets.has(key)) { return; }
      if (!matchesTab(rec, tab)) { return; }
      if (kw) {
        var text = (rec.searchText || "") + " " + (rec.preview || "") + " " + (rec.paramsString || "") + " " + (rec.tool || "") + " " + (rec.negative || "");
        if (!matchKeywordLocal(text, kw)) { return; }
      }
      arr.push(rec);
    });
    arr.sort(function (a, b) {
      var rank = function (r) { return r.status === "ok" ? 0 : (r.status === "error" ? 3 : (r.status === "other" ? 1 : 2)); };
      var d = rank(a) - rank(b);
      if (d !== 0) { return d; }
      if (a.status === "ok" && b.status === "ok" && a.source !== b.source) { return a.source === "novelai" ? -1 : 1; }
      return (pos[a.key] || 0) - (pos[b.key] || 0);
    });
    return arr;
  }
  function chipLabel(rec) {
    if (rec.status === "ok") { return rec.source === "novelai" ? "NAI" : "本地"; }
    if (rec.status === "error") { return "失败"; }
    return "无";   // 其他元数据 / 被剥离 / 不支持 一律归到「无提示词」，细节在副标题与展开内容里
  }
  var scrollMemory = {};   // 重新渲染時保住每個提示詞框的捲動位置（避免「松手就回頂」）
  function fullBlock(rec) {
    var box = el("div", "dmd-full");
    var pos = (rec.prompt || "").trim();
    var neg = (rec.negative || "").trim();
    var add = function (label, text, cls) {
      if (!text) { return; }
      box.appendChild(el("div", "dmd-full-label", label));
      var pre = el("pre", "dmd-full-text" + (cls ? " " + cls : ""), text);
      var sk = rec.key + "|" + label;
      pre.addEventListener("scroll", function () { scrollMemory[sk] = pre.scrollTop; }, { passive: true });
      if (scrollMemory[sk]) { preScrollQueue.push({ pre: pre, top: scrollMemory[sk] }); }   // 掛進 DOM 後才還原
      box.appendChild(pre);
    };
    add("正向提示词", pos || (rec.status === "ok" ? "（未解析到）" : ""));
    add("负面提示词", neg);
    var paramLines = [];
    if (rec.paramsString) { paramLines.push(rec.paramsString); }
    if (rec.tool) { paramLines.push("来源：" + rec.tool + (rec.format ? " · 格式 " + rec.format : "") + (rec.width ? " · " + rec.width + "x" + rec.height : "")); }
    if (rec.notes && rec.notes.length) { paramLines.push("备注：" + rec.notes.join("；")); }
    if (rec.error) { paramLines.push("错误：" + rec.error); }
    if (rec.format === "png" && !pos && !rec.deep) {
      paramLines.push("这张 PNG 没有文字元数据。NovelAI 有些图会把提示词藏在 alpha 通道隐写里 —— 点「隐写检测」可以单张验证（先只读前一小段做预检，确认有隐写才下载整份）。");
    }
    if (paramLines.length) { add("参数与信息", paramLines.join("\n")); }
    var bar = el("div", "dmd-full-bar");
    var mk = function (label, title, fn) {
      var b = el("button", "dmd-mini", label);
      b.type = "button";
      if (title) { b.title = title; }
      b.addEventListener("click", fn);
      return b;
    };
    if (pos) { bar.appendChild(mk("复制正向", "只复制正向提示词（不含采样器等参数）", function () { copyText(pos, null); toast("已复制正向提示词"); })); }
    if (neg) { bar.appendChild(mk("复制负面", "只复制负面提示词", function () { copyText(neg, null); toast("已复制负面提示词"); })); }
    if (pos && neg) { bar.appendChild(mk("复制正+负", "正向与负面各占一行，仍然不含参数", function () { copyText(pos + "\nNegative prompt: " + neg, null); toast("已复制正+负"); })); }
    bar.appendChild(mk("下载原图", "由扩展抓原始字节下载，保证是原图", function () { downloadOriginal(rec, null); }));
    bar.appendChild(mk("打开链接", "在浏览器中打开扩展实际抓到的原图链接", function () { window.open(originalUrlOf(rec), "_blank"); }));
    bar.appendChild(mk("定位到图片", "滚动到频道里这张图并高亮", function () { locate(rec.key); }));
    box.appendChild(bar);
    return box;
  }
  var preScrollQueue = [];   // 內層提示詞框的捲動位置：必須等元素掛進 DOM 之後再還原，否則會被忽略
  var lastListSig = "";
  // 記住「現在面板頂端是哪一列」：比單純存 scrollTop 更穩（上面插入新結果時不會跑位）
  function scrollAnchor(list) {
    var top = list.scrollTop || 0;
    var kids = list.children || [];
    for (var i = 0; i < kids.length; i++) {
      var off = kids[i].offsetTop;
      if (typeof off !== "number") { return { key: null, delta: 0, top: top }; }
      if (off >= top) { return { key: kids[i].getAttribute("data-dmd-row"), delta: off - top, top: top }; }
    }
    return { key: null, delta: 0, top: top };
  }
  function restoreScroll(list, anchor) {
    if (!anchor) { return; }
    if (anchor.key) {
      var kids = list.children || [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].getAttribute("data-dmd-row") === anchor.key && typeof kids[i].offsetTop === "number") {
          list.scrollTop = kids[i].offsetTop - anchor.delta;
          return;
        }
      }
    }
    if (anchor.top) { list.scrollTop = anchor.top; }
  }
  function renderList(force) {
    if (!panel || !panelOpen) { return; }
    var now = Date.now();
    if (!force && now - lastListBuild < 150) { return; }
    lastListBuild = now;
    var tab = settings.sourceFilter || "all";
    for (var t = 0; t < TABS.length; t++) {
      if (panel.tabEls[TABS[t].id]) {
        panel.tabEls[TABS[t].id].btn.classList.toggle("active", TABS[t].id === tab);
      }
    }
    if (panel.dimInput) { panel.dimInput.checked = !!settings.dimNoMeta; }
    if (panel.allBadgeInput) { panel.allBadgeInput.checked = settings.badgeMode === "all"; }
    var arr = visibleRecords();
    var list = panel.list;
    // 內容簽章沒變就不動 DOM —— 掃描進度更新時最容易在這裡把捲動位置打回頂部
    var sig = (settings.sourceFilter || "all") + "|" + (settings.keyword || "") + "|" + arr.length + "|";
    for (var si = 0; si < arr.length; si++) {
      var sr = arr[si];
      sig += sr.key + "," + sr.status + "," + (sr.prompt || "").length + "," + (sr.negative || "").length + "," + (expanded[sr.key] ? 1 : 0) + "," + (sr.bytes || 0) + ";";
    }
    if (sig === lastListSig && list.children && list.children.length) { return; }
    lastListSig = sig;
    list.textContent = "";
    if (arr.length === 0) {
      list.appendChild(el("div", "dmd-empty", "没有符合条件的结果。点「扫描已加载的图」，或滚动页面自动检测。"));
      return;
    }
    var max = Math.min(arr.length, 300);
    var anchor = scrollAnchor(list);   // 必須在清空之前讀，否則永遠是 0
    preScrollQueue = [];
    for (var i = 0; i < max; i++) {
      var rec = arr[i];
      var isOpen = !!expanded[rec.key];
      var wrap = el("div", "dmd-item-wrap" + (isOpen ? " dmd-item-open" : ""));
      wrap.setAttribute("data-dmd-row", rec.key);
      var row = el("div", "dmd-item");
      row.addEventListener("mouseenter", function (k) { return function () { mark(k, true); }; }(rec.key));
      row.addEventListener("mouseleave", function (k) { return function () { mark(k, false); }; }(rec.key));
      var thumbUrl = rec.status === "ok" ? thumbUrlFor(rec.key) : "";
      if (thumbUrl) {
        var thumb = el("img", "dmd-thumb");
        thumb.loading = "lazy";
        thumb.src = thumbUrl;
        thumb.title = "点击定位到频道中的这张图";
        thumb.addEventListener("click", function (k) { return function (ev) { ev.stopPropagation(); locate(k); }; }(rec.key));
        row.appendChild(thumb);
      } else {
        row.appendChild(el("div", "dmd-thumb dmd-thumb-empty", rec.status === "ok" ? "图" : "—"));
      }
      row.appendChild(el("span", "dmd-chip " + badgeClass(rec), chipLabel(rec)));
      var main = el("div", "dmd-item-main");
      main.appendChild(el("div", "dmd-item-title", fileNameOf(rec.url || rec.key)));
      main.appendChild(el("div", "dmd-item-sub", statusText(rec) + (rec.tool ? " · " + rec.tool : "") + (rec.paramsString ? " · " + rec.paramsString : "")));
      if (!isOpen && rec.preview) { main.appendChild(el("div", "dmd-item-prev", String(rec.preview).replace(/\s+/g, " ").slice(0, 200))); }
      var toggle = function (key, isOpen) {
        return function (ev) {
          if (ev && ev.stopPropagation) { ev.stopPropagation(); }
          expanded[key] = !isOpen;
          renderList(true);
        };
      };
      main.addEventListener("click", toggle(rec.key, isOpen));
      row.appendChild(main);
      var acts = el("div", "dmd-item-acts");
      var tog = el("button", "dmd-mini", isOpen ? "收起" : "展开");
      tog.type = "button";
      tog.addEventListener("click", toggle(rec.key, isOpen));
      acts.appendChild(tog);
      if (rec.prompt || rec.preview) {
        var c2 = el("button", "dmd-mini", "复制");
        c2.type = "button";
        c2.title = "只复制正向提示词（不含负面与参数）";
        c2.addEventListener("click", function (r) { return function (ev) { ev.stopPropagation(); copyText(r.prompt || r.preview || "", c2); }; }(rec));
        acts.appendChild(c2);
      }
      if (rec.negative) {
        var c3 = el("button", "dmd-mini", "负");
        c3.type = "button";
        c3.title = "复制负面提示词";
        c3.addEventListener("click", function (r) { return function (ev) { ev.stopPropagation(); copyText(r.negative || "", c3); }; }(rec));
        acts.appendChild(c3);
      }
      var c5 = el("button", "dmd-mini", "下载原图");
      c5.type = "button";
      c5.title = "由扩展直接抓原始字节下载，保证拿到的是原图（不会被转成 webp）";
      c5.addEventListener("click", function (r) { return function (ev) { ev.stopPropagation(); downloadOriginal(r, c5); }; }(rec));
      acts.appendChild(c5);
      if (rec.format === "png") {
        var c6 = el("button", "dmd-mini", "隐写检测");
        c6.type = "button";
        c6.title = "先做低成本预检（只读前面一小段）；确认有隐写才下载整份并解码像素，读出 NovelAI 藏在 alpha 通道里的提示词。只对这一张生效。";
        c6.addEventListener("click", function (r) { return function (ev) { ev.stopPropagation(); deepCheckOne(r.key, r.url); }; }(rec));
        acts.appendChild(c6);
      }
      var c7 = el("button", "dmd-mini", "定位");
      c7.type = "button";
      c7.title = "滚动到频道里这张图并高亮";
      c7.addEventListener("click", function (r) { return function (ev) { ev.stopPropagation(); locate(r.key); }; }(rec));
      acts.appendChild(c7);
      row.appendChild(acts);
      wrap.appendChild(row);
      if (isOpen) { wrap.appendChild(fullBlock(rec)); }   // 展開內容獨立成「全寬」區塊，不再被右側按鈕擠成細條
      list.appendChild(wrap);
    }
    var applyPre = function () {
      for (var p = 0; p < preScrollQueue.length; p++) {
        try { preScrollQueue[p].pre.scrollTop = preScrollQueue[p].top; } catch (e) { /* ignore */ }
      }
    };
    restoreScroll(list, anchor);
    applyPre();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () { restoreScroll(list, anchor); applyPre(); });
    }
  }
  function locate(key) {
    var list = targets.get(key);
    if (!list || !list.length) { return; }
    try { list[0].el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { /* ignore */ }
    list[0].el.classList.add("dmd-flash");
    setTimeout(function () { try { list[0].el.classList.remove("dmd-flash"); } catch (e) {} }, 1600);
  }
  function copyText(text, btn) {
    var done = function () { if (btn) { var old = btn.textContent; btn.textContent = "已复制"; setTimeout(function () { btn.textContent = old; }, 1200); } };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }
  function originalUrlOf(rec) {
    return rec.originalUrl || rec.finalUrl || rec.url;
  }
  function downloadOriginal(rec, btn) {
    if (btn) { btn.textContent = "…"; }
    send({ type: "downloadOriginal", key: rec.key, url: rec.url }).then(function (resp) {
      if (btn) { btn.textContent = "下载原图"; }
      if (resp && resp.ok) { toast("已开始下载：" + resp.filename + "（" + Math.round((resp.bytes || 0) / 1024) + " KB · " + (resp.method || "") + "）"); }
      else { toast("下载失败：" + ((resp && resp.error) || "未知错误")); }
    });
  }

  // ---------- 動作 ----------
  function scanChannel() {
    collect();
    var all = allKeys(false);
    var n = scanKeys(allKeys(true));
    togglePanel(true);
    var cached = all.length - n;
    if (n > 0) {
      toast("已加入队列 " + n + " 张" + (cached > 0 ? "（另有 " + cached + " 张命中缓存，不重新下载）" : ""));
    } else if (all.length > 0) {
      toast("当前已加载的 " + all.length + " 张都检测过了（结果来自缓存，未重新下载）。往下滚动会加载更多消息，扩展会自动补测。");
    } else {
      toast("当前页面上没有找到图片附件 —— 往下滚一下让 Discord 加载消息后再点");
    }
  }
  function deepScanVisible() {
    var n = 0;
    targets.forEach(function (list, key) {
      var rec = records.get(key);
      if (rec && rec.deep) { return; }
      var item = list[0];
      if (!item) { return; }
      var r = item.el.getBoundingClientRect();
      if (r.bottom < -200 || r.top > window.innerHeight + 200) { return; }
      deepCheckOne(key, item.url);
      n++;
    });
    toast(n > 0 ? ("开始隐写检测 " + n + " 张（先预检，命中才下整份）") : "没有需要做隐写检测的可见 PNG");
  }
  function deepCheckOne(key, url) {
    toast("隐写检测中…（先预检；确认有隐写才下整份）");
    send({ type: "deepCheck", key: key, url: url }).then(function (resp) {
      if (resp && resp.ok && resp.result) {
        records.set(resp.result.key, resp.result);
        updateKey(resp.result.key);
        updatePanel();
        updateBadge();
        toast("隐写检测完成：" + (resp.result.source === "novelai" ? "发现 NovelAI 隐写提示词" : "未发现隐写数据"));
      } else {
        toast("隐写检测失败：" + ((resp && resp.error) || "未知错误"));
      }
    });
  }
  function doExport(format) {
    send({ type: "export", format: format, keyword: settings.keyword, sourceFilter: settings.sourceFilter }).then(function (resp) {
      if (!resp || !resp.ok) { toast("导出失败"); return; }
      downloadText(resp.text, resp.filename, resp.mime);
      toast("已导出 " + resp.filename);
    });
  }
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
  function toast(text) {
    var t = document.getElementById("dmd-toast");
    if (!t) {
      t = el("div", null, "");
      t.id = "dmd-toast";
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = "1";
    clearTimeout(t.__timer);
    t.__timer = setTimeout(function () { t.style.opacity = "0"; }, 3000);
  }
  function saveSettings(patch) {
    Object.assign(settings, patch);
    applyVisualSettings();
    send({ type: "setSettings", patch: patch });
  }
  function applyVisualSettings() {
    updateAll();
    if (panel) {
      panel.dimInput.checked = !!settings.dimNoMeta;
      panel.allBadgeInput.checked = settings.badgeMode === "all";
    }
    if (settings.autoScan) { scheduleVisibleScan(); }
  }

  // ---------- 啟動 ----------
  function boot() {
    send({ type: "getSettings" }).then(function (resp) {
      if (resp && resp.ok && resp.settings) { settings = Object.assign({}, DEFAULTS, resp.settings); }
      buildPanel();
      if (isEnabled()) {
        collect();
        applyVisualSettings();
        updatePanel();
      } else {
        setPaused(true);
      }
    });
  }
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.settings) { return; }
    settings = Object.assign({}, DEFAULTS, changes.settings.newValue || {});
    if (!isEnabled()) { setPaused(true); return; }
    setPaused(false);
    applyFab();
    if (settings.autoScan) { collect(); }
  });
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) { return; }
    if (msg.type === "toast") { toast(String(msg.text || "")); sendResponse({ ok: true }); return; }
    if (msg.type === "contextResult") {
      if (msg.result) {
        records.set(msg.result.key, msg.result);
        updateKey(msg.result.key);
        updateBadge();
        toast("检测完成：" + statusText(msg.result));
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "requestScanAll") { scanChannel(); sendResponse({ ok: true }); return; }
    if (msg.type === "getPageStats") {
      var c = counts();
      sendResponse({ ok: true, stats: { images: targets.size, scanned: c.all, ai: c.ai, novelai: c.novelai, comfyui: c.comfyui, none: c.none, other: c.other, errors: c.error, queued: queue.length } });
      return;
    }
    if (msg.type === "openPanel") { togglePanel(true); sendResponse({ ok: true }); return; }
    if (msg.type === "scanNow") { scanChannel(); sendResponse({ ok: true }); return; }
    if (msg.type === "setDim") { saveSettings({ dimNoMeta: !!msg.value }); sendResponse({ ok: true }); return; }
    if (msg.type === "clearPageResults") {
      records.clear();
      checked = Object.create(null);
      targets.forEach(function (l, k) { updateKey(k); });
      updatePanel();
      updateBadge();
      sendResponse({ ok: true });
      return;
    }
  });

  var mo = null;
  function watchDom() {
    if (mo || !document.body) { return; }
    mo = new MutationObserver(function () {
      if (!isEnabled()) { return; }
      clearTimeout(mo.__t);
      mo.__t = setTimeout(function () { collect(); updatePanel(); }, 500);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener("scroll", function (ev) {
    // 浮層內部的捲動（讀提示詞）不應該把浮層關掉
    var p = document.getElementById("dmd-pop");
    var inside = p && ev && ev.target && (ev.target === p || (p.contains && p.contains(ev.target)));
    if (!inside) { closePopover(); }
    if (settings.autoScan) { flushVisible(); }
  }, { passive: true, capture: true });
  window.addEventListener("keydown", function (ev) { if (ev && ev.key === "Escape") { closePopover(); } });
  document.addEventListener("click", function (ev) {
    var p = document.getElementById("dmd-pop");
    if (!p) { return; }
    if (p.contains && ev && p.contains(ev.target)) { return; }
    closePopover();
  }, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { boot(); watchDom(); });
  } else {
    boot(); watchDom();
  }
})();
