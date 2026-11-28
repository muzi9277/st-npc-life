export const VERSION = "4.1.1";
export const PLUGIN_NAME = "NPC Life · 活世界";

// Brand-new independent storage keys (zero collision with legacy Bifa)
export const KEYS = {
  SETTINGS: "npclife_v4_settings",
  CHAT_STATE: "npclife_v4_chat",
  FLOOR_SNAP: "npclife_v4_snap",
  EXT_SETTINGS_SLOT: "npc_life_v4",
  PROMPT_INJECT_ID: "npc_life_v4_world",
  WORLDBOOK_ENTRY_NAME: "【NPC Life】NPC幕后生活",
  WORLDBOOK_MARKER: "<!-- NPCLIFE_V4_WB -->"
};

export const MAX_FLOOR_SNAPSHOTS = 10;
export const MAX_DIAGNOSTIC_LOGS = 5;
export const MAX_TERMINAL_LEDGER = 25;
export const MAX_RUMORS = 20;
export const MAX_QUEUE = 12;
export const MAX_WORLD_TRENDS = 5;

export const WB_FIELD_DEFS = [
  { key: "身份锚点", label: "身份锚点", group: "core" },
  { key: "位置", label: "位置", group: "minimal" },
  { key: "当前在做", label: "当前在做", group: "minimal" },
  { key: "当前状态", label: "当前状态", group: "minimal" },
  { key: "生活状态", label: "生活状态", group: "core" },
  { key: "近期关键事件", label: "近期关键事件", group: "memory" },
  { key: "未完成事项", label: "未完成事项 / 承诺", group: "promises" },
  { key: "心事", label: "心事", group: "inner" },
  { key: "藏起来的打算", label: "藏起来的打算", group: "inner" },
  { key: "当前目标", label: "当前目标", group: "inner" },
  { key: "接下来想做", label: "接下来想做", group: "inner" },
  { key: "衣物/随身物", label: "衣着 / 随身物", group: "detail" },
  { key: "伤势/体力", label: "伤势 / 体力", group: "detail" }
];

export const WB_PRESETS = {
  // Default full excludes 藏起来的打算 so main AI won't spoil hidden NPC schemes (still opt-in via custom)
  full: WB_FIELD_DEFS.filter((f) => f.key !== "藏起来的打算").map((f) => f.key),
  minimal: ["位置", "当前在做", "当前状态"]
};

export const CLOCK_OUTCOMES = {
  dead: { label: "死亡", icon: "💀", fatal: true },
  critical: { label: "危急", icon: "⚠️", fatal: false },
  missing: { label: "失踪", icon: "🌫️", fatal: false },
  leave: { label: "离开 / 远行", icon: "🧳", fatal: false },
  betray: { label: "反目 / 背叛", icon: "🗡️", fatal: false }
};

export const GENERIC_TITLES = new Set([
  "店员", "小二", "伙计", "服务员", "侍者", "保安", "守卫", "卫兵", "士兵",
  "司机", "车夫", "船夫", "路人", "行人", "市民", "村民", "陌生人", "男人", "女人",
  "老人", "老头", "老太", "小孩", "黑衣人", "神秘人", "摊主", "老板"
]);

export function createDefaultSettings() {
  return {
    version: 4,
    enabled: true,
    autoUpdate: true,
    autoTrack: true,
    minReplyChars: 120,
    recentReplyCount: 2,
    showFloatingButton: true,
    orbAutoHideEdge: true,
    uiLayout: "auto", // "auto" | "desktop" | "mobile"

    // Sub-API config (STRICTLY secondary API only, 0 main-model fallback)
    api: {
      apiurl: "",
      key: "",
      model: "",
      direct: true,
      temperature: 0.5,
      maxTokens: 4096,
      timeoutSec: 90
    },

    // Prompt & custom segments
    compactPrompt: true,
    prefillJson: false,
    customSystemPrompt: "",
    customSegments: [],

    // Worldbook read/write & export filtering (Default: full per user preference; 1-click minimal)
    worldbook: {
      readEnabled: true,
      writeTarget: "chat", // "chat" | "primary" | "off"
      nativeInjectFallback: true, // If worldbook write is off or TavernHelper unavailable, inject NPC table via ST native setExtensionPrompt
      injectDepth: 3, // IN_CHAT depth for ST native setExtensionPrompt (0..10)
      excludeKeywords: [],
      injectMode: "full", // "full" | "minimal" | "custom"
      customFields: [...WB_PRESETS.full]
    },

    // Living world & fate clocks
    livingWorld: {
      enabled: true,
      worldTrendsEnabled: true,
      secretScriptEnabled: true, // Inject in-scene NPCs' hidden plans as actor subtext (max 3, Show Don't Tell)
      worldFriction: "gentle", // "gentle" | "realistic" | "hardcore"
      isolatedNpcCalls: false,
      isolatedMaxNpcs: 3,
      fateClocks: true,
      autoCreateClocksFromProse: true,
      godView: false,
      autoScanWorldbook: false,
      llmRumorRewrite: false
    },

    // Cost control & token slimming
    cost: {
      maxSubApiCallsPerTurn: 3,
      tokenSlimMode: true,
      worldbookCharCap: 6000,
      replyCharCap: 0, // 0 = do not truncate prose (default)
      skipIdleTurns: false // false = off-stage NPCs update every turn (default)
    },

    _migratedFromLegacy: false
  };
}

export function createEmptyChatState() {
  return {
    version: 4,
    storyTime: "",
    lastProcessedFloor: -1,
    updateCount: 0,
    lastUpdateAt: 0,
    npcs: {}, // { [name]: NpcCard }
    world: {
      ledger: { knows: [], events: [] },
      rumors: [],
      queue: [],
      trends: [], // [{ id, location, content, scope, status, storyTime, createdAt }]
      clocks: [],
      deceased: {}, // { [name]: { at, reason, clockId, revealed, revealedAt, location, traces } }
      clockScanHashes: [],
      lastStoryDate: ""
    }
  };
}

export function createBlankNpcCard(overrides = {}) {
  return {
    身份锚点: "",
    aliases: [],
    tracked: true,
    位置: "",
    当前在做: "",
    当前状态: "",
    生活状态: "",
    心事: "",
    藏起来的打算: "",
    当前目标: "",
    接下来想做: "",
    近期关键事件: "",
    未完成事项: [],
    "衣物/随身物": "",
    "伤势/体力": "",
    ...overrides
  };
}
