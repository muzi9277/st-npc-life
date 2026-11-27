import { GENERIC_TITLES } from "./constants.js";

export function fastHash(input) {
  const str = String(input || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function estimateTokens(input) {
  const str = typeof input === "string" ? input : JSON.stringify(input || "");
  if (!str) return 0;
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 255) cjk++;
  }
  const ascii = str.length - cjk;
  return Math.ceil(cjk * 0.72 + ascii * 0.3);
}

/**
 * Normalize aliases: trim, deduplicate, remove formal name, single-char strings, and generic titles.
 */
export function normalizeAliases(aliases, formalName = "") {
  const formal = String(formalName || "").trim();
  const raw = Array.isArray(aliases)
    ? aliases
    : String(aliases || "")
        .split(/[、,，/|\n]+/)
        .map((s) => s.trim());
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const clean = String(item || "").trim();
    if (!clean || clean.length < 2) continue;
    if (clean === formal) continue;
    if (GENERIC_TITLES.has(clean)) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * Check if an NPC (formal name or any alias) appears in text without swallowing unrelated longer words.
 */
export function textMentionsNpc(text, formalName, aliases = []) {
  const hay = String(text || "");
  if (!hay) return false;
  const formal = String(formalName || "").trim();
  if (formal) {
    if (formal.length >= 2 && hay.includes(formal)) return true;
    if (formal.length === 1) {
      if (/[\u4e00-\u9fff]/.test(formal) && hay.includes(formal)) return true;
      if (/^[A-Za-z0-9]$/.test(formal) && new RegExp(`\\b${formal}\\b`).test(hay)) return true;
    }
  }
  const norm = normalizeAliases(aliases, formal);
  for (const al of norm) {
    if (hay.includes(al)) return true;
  }
  return false;
}

export function detectInSceneNpcs(text, npcsMap = {}) {
  const inScene = [];
  for (const [name, card] of Object.entries(npcsMap || {})) {
    if (!card || card.tracked === false) continue;
    if (textMentionsNpc(text, name, card.aliases)) {
      inScene.push(name);
    }
  }
  return inScene;
}

/**
 * Strip ONLY reasoning/CoT tags and our own parallel block;
 * PRESERVE full story prose AND <status> / <状态栏> / <details> by default!
 * Only truncates if cap > 0 (opt-in by user).
 */
export function cleanReplyText(text, replyCharCap = 0) {
  let out = String(text || "");
  out = out
    .replace(
      /<\s*(think_nya|think|thinking|thought|reasoning|npc_life_parallel)(?=[\s>/])[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
      ""
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const limitNum = Number(replyCharCap);
  if (!Number.isFinite(limitNum) || limitNum <= 0) return out;
  const limit = Math.max(800, Math.round(limitNum));
  if (out.length <= limit) return out;
  const head = Math.floor(limit * 0.35);
  const tail = Math.floor(limit * 0.65);
  return `${out.slice(0, head).trimEnd()}\n…[中间段落已省略]…\n${out.slice(out.length - tail).trimStart()}`;
}

/**
 * Score & trim worldbook entries by relevance to in-scene & tracked NPCs.
 */
export function slimWorldbookEntries(entries, focusNames = [], trackedNames = [], opts = {}) {
  const list = Array.isArray(entries)
    ? entries.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const origChars = list.reduce((acc, s) => acc + s.length, 0);
  const enabled = opts.enabled !== false;
  if (!enabled || !list.length) {
    return {
      text: list.join("\n\n"),
      count: list.length,
      trimmed: false,
      origCount: list.length,
      origChars,
      keptChars: origChars
    };
  }
  const focus = (Array.isArray(focusNames) ? focusNames : []).filter((x) => String(x || "").length >= 2);
  const tracked = (Array.isArray(trackedNames) ? trackedNames : []).filter((x) => String(x || "").length >= 2);
  const singleCap = Math.max(400, Number(opts.singleCap) || 1200);
  const totalCap = Math.max(1000, Math.min(30000, Number(opts.worldbookCharCap) || 6000));

  const scored = list.map((text, idx) => {
    let score = 0;
    for (const n of focus) if (text.includes(n)) score += 10;
    for (const n of tracked) if (text.includes(n)) score += 3;
    return { text, idx, score };
  });
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const kept = [];
  let used = 0;
  let trimmed = false;
  for (const item of scored) {
    let chunk = item.text;
    if (chunk.length > singleCap) {
      chunk = `${chunk.slice(0, singleCap)}…(已截断)`;
      trimmed = true;
    }
    if (kept.length > 0 && used + chunk.length + 2 > totalCap) {
      trimmed = true;
      continue;
    }
    if (kept.length === 0 && chunk.length > totalCap) {
      chunk = `${chunk.slice(0, totalCap)}…(已截断)`;
      trimmed = true;
    }
    kept.push(chunk);
    used += chunk.length + (kept.length > 1 ? 2 : 0);
  }
  return {
    text: kept.join("\n\n"),
    count: kept.length,
    trimmed,
    origCount: list.length,
    origChars,
    keptChars: used
  };
}

const personaRefCache = new Map();

export function resetPersonaRefCache() {
  personaRefCache.clear();
}

/**
 * Attach persona reference ONCE on initial card creation or when worldbook persona text changes.
 * Skips re-sending once card already has a stable 身份锚点 (>= 8 chars) and hash matches.
 */
export function attachPersonaRefSmart(card, npcName, rawRef, opts = {}) {
  const clean = String(rawRef || "").trim();
  if (!card || !clean) return 0;
  if (opts.slim === false) {
    card["人设参考"] = clean;
    return clean.length;
  }
  const key = `${String(opts.chatId || "")}|${String(npcName || "")}`;
  const hash = fastHash(clean);
  const hasAnchor = String(card["身份锚点"] || "").trim().length >= 8;
  if (hasAnchor && personaRefCache.get(key) === hash) return 0;

  const budget = Number.isFinite(Number(opts.remainingBudget)) ? Math.max(0, Number(opts.remainingBudget)) : 600;
  const cap = Math.min(600, budget);
  if (cap < 60) return 0;

  const clipped = clean.length > cap ? `${clean.slice(0, cap)}…(已精简)` : clean;
  card["人设参考"] = clipped;
  personaRefCache.set(key, hash);
  return clipped.length;
}

/**
 * Extract the LATEST date string YYYY-MM-DD from story prose / status bar (handles date ranges crossing midnight).
 */
export function extractStoryDate(text) {
  const s = String(text || "");
  const matches = [...s.matchAll(/(\d{3,4})[-年/.](\d{1,2})[-月/.](\d{1,2})/g)];
  if (!matches.length) return "";
  const last = matches[matches.length - 1];
  const y = last[1].padStart(4, "0");
  const m = last[2].padStart(2, "0");
  const d = last[3].padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseChineseNum(raw) {
  if (!raw) return NaN;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === "半") return 0.5;
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (s.length === 1 && s in map) return map[s];
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? (map[a] ?? 1) : 1;
    const ones = b ? (map[b] ?? 0) : 0;
    return tens * 10 + ones;
  }
  return NaN;
}

/**
 * Parse elapsed days from story date difference OR explicit time-skip phrases (uncapped: supports months/years!).
 */
export function parseElapsedDays(prevDateStr, nextDateStr, text = "") {
  if (prevDateStr && nextDateStr) {
    const p = Date.parse(prevDateStr);
    const n = Date.parse(nextDateStr);
    if (Number.isFinite(p) && Number.isFinite(n) && n > p) {
      return Math.round((n - p) / 86400000);
    }
  }
  const s = String(text || "");
  if (!s) return 0;

  let maxDays = 0;
  const patterns = [
    { re: /半年(?:后|过去|以来|之后|没|未)/g, mult: 180, fixed: 1 },
    { re: /([一二两三四五六七八九十\d]+)\s*年(?:后|过去|以来|之后|没|未)/g, mult: 365 },
    { re: /([一二两三四五六七八九十\d]+)\s*个?月(?:后|过去|以来|之后|没|未)/g, mult: 30 },
    { re: /([一二两三四五六七八九十\d]+)\s*(?:周|星期|礼拜)(?:后|过去|以来|之后|没|未)/g, mult: 7 },
    { re: /([一二两三四五六七八九十\d]+)\s*(?:天|日)(?:后|过去|以来|之后|没|未)/g, mult: 1 },
    { re: /(?:次日|第二天|翌日|隔天|一觉醒来)/g, mult: 1, fixed: 1 }
  ];

  for (const { re, mult, fixed } of patterns) {
    let m;
    while ((m = re.exec(s)) !== null) {
      const val = fixed != null ? fixed : parseChineseNum(m[1]);
      if (Number.isFinite(val) && val > 0) {
        maxDays = Math.max(maxDays, Math.round(val * mult));
      }
    }
  }
  return maxDays;
}
