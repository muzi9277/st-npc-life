import { KEYS, PLUGIN_NAME } from "./constants.js";

/**
 * Unified host adapter for SillyTavern native extensions + optional TavernHelper (JS-Slash-Runner).
 * Designed so core features (chat reading, prompt injection, direct-fetch sub-API, settings)
 * work natively on SillyTavern.getContext(), while worldbook & ST relay seamlessly use TavernHelper when present.
 */
export function createHostAdapter(overrides = {}) {
  const getST = () => {
    if (overrides.st) return overrides.st;
    try {
      return globalThis.SillyTavern?.getContext?.() || null;
    } catch {
      return null;
    }
  };

  const getTH = () => {
    if (overrides.th) return overrides.th;
    return globalThis.TavernHelper || globalThis.window?.TavernHelper || null;
  };

  const toast = {
    info(msg) {
      try {
        globalThis.toastr?.info?.(msg, PLUGIN_NAME);
      } catch {}
    },
    success(msg) {
      try {
        globalThis.toastr?.success?.(msg, PLUGIN_NAME);
      } catch {}
    },
    warn(msg) {
      try {
        globalThis.toastr?.warning?.(msg, PLUGIN_NAME);
      } catch {}
    },
    error(msg) {
      try {
        globalThis.toastr?.error?.(msg, PLUGIN_NAME);
      } catch {}
    }
  };

  const chat = {
    currentChatId() {
      const st = getST();
      if (st && typeof st.getCurrentChatId === "function") {
        try {
          return String(st.getCurrentChatId() || "");
        } catch {}
      }
      if (st?.chatId) return String(st.chatId);
      try {
        if (typeof globalThis.SillyTavern?.getCurrentChatId === "function") {
          return String(globalThis.SillyTavern.getCurrentChatId() || "");
        }
      } catch {}
      return "";
    },

    isGroupChat() {
      const st = getST();
      return Boolean(st?.groupId);
    },

    getRawChat() {
      const st = getST();
      return Array.isArray(st?.chat) ? st.chat : [];
    },

    lastMessageId() {
      const th = getTH();
      if (th && typeof th.getLastMessageId === "function") {
        try {
          const id = Number(th.getLastMessageId());
          if (Number.isFinite(id)) return id;
        } catch {}
      }
      const list = chat.getRawChat();
      return list.length - 1;
    },

    getMessages(fromIdx = 0, toIdx = null) {
      const list = chat.getRawChat();
      if (list.length > 0) {
        const end = toIdx == null ? list.length - 1 : Math.min(list.length - 1, toIdx);
        const start = Math.max(0, fromIdx);
        const out = [];
        for (let i = start; i <= end; i++) {
          const m = list[i];
          if (!m) continue;
          out.push({
            message_id: i,
            role: m.is_user ? "user" : (m.is_system ? "system" : "assistant"),
            name: String(m.name || ""),
            message: String(m.mes ?? m.message ?? ""),
            is_hidden: Boolean(m.is_system),
            swipe_id: Number(m.swipe_id ?? 0)
          });
        }
        return out;
      }
      const th = getTH();
      if (th && typeof th.getChatMessages === "function") {
        try {
          const range = toIdx == null ? `${Math.max(0, fromIdx)}-${Math.max(0, chat.lastMessageId())}` : `${Math.max(0, fromIdx)}-${Math.max(0, toIdx)}`;
          const arr = th.getChatMessages(range) || [];
          return arr.map((m) => ({
            message_id: Number(m.message_id),
            role: m.role || (m.is_user ? "user" : "assistant"),
            name: String(m.name || ""),
            message: String(m.message ?? m.mes ?? ""),
            is_hidden: Boolean(m.is_hidden)
          }));
        } catch {}
      }
      return [];
    },

    getRecentAssistantMessages(count = 2) {
      const all = chat.getMessages(0);
      const filtered = all.filter((m) => m.role === "assistant" && !m.is_hidden && m.message.trim());
      return filtered.slice(-Math.max(1, count));
    },

    getLatestUserMessage() {
      const all = chat.getMessages(0);
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role === "user" && !all[i].is_hidden && all[i].message.trim()) {
          return all[i].message;
        }
      }
      return "";
    },

    getPlayerInfo() {
      const st = getST();
      const th = getTH();
      let name = String(st?.name1 || "");
      let description = "";
      try {
        if (!name && th?.getCurrentPersonaName) name = String(th.getCurrentPersonaName() || "");
      } catch {}
      try {
        if (st?.powerUserSettings?.persona_description) {
          description = String(st.powerUserSettings.persona_description);
        } else if (th?.getPersona) {
          const p = th.getPersona();
          if (typeof p === "string") description = p;
          else if (p && typeof p === "object") description = String(p.description || "");
        }
      } catch {}
      return { name: name.trim(), description: description.trim() };
    }
  };

  const storage = {
    readGlobal(key) {
      const st = getST();
      if (st?.extensionSettings?.[KEYS.EXT_SETTINGS_SLOT]?.[key] !== undefined) {
        return st.extensionSettings[KEYS.EXT_SETTINGS_SLOT][key];
      }
      try {
        if (typeof localStorage !== "undefined") {
          const raw = localStorage.getItem(key);
          if (raw) return JSON.parse(raw);
        }
      } catch {}
      return null;
    },

    writeGlobal(key, value) {
      const st = getST();
      if (st?.extensionSettings) {
        if (!st.extensionSettings[KEYS.EXT_SETTINGS_SLOT]) {
          st.extensionSettings[KEYS.EXT_SETTINGS_SLOT] = {};
        }
        st.extensionSettings[KEYS.EXT_SETTINGS_SLOT][key] = value;
        try {
          st.saveSettingsDebounced?.();
        } catch {}
      }
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(key, JSON.stringify(value));
        }
      } catch {}
      return true;
    },

    readChatMeta(key) {
      const st = getST();
      if (st?.chatMetadata && st.chatMetadata[key] !== undefined) {
        return st.chatMetadata[key];
      }
      const th = getTH();
      if (th?.getVariables) {
        try {
          const vars = th.getVariables({ type: "chat" }) || {};
          if (vars[key] !== undefined) return vars[key];
        } catch {}
      }
      const cid = chat.currentChatId();
      if (cid) {
        try {
          const raw = localStorage.getItem(`${key}:${cid}`);
          if (raw) return JSON.parse(raw);
        } catch {}
      }
      return null;
    },

    writeChatMeta(key, value) {
      const st = getST();
      if (st?.chatMetadata) {
        st.chatMetadata[key] = value;
        try {
          st.saveMetadata?.();
        } catch {}
      }
      const th = getTH();
      if (th?.updateVariablesWith) {
        try {
          th.updateVariablesWith((vars) => {
            vars[key] = value;
            return vars;
          }, { type: "chat" });
        } catch {}
      }
      const cid = chat.currentChatId();
      if (cid) {
        try {
          localStorage.setItem(`${key}:${cid}`, JSON.stringify(value));
        } catch {}
      }
      return true;
    },

    readMessageMeta(floorId, key) {
      const list = chat.getRawChat();
      const msg = list[floorId];
      if (msg?.extra?.[key] !== undefined) return msg.extra[key];
      const th = getTH();
      if (th?.getVariables) {
        try {
          const vars = th.getVariables({ type: "message", message_id: floorId }) || {};
          if (vars[key] !== undefined) return vars[key];
        } catch {}
      }
      return null;
    },

    writeMessageMeta(floorId, key, value) {
      const list = chat.getRawChat();
      const msg = list[floorId];
      if (msg) {
        if (!msg.extra || typeof msg.extra !== "object") msg.extra = {};
        msg.extra[key] = value;
        try {
          getST()?.saveChat?.();
        } catch {}
        return true;
      }
      const th = getTH();
      if (th?.updateVariablesWith) {
        try {
          th.updateVariablesWith((vars) => {
            vars[key] = value;
            return vars;
          }, { type: "message", message_id: floorId });
          return true;
        } catch {}
      }
      return false;
    },

    deleteMessageMeta(floorId, key) {
      const list = chat.getRawChat();
      const msg = list[floorId];
      if (msg?.extra && key in msg.extra) {
        delete msg.extra[key];
        try {
          getST()?.saveChat?.();
        } catch {}
      }
      const th = getTH();
      if (th?.deleteVariable) {
        try {
          th.deleteVariable(key, { type: "message", message_id: floorId });
        } catch {}
      }
    },

    // Read-only helpers for one-way legacy 3.6 Bifa migration
    readLegacyGlobal() {
      const result = { bifaSettings: null, npcLifeSettings: null };
      const th = getTH();
      if (th?.getVariables) {
        try {
          const g = th.getVariables({ type: "global" }) || {};
          if (g["彼方_settings"] && typeof g["彼方_settings"] === "object") {
            result.bifaSettings = g["彼方_settings"];
            if (g["彼方_settings"].npcLife) result.npcLifeSettings = g["彼方_settings"].npcLife;
          }
        } catch {}
      }
      try {
        const raw = localStorage.getItem("npc_life_settings");
        if (raw && !result.npcLifeSettings) result.npcLifeSettings = JSON.parse(raw);
      } catch {}
      return result;
    },

    readLegacyChat() {
      const th = getTH();
      if (!th?.getVariables) return null;
      try {
        const chatVars = th.getVariables({ type: "chat" }) || {};
        const bifaMeta = chatVars["彼方"];
        const floors = Array.isArray(bifaMeta?.["快照楼层"])
          ? [...bifaMeta["快照楼层"]].filter((x) => Number.isSafeInteger(x)).sort((a, b) => b - a)
          : [];
        let latestSnap = null;
        for (const f of floors) {
          const mv = th.getVariables({ type: "message", message_id: f }) || {};
          if (mv["彼方"] && typeof mv["彼方"] === "object") {
            latestSnap = mv["彼方"];
            break;
          }
        }
        const worldData = bifaMeta?.npcLife || latestSnap?.npcLife || null;
        if (!latestSnap && !worldData) return null;
        return { bifaSnap: latestSnap, worldData };
      } catch {
        return null;
      }
    }
  };

  const worldbook = {
    isAvailable() {
      const th = getTH();
      return Boolean(th && typeof th.getWorldbook === "function");
    },

    getBoundNames() {
      const th = getTH();
      if (!th?.getCharWorldbookNames) return { primary: null, additional: [] };
      try {
        const res = th.getCharWorldbookNames("current");
        return {
          primary: res?.primary || null,
          additional: Array.isArray(res?.additional) ? res.additional : []
        };
      } catch {
        return { primary: null, additional: [] };
      }
    },

    getChatWorldbookName() {
      const th = getTH();
      if (!th?.getChatWorldbookName) return null;
      try {
        return th.getChatWorldbookName("current") || null;
      } catch {
        return null;
      }
    },

    async getOrCreateChatWorldbook() {
      const th = getTH();
      if (!th?.getOrCreateChatWorldbook) {
        throw new Error("需要启用「酒馆助手（JS-Slash-Runner）」才能自动读写聊天世界书");
      }
      return await th.getOrCreateChatWorldbook("current");
    },

    async getEntries(bookName) {
      const th = getTH();
      if (!th?.getWorldbook || !bookName) return [];
      try {
        const list = await th.getWorldbook(bookName);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },

    async upsertEntry(bookName, matcher, entryData) {
      const th = getTH();
      if (!th?.updateWorldbookWith || !th?.createWorldbookEntries) {
        throw new Error("缺少世界书写入接口（请确保已安装并启用酒馆助手）");
      }
      const existing = await worldbook.getEntries(bookName);
      const found = existing.find(matcher);
      if (found) {
        await th.updateWorldbookWith(bookName, (entries) =>
          entries.map((e) => (matcher(e) ? { ...e, ...entryData } : e))
        );
      } else {
        await th.createWorldbookEntries(bookName, [entryData]);
      }
    },

    async removeEntries(bookName, matcher) {
      const th = getTH();
      if (!th?.deleteWorldbookEntries || !bookName) return;
      try {
        await th.deleteWorldbookEntries(bookName, matcher);
      } catch {}
    }
  };

  const prompt = {
    async setInjection(content, depth = 3) {
      const st = getST();
      if (!st || typeof st.setExtensionPrompt !== "function") return false;
      const types = st.extension_prompt_types || { IN_CHAT: 1 };
      const roles = st.extension_prompt_roles || { SYSTEM: 0 };
      const safeDepth = Number.isFinite(Number(depth)) ? Math.max(0, Math.min(10, Math.round(Number(depth)))) : 3;
      const res = st.setExtensionPrompt(
        KEYS.PROMPT_INJECT_ID,
        String(content || ""),
        types.IN_CHAT ?? 1,
        safeDepth,
        false,
        roles.SYSTEM ?? 0
      );
      if (res && typeof res.then === "function") await res;
      return true;
    },

    expandMacros(text) {
      const str = String(text || "");
      const th = getTH();
      if (th?.substitudeMacros) {
        try {
          return String(th.substitudeMacros(str));
        } catch {}
      }
      const st = getST();
      if (st?.substituteParams) {
        try {
          return String(st.substituteParams(str));
        } catch {}
      }
      return str;
    }
  };

  const events = {
    on(eventName, handler) {
      const st = getST();
      if (st?.eventSource?.on && eventName) {
        st.eventSource.on(eventName, handler);
        return () => st.eventSource.removeListener?.(eventName, handler);
      }
      return () => {};
    },
    types() {
      const st = getST();
      return st?.event_types || {
        MESSAGE_RECEIVED: "message_received",
        GENERATION_STARTED: "generation_started",
        MESSAGE_SWIPED: "message_swiped",
        MESSAGE_DELETED: "message_deleted",
        MESSAGE_EDITED: "message_edited",
        CHAT_CHANGED: "chat_changed"
      };
    }
  };

  return {
    getST,
    getTH,
    toast,
    chat,
    storage,
    worldbook,
    prompt,
    events
  };
}
