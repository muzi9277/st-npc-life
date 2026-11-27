import {
  KEYS,
  MAX_FLOOR_SNAPSHOTS,
  WB_PRESETS,
  createBlankNpcCard,
  createDefaultSettings,
  createEmptyChatState
} from "./constants.js";
import { normalizeAliases } from "./text.js";

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergeSettings(raw) {
  const base = createDefaultSettings();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    api: { ...base.api, ...(raw.api || {}) },
    worldbook: {
      ...base.worldbook,
      ...(raw.worldbook || {}),
      excludeKeywords: Array.isArray(raw.worldbook?.excludeKeywords)
        ? raw.worldbook.excludeKeywords
        : base.worldbook.excludeKeywords,
      customFields: Array.isArray(raw.worldbook?.customFields) && raw.worldbook.customFields.length
        ? raw.worldbook.customFields
        : [...WB_PRESETS.full]
    },
    livingWorld: { ...base.livingWorld, ...(raw.livingWorld || {}) },
    cost: { ...base.cost, ...(raw.cost || {}) },
    customSegments: Array.isArray(raw.customSegments) ? raw.customSegments : []
  };
}

/**
 * Sanitize an NPC card (strips legacy physio/romance bloat during migration or model merge).
 */
export function sanitizeNpcCard(name, raw = {}) {
  const card = createBlankNpcCard();
  const src = raw && typeof raw === "object" ? raw : {};
  const strFields = [
    "身份锚点", "位置", "当前在做", "当前状态", "生活状态",
    "心事", "藏起来的打算", "当前目标", "接下来想做", "近期关键事件",
    "衣物/随身物", "伤势/体力"
  ];
  for (const k of strFields) {
    if (src[k] != null) card[k] = String(src[k]).trim();
  }
  const extraAliases = [];
  if (src["曾用名"]) extraAliases.push(String(src["曾用名"]));
  if (Array.isArray(src.aliases)) extraAliases.push(...src.aliases);
  if (Array.isArray(src["别名"])) extraAliases.push(...src["别名"]);
  card.aliases = normalizeAliases(extraAliases, name);
  card.tracked = src.tracked !== false;

  if (Array.isArray(src["未完成事项"])) {
    card["未完成事项"] = src["未完成事项"]
      .filter((x) => x && typeof x === "object" && (x["内容"] || x.content))
      .slice(-12)
      .map((x, idx) => ({
        编号: String(x["编号"] || idx + 1),
        状态: String(x["状态"] || "进行中"),
        时间: String(x["时间"] || ""),
        内容: String(x["内容"] || x.content || "").trim(),
        结果: String(x["结果"] || "").trim()
      }));
  }
  return card;
}

/**
 * Load global v4 settings; on first launch perform one-way non-destructive migration from legacy 3.6 Bifa.
 */
