const SCRIPT_ID = "923cea18-89d1-47c1-ac88-13555709f9dc";

function notify(type, message) {
  try {
    const t = globalThis.toastr || window?.toastr;
    if (t && typeof t[type] === "function") {
      t[type](message, "NPC Life");
      return;
    }
  } catch {}
  const fn = type === "error" ? console.error : console.warn;
  fn(`[NPCLife-Ext] ${message}`);
}

function waitForTavernHelper(timeoutMs = 15000, intervalMs = 250) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const th = globalThis.TavernHelper || window?.TavernHelper;
      if (th && typeof th.getVariables === "function") {
        resolve(th);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function buildShim(TH) {
  const fnNames = [
    "getVariables",
    "updateVariablesWith",
    "deleteVariable",
    "insertOrAssignVariables",
    "getChatMessages",
    "getLastMessageId",
    "eventOn",
    "getCharData",
    "getCurrentPersonaName",
    "getPersona",
    "getModelList",
    "generateRaw",
    "stopGenerationById",
    "getCharWorldbookNames",
    "getChatWorldbookName",
    "getOrCreateChatWorldbook",
    "getWorldbook",
    "updateWorldbookWith",
    "createWorldbookEntries",
    "deleteWorldbookEntries",
    "substitudeMacros"
  ];

  const varHelpers = new Set([
    "getVariables",
    "updateVariablesWith",
    "deleteVariable",
    "insertOrAssignVariables"
  ]);

  const shim = {};
  for (const name of fnNames) {
    const rawFn = typeof TH?.[name] === "function"
      ? TH[name].bind(TH)
      : typeof globalThis[name] === "function"
        ? globalThis[name]
        : undefined;

    if (varHelpers.has(name) && rawFn) {
      shim[name] = (...args) => {
        const nextArgs = [...args];
        const optIdx = name === "getVariables" ? 0 : 1;
        const opt = nextArgs[optIdx];
        if (opt && typeof opt === "object" && opt.type === "script" && !opt.script_id) {
          nextArgs[optIdx] = { ...opt, script_id: SCRIPT_ID };
        }
        try {
          return rawFn(...nextArgs);
        } catch (err) {
          if (String(err?.message || err).includes("getScriptId")) {
            return name === "getVariables" ? {} : undefined;
          }
          throw err;
        }
      };
    } else {
      shim[name] = rawFn;
    }
  }

  const stEvents = (() => {
    try {
      return globalThis.SillyTavern?.getContext?.()?.event_types;
    } catch {
      return null;
    }
  })();

  const rawEventOn = shim.eventOn;
  shim.eventOn = (eventName, handler) => {
    if (typeof rawEventOn === "function") {
      try {
        return rawEventOn(eventName, handler);
      } catch (err) {
        if (!String(err?.message || err).includes("getScriptId")) throw err;
      }
    }
    try {
      const es = globalThis.SillyTavern?.getContext?.()?.eventSource;
      if (es && typeof es.on === "function") {
        return es.on(eventName, handler);
      }
    } catch {}
    return undefined;
  };

  shim.tavern_events = globalThis.tavern_events || TH?.tavern_events || stEvents || {};
  shim.getScriptId = () => SCRIPT_ID;
  shim.appendInexistentScriptButtons = () => {};
  shim.getButtonEvent = (name) => `npc_life_btn_${String(name || "")}`;
  shim.EjsTemplate = globalThis.EjsTemplate || TH?.EjsTemplate || {};

  const jq = globalThis.jQuery || globalThis.$;
  if (jq) {
    shim.$ = jq;
    shim.jQuery = jq;
  }

  return shim;
}

async function boot() {
  if (globalThis.__npcLifeExtLoaded) return;
  globalThis.__npcLifeExtLoaded = true;

  try {
    const TH = await waitForTavernHelper(15000, 250);
    if (!TH) {
      notify("warning", "NPC Life 需要先安装并启用「酒馆助手（JS-Slash-Runner）」扩展。");
      return;
    }

    if (globalThis.__npcLifeBifa) {
      notify("warning", "检测到酒馆助手中已启用旧版 NPC Life 脚本，为防冲突已跳过扩展加载。请停用旧脚本后刷新页面。");
      return;
    }

    const coreUrl = new URL("./npc-life-core.js", import.meta.url).href;
    const res = await fetch(coreUrl);
    if (!res.ok) {
      throw new Error(`加载 npc-life-core.js 失败（HTTP ${res.status}）`);
    }
    const code = await res.text();

    if (globalThis.__npcLifeBifa) {
      notify("warning", "检测到酒馆助手中已启用旧版 NPC Life 脚本，为防冲突已跳过扩展加载。请停用旧脚本后刷新页面。");
      return;
    }

    const shim = buildShim(TH);
    const keys = Object.keys(shim);
    const values = keys.map((k) => shim[k]);
    const runner = new Function(...keys, code);
    runner(...values);
  } catch (err) {
    console.error("[NPCLife-Ext] 启动失败:", err);
    notify("error", `启动失败：${err?.message || String(err)}`);
  }
}

boot();
