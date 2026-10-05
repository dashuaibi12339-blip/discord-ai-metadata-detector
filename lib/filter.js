// lib/filter.js —— 關鍵字模糊比對（分詞 + 分隔符歸一化，多個詞需全部命中）
export function getKeywordTokens(keyword) {
  if (!keyword || !String(keyword).trim()) { return []; }
  return String(keyword).trim().split(/[^a-zA-Z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 0);
}

export function normalizeForSearch(text) {
  return String(text || "").replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, " ");
}

// 多個 token 全部命中才算符合（不分大小寫、分隔符視為空白）
export function matchKeyword(searchText, keyword) {
  const tokens = getKeywordTokens(keyword);
  if (tokens.length === 0) { return true; }
  const hay = normalizeForSearch(searchText).toLowerCase();
  for (const t of tokens) {
    if (hay.indexOf(t.toLowerCase()) === -1) { return false; }
  }
  return true;
}