export function loadSettings(host) {
  const saved = host.storage.readGlobal(KEYS.SETTINGS);
  if (saved && typeof saved === "object") {
    return mergeSettings(saved);
  }

  const settings = createDefaultSettings();
  const legacy = host.storage.readLegacyGlobal?.();
  if (legacy && (legacy.bifaSettings || legacy.npcLifeSettings)) {
    const bf = legacy.bifaSettings || {};
    const nl = legacy.npcLifeSettings || {};
    const api = bf["接口"] || {};

    if (api.apiurl) settings.api.apiurl = String(api.apiurl).trim();
    if (api.key) settings.api.key = String(api.key).trim();
    if (api.model) settings.api.model = String(api.model).trim();
    if (typeof api["直连"] === "boolean") settings.api.direct = api["直连"];
    if (Number.isFinite(Number(api["温度"]))) settings.api.temperature = Number(api["温度"]);
    if (Number.isFinite(Number(api["最大令牌"])) && Number(api["最大令牌"]) > 0) {
      settings.api.maxTokens = Number(api["最大令牌"]);
    }

    if (Array.isArray(bf["自定义段"])) {
      settings.customSegments = bf["自定义段"]
        .filter((s) => s && typeof s === "object" && (s["内容"] || s.content))
        .map((s, idx) => ({
          id: String(s.id || `seg_${idx + 1}`),
          name: String(s["名称"] || s.name || `自定义段 ${idx + 1}`),
          role: String(s.role || s["角色"] || "system"),
          position: String(s["位置"] || s.position || "最前"),
          enabled: s["启用"] !== false && s.enabled !== false,
          content: String(s["内容"] || s.content || "")
        }));
    }

    if (bf["更新"]?.["世界书写入"] === "角色卡主世界书") settings.worldbook.writeTarget = "primary";
    else if (bf["更新"]?.["世界书写入"] === "关闭") settings.worldbook.writeTarget = "off";
    else settings.worldbook.writeTarget = "chat";
    if (typeof bf["更新"]?.["预填充"] === "boolean") settings.prefillJson = bf["更新"]["预填充"];

    if (typeof nl.enabled === "boolean") settings.enabled = nl.enabled;
    if (typeof nl.compactPrompt === "boolean") settings.compactPrompt = nl.compactPrompt;
    if (typeof nl.isolatedNpcCalls === "boolean") settings.livingWorld.isolatedNpcCalls = nl.isolatedNpcCalls;
    if (Number.isFinite(Number(nl.isolatedMaxNpcs))) settings.livingWorld.isolatedMaxNpcs = Number(nl.isolatedMaxNpcs);
    if (typeof nl.fateClocks === "boolean") settings.livingWorld.fateClocks = nl.fateClocks;
    if (typeof nl.godView === "boolean") settings.livingWorld.godView = nl.godView;
    if (typeof nl.autoScanWorldbook === "boolean") settings.livingWorld.autoScanWorldbook = nl.autoScanWorldbook;
    if (Number.isFinite(Number(nl.maxSubApiCallsPerTurn))) {
      settings.cost.maxSubApiCallsPerTurn = Math.max(0, Number(nl.maxSubApiCallsPerTurn));
    }
    if (Number.isFinite(Number(nl.worldbookCharCap))) {
      settings.cost.worldbookCharCap = Math.max(1000, Math.min(30000, Number(nl.worldbookCharCap)));
    }
    if (typeof nl.tokenSlimMode === "boolean") settings.cost.tokenSlimMode = nl.tokenSlimMode;

    settings._migratedFromLegacy = true;
    saveSettings(host, settings);
  }
  return settings;
}

export function saveSettings(host, settings) {
  const merged = mergeSettings(settings);
  host.storage.writeGlobal(KEYS.SETTINGS, merged);
  return merged;
}

export function normalizeChatState(raw) {
  const base = createEmptyChatState();
  if (!raw || typeof raw !== "object") return base;
  const npcs = {};
  if (raw.npcs && typeof raw.npcs === "object") {
    for (const [name, card] of Object.entries(raw.npcs)) {
      const cleanName = String(name || "").trim();
      if (!cleanName) continue;
      npcs[cleanName] = sanitizeNpcCard(cleanName, card);
    }
  }
  const w = raw.world && typeof raw.world === "object" ? raw.world : {};
  return {
    ...base,
    storyTime: String(raw.storyTime || ""),
    lastProcessedFloor: Number.isFinite(Number(raw.lastProcessedFloor)) ? Number(raw.lastProcessedFloor) : -1,
    updateCount: Number(raw.updateCount) || 0,
    lastUpdateAt: Number(raw.lastUpdateAt) || 0,
    snapshotFloors: Array.isArray(raw.snapshotFloors)
      ? raw.snapshotFloors.filter((x) => Number.isSafeInteger(x))
      : [],
    npcs,
    world: {
      ledger: {
        knows: Array.isArray(w.ledger?.knows) ? w.ledger.knows : [],
        events: Array.isArray(w.ledger?.events) ? w.ledger.events : []
      },
      rumors: Array.isArray(w.rumors) ? w.rumors : [],
      queue: Array.isArray(w.queue) ? w.queue : [],
      trends: Array.isArray(w.trends) ? w.trends : [],
      clocks: Array.isArray(w.clocks) ? w.clocks : [],
      deceased: w.deceased && typeof w.deceased === "object" ? w.deceased : {},
      clockScanHashes: Array.isArray(w.clockScanHashes) ? w.clockScanHashes : [],
      lastStoryDate: String(w.lastStoryDate || "")
    }
  };
}

/**
 * Load current chat state (with automatic one-way migration from legacy 3.6 chat snapshot if v4 chat state is empty).
 */
