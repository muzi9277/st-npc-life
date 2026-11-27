import { KEYS, WB_FIELD_DEFS, WB_PRESETS } from "./constants.js";
import { slimWorldbookEntries, textMentionsNpc } from "./text.js";

export function isOwnWorldbookEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const content = String(entry.content || "").trim();
  if (content.startsWith(KEYS.WORLDBOOK_MARKER)) return true;
  if (entry.extra?.npcLifeV4 === true) return true;
  if (entry.name === KEYS.WORLDBOOK_ENTRY_NAME || entry.comment === KEYS.WORLDBOOK_ENTRY_NAME) return true;
  return false;
}

export function isLegacyBifaEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const name = String(entry.name || entry.comment || "");
  return name === "【彼方】NPC幕后生活" || entry.extra?.bifang === true;
}

function getEntryKeys(entry) {
  const keys = [];
  if (Array.isArray(entry.key)) keys.push(...entry.key);
  if (Array.isArray(entry.keys)) keys.push(...entry.keys);
  if (Array.isArray(entry.strategy?.keys)) keys.push(...entry.strategy.keys);
  return keys.map((k) => String(k || "").trim()).filter(Boolean);
}

function isEntryConstant(entry) {
  return Boolean(entry.constant || entry.strategy?.type === "constant");
}

function isEntryEnabled(entry) {
  if (entry.enabled === false || entry.disable === true) return false;
  return true;
}

function shouldExcludeEntry(entry, excludeKeywords = []) {
  if (!isEntryEnabled(entry)) return true;
  if (isOwnWorldbookEntry(entry) || isLegacyBifaEntry(entry)) return true;
  const title = String(entry.name || entry.comment || "");
  for (const kw of excludeKeywords) {
    const clean = String(kw || "").trim();
    if (clean && title.includes(clean)) return true;
  }
  return false;
}

export async function collectAllRelevantBooks(host) {
  const names = [];
  const bound = host.worldbook.getBoundNames();
  if (bound.primary) names.push(bound.primary);
  for (const extra of bound.additional || []) {
    if (extra && !names.includes(extra)) names.push(extra);
  }
  const chatBook = host.worldbook.getChatWorldbookName();
  if (chatBook && !names.includes(chatBook)) names.push(chatBook);
  return names;
}

/**
 * Read activated & constant worldbook entries relevant to context, then apply token-slim ranking & cap.
 */
export async function readRelevantWorldbook(host, settings, contextText, focusNames = [], trackedNames = []) {
  if (!settings.worldbook?.readEnabled || !host.worldbook.isAvailable()) {
    return { text: "", count: 0, origCount: 0, origChars: 0, keptChars: 0, trimmed: false, rawEntries: [] };
  }
  const books = await collectAllRelevantBooks(host);
  if (!books.length) {
    return { text: "", count: 0, origCount: 0, origChars: 0, keptChars: 0, trimmed: false, rawEntries: [] };
  }

  const hay = String(contextText || "");
  const excludes = settings.worldbook.excludeKeywords || [];
  const activatedTexts = [];
  const rawEntries = [];

  for (const bookName of books) {
    const entries = await host.worldbook.getEntries(bookName);
    for (const entry of entries) {
      if (shouldExcludeEntry(entry, excludes)) continue;
      const content = String(entry.content || "").trim();
      if (!content) continue;
      const keys = getEntryKeys(entry);
      const constant = isEntryConstant(entry);
      const matched = constant || keys.some((k) => hay.includes(k));
      rawEntries.push({ bookName, name: String(entry.name || entry.comment || ""), keys, content, constant });
      if (matched) {
        const title = String(entry.name || entry.comment || "").trim();
        activatedTexts.push(title ? `【${title}】\n${content}` : content);
      }
    }
  }

  const slimmed = slimWorldbookEntries(activatedTexts, focusNames, trackedNames, {
    enabled: settings.cost?.tokenSlimMode !== false,
    worldbookCharCap: settings.cost?.worldbookCharCap || 6000
  });
  return { ...slimmed, rawEntries };
}

/**
 * Find persona entry for a specific NPC from loaded worldbook entries (skipping content already included in wbText).
 */
export function findNpcPersonaRef(rawEntries, npcName, aliases = [], alreadyIncludedText = "") {
  const chunks = [];
  for (const e of rawEntries || []) {
    const titleAndKeys = `${e.name} ${(e.keys || []).join(" ")}`;
    if (!textMentionsNpc(titleAndKeys, npcName, aliases)) continue;
    if (alreadyIncludedText && alreadyIncludedText.includes(e.content.slice(0, 80))) continue;
    chunks.push(e.content);
  }
  return chunks.join("\n\n").trim();
}

export function getActiveWorldbookFields(settings) {
  const mode = settings.worldbook?.injectMode || "full";
  if (mode === "minimal") return [...WB_PRESETS.minimal];
  if (mode === "custom") {
    const list = Array.isArray(settings.worldbook?.customFields) ? settings.worldbook.customFields : [];
    return list.length ? list : [...WB_PRESETS.minimal];
  }
  return [...WB_PRESETS.full];
}