export function loadChatState(host) {
  const saved = host.storage.readChatMeta(KEYS.CHAT_STATE);
  if (saved && typeof saved === "object") {
    return normalizeChatState(saved);
  }

  const state = createEmptyChatState();
  state.snapshotFloors = [];

  const legacy = host.storage.readLegacyChat?.();
  if (legacy) {
    const snap = legacy.bifaSnap;
    if (snap?.NPC && typeof snap.NPC === "object") {
      for (const [name, card] of Object.entries(snap.NPC)) {
        state.npcs[name] = sanitizeNpcCard(name, card);
      }
      state.storyTime = String(snap["剧情时间"] || "");
      state.lastProcessedFloor = Number.isFinite(Number(snap["楼层"])) ? Number(snap["楼层"]) : -1;
    }
    const wd = legacy.worldData;
    if (wd && typeof wd === "object") {
      if (Array.isArray(wd.clocks)) state.world.clocks = deepClone(wd.clocks);
      if (wd.deceased && typeof wd.deceased === "object") state.world.deceased = deepClone(wd.deceased);
      if (Array.isArray(wd.clockScanHashes)) state.world.clockScanHashes = [...wd.clockScanHashes];
      if (wd.lastStoryDate) state.world.lastStoryDate = String(wd.lastStoryDate);
      if (Array.isArray(wd.ledger?.knows)) state.world.ledger.knows = deepClone(wd.ledger.knows);
      if (Array.isArray(wd.ledger?.events)) state.world.ledger.events = deepClone(wd.ledger.events);
      if (Array.isArray(wd.rumors)) state.world.rumors = deepClone(wd.rumors);
      if (Array.isArray(wd.queue)) state.world.queue = deepClone(wd.queue);
    }
    saveChatState(host, state);
  }
  return state;
}

export function saveChatState(host, state) {
  const clean = normalizeChatState(state);
  host.storage.writeChatMeta(KEYS.CHAT_STATE, clean);
  return clean;
}

/**
 * Save a unified per-floor snapshot (NPCs + living world + clocks) with a strict 10-floor rolling window.
 * Deletes snapshots older than the last 10 floors so chat .jsonl never bloats!
 */
export function saveFloorSnapshot(host, state, floorId) {
  const clean = normalizeChatState(state);
  if (!Number.isSafeInteger(floorId) || floorId < 0) {
    return saveChatState(host, clean);
  }

  const payload = {
    floor: floorId,
    storyTime: clean.storyTime,
    npcs: deepClone(clean.npcs),
    world: deepClone(clean.world)
  };
  host.storage.writeMessageMeta(floorId, KEYS.FLOOR_SNAP, payload);

  const floors = clean.snapshotFloors.filter((f) => f !== floorId);
  floors.push(floorId);
  floors.sort((a, b) => a - b);

  while (floors.length > MAX_FLOOR_SNAPSHOTS) {
    const oldest = floors.shift();
    host.storage.deleteMessageMeta(oldest, KEYS.FLOOR_SNAP);
  }

  clean.snapshotFloors = floors;
  clean.lastProcessedFloor = floorId;
  return saveChatState(host, clean);
}

/**
 * Roll back BOTH NPC cards AND living world / fate clocks cleanly on message deletion or swipe!
 */
export function rollbackToLatestValidFloor(host, currentState, maxValidFloor = null) {
  const state = normalizeChatState(currentState);
  const lastId = maxValidFloor != null ? maxValidFloor : host.chat.lastMessageId();

  // Remove any snapshot pointers beyond current lastId
  const validFloors = state.snapshotFloors
    .filter((f) => f <= lastId)
    .sort((a, b) => b - a);

  for (const f of validFloors) {
    const snap = host.storage.readMessageMeta(f, KEYS.FLOOR_SNAP);
    if (snap && typeof snap === "object" && snap.npcs) {
      state.npcs = normalizeChatState({ npcs: snap.npcs }).npcs;
      state.world = normalizeChatState({ world: snap.world }).world;
      state.storyTime = String(snap.storyTime || "");
      state.lastProcessedFloor = f;
      state.snapshotFloors = validFloors.slice().sort((a, b) => a - b);
      return { rolledBack: true, floor: f, state: saveChatState(host, state) };
    }
  }

  // No valid snapshot left at or below lastId -> keep structure clean at floor -1
  if (lastId < 0 || state.lastProcessedFloor > lastId) {
    const empty = createEmptyChatState();
    empty.snapshotFloors = [];
    return { rolledBack: true, floor: -1, state: saveChatState(host, empty) };
  }
  return { rolledBack: false, floor: state.lastProcessedFloor, state };
}