function formatUnfinishedItems(items) {
  if (!Array.isArray(items) || !items.length) return "";
  const active = items.filter((x) => x && x["状态"] === "进行中");
  const done = items.filter((x) => x && x["状态"] === "已完成").slice(-3);
  const parts = [];
  for (const item of active) {
    const time = item["时间"] ? `（${item["时间"]}）` : "";
    parts.push(`${item["编号"] || "#"} 进行中${time}：${item["内容"]}`);
  }
  if (done.length) {
    parts.push(`已办：${done.map((x) => x["结果"] || x["内容"]).join("；")}`);
  }
  return parts.join("; ");
}

/**
 * Format the worldbook entry injected to the main AI.
 * Supports:
 * - Full mode (default): all NPC core fields
 * - Minimal mode: ONLY 位置 / 当前在做 / 当前状态 (clean header, zero promise/summary clutter!)
 * - Custom mode: user-selected columns
 */
export function formatWorldbookEntry(chatState, settings) {
  const activeFields = getActiveWorldbookFields(settings);
  const fieldDefs = WB_FIELD_DEFS.filter((f) => activeFields.includes(f.key));
  const npcs = chatState?.npcs || {};
  const deceased = chatState?.world?.deceased || {};

  const entries = Object.entries(npcs).filter(([name, card]) => {
    if (!card || card.tracked === false) return false;
    if (deceased[name]) return false;
    return true;
  });

  if (!entries.length) return "";

  const hasPromises = activeFields.includes("未完成事项");
  const headerLines = [KEYS.WORLDBOOK_MARKER];
  if (chatState.storyTime) {
    headerLines.push(`【当前剧情时间】${chatState.storyTime}`);
  }

  if (hasPromises) {
    headerLines.push(
      '以下为 NPC 的幕后生活状态（"—" 表示无内容），供保持世界真实感与场景一致性。**严禁全知**：未在当前正文中出场的 NPC 不知道主角刚刚发生的事；仅当剧情需要时自然带出其幕后动态与进行中的约定。'
    );
  } else {
    headerLines.push(
      '以下为 NPC 当前所在位置与正在做的事，供保持世界真实感。**严禁全知**：未在当前正文中出场的 NPC 不知道正文正在发生的事，提及他们时只体现其自然日常状态。'
    );
  }

  const rows = entries.map(([name, card]) => {
    const vals = fieldDefs.map((f) => {
      if (f.key === "未完成事项") return formatUnfinishedItems(card["未完成事项"]);
      return String(card[f.key] || "").trim();
    });
    return { name, vals };
  });

  const nonEmptyCols = fieldDefs
    .map((f, idx) => ({ f, idx }))
    .filter(({ idx }) => rows.some((r) => Boolean(r.vals[idx])));

  if (!nonEmptyCols.length) {
    headerLines.push(...rows.map((r) => `- ${r.name} | 暂无状态`));
  } else {
    headerLines.push(["名字", ...nonEmptyCols.map((c) => c.f.label)].join(" | "));
    for (const r of rows) {
      headerLines.push([r.name, ...nonEmptyCols.map((c) => r.vals[c.idx] || "—")].join(" | "));
    }
  }

  return headerLines.join("\n");
}

/**
 * Sync formatted NPC status table into the configured worldbook (chat / primary / off).
 */
export async function syncWorldbook(host, chatState, settings) {
  if (!host.worldbook.isAvailable()) {
    return { ok: false, skipped: true, reason: "未启用酒馆助手，跳过世界书写入" };
  }

  const target = settings.worldbook?.writeTarget || "chat";
  if (target === "off") {
    const books = await collectAllRelevantBooks(host);
    for (const b of books) {
      await host.worldbook.removeEntries(b, isOwnWorldbookEntry);
    }
    return { ok: true, removed: true };
  }

  let bookName = null;
  if (target === "primary") {
    if (host.chat.isGroupChat()) {
      // Friendly fallback for group chat: auto-use chat worldbook
      bookName = await host.worldbook.getOrCreateChatWorldbook();
    } else {
      bookName = host.worldbook.getBoundNames().primary;
      if (!bookName) {
        bookName = await host.worldbook.getOrCreateChatWorldbook();
      }
    }
  } else {
    bookName = await host.worldbook.getOrCreateChatWorldbook();
  }

  const content = formatWorldbookEntry(chatState, settings);
  if (!content) {
    await host.worldbook.removeEntries(bookName, isOwnWorldbookEntry);
    return { ok: true, empty: true, bookName };
  }

  await host.worldbook.upsertEntry(bookName, isOwnWorldbookEntry, {
    name: KEYS.WORLDBOOK_ENTRY_NAME,
    comment: KEYS.WORLDBOOK_ENTRY_NAME,
    content,
    enabled: true,
    constant: true,
    strategy: { type: "constant", keys: [] },
    position: { type: "before_character_definition", order: 100 },
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    extra: { npcLifeV4: true }
  });

  return { ok: true, bookName, chars: content.length };
}
