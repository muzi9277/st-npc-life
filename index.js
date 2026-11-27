import { VERSION } from "./src/constants.js";
import { createHostAdapter } from "./src/host.js";
import { createNpcLifeEngine } from "./src/engine.js";
import { mountUi } from "./src/ui.js";

function waitForSillyTavern(timeoutMs = 15000, intervalMs = 200) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        if (ctx && ctx.eventSource) {
          resolve(ctx);
          return;
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Wait briefly for optional TavernHelper so legacy 3.6 migration & worldbook are ready at boot
function waitBrieflyForTavernHelper(timeoutMs = 3500, intervalMs = 150) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const th = globalThis.TavernHelper || globalThis.window?.TavernHelper;
      if (th && typeof th.getVariables === "function") {
        resolve(th);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function boot() {
  if (globalThis.__npcLifeV4Loaded) return;
  globalThis.__npcLifeV4Loaded = true;

  const st = await waitForSillyTavern();
  if (!st) {
    console.warn("[NPCLife v4] 未检测到 SillyTavern 上下文，跳过初始化。");
    return;
  }

  await waitBrieflyForTavernHelper();

  const host = createHostAdapter();
  const engine = createNpcLifeEngine(host);
  const ui = mountUi(host, engine);
  const ev = host.events.types();

  let lastAutoTriggeredKey = "";
  let autoTimer = null;

  const scheduleAutoUpdate = (source) => {
    const s = engine.getSettings();
    if (!s.enabled || !s.autoUpdate) return;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      autoTimer = null;
      const latest = host.chat.getRecentAssistantMessages(1)[0];
      if (!latest) return;
      const key = `${host.chat.currentChatId()}|${latest.message_id}|${latest.swipe_id ?? 0}|${latest.message.length}`;
      if (key === lastAutoTriggeredKey) return;
      lastAutoTriggeredKey = key;

      console.info(`[NPCLife v4] 触发自动更新 (${source}, floor=#${latest.message_id})`);
      const orbEl = document.getElementById("nl4-orb");
      orbEl?.classList.add("busy");
      try {
        const res = await engine.runUpdateTurn({ force: false });
        if (res.ok && res.truncated) {
          host.toast.warn("NPC 更新输出被 maxTokens 截断（可能漏掉部分角色），请在「接口」调大最大输出 Token");
        } else if (!res.ok && !res.skipped) {
          host.toast.warn(`自动更新失败：${res.error || res.reason || "请查看设置→诊断日志"}`);
        }
      } catch (err) {
        console.error("[NPCLife v4] 自动更新异常:", err);
      } finally {
        orbEl?.classList.remove("busy");
      }
    }, 350);
  };

  // 1. After AI replies -> listen to both MESSAGE_RECEIVED & CHARACTER_MESSAGE_RENDERED (deduped)
  host.events.on(ev.MESSAGE_RECEIVED, () => scheduleAutoUpdate("MESSAGE_RECEIVED"));
  if (ev.CHARACTER_MESSAGE_RENDERED) {
    host.events.on(ev.CHARACTER_MESSAGE_RENDERED, () => scheduleAutoUpdate("CHARACTER_MESSAGE_RENDERED"));
  }

  // 2. Before main generation -> single-flight prompt injection + optional isolated NPC side-updates
  host.events.on(ev.GENERATION_STARTED, async () => {
    await engine.handleBeforeGeneration();
  });

  // 3. Swipe / delete -> unified rollback for BOTH NPC cards & living-world/clocks!
  host.events.on(ev.MESSAGE_DELETED, async () => {
    lastAutoTriggeredKey = "";
    await engine.handleRollback();
  });

  host.events.on(ev.MESSAGE_SWIPED, async () => {
    lastAutoTriggeredKey = "";
    const lastId = host.chat.lastMessageId();
    await engine.handleRollback(Math.max(-1, lastId - 1));
  });

  // 4. Switch chat -> reload independent v4 chat state
  host.events.on(ev.CHAT_CHANGED, () => {
    lastAutoTriggeredKey = "";
    engine.reloadForCurrentChat();
    engine.handleBeforeGeneration().catch(() => {});
  });

  globalThis.__npcLifeV4 = {
    version: VERSION,
    host,
    engine,
    ui,
    open: () => ui.open()
  };

  console.info(`[NPCLife v4] 已独立启动 v${VERSION}`);
}

if (typeof window !== "undefined") {
  boot().catch((err) => console.error("[NPCLife v4] 启动失败:", err));
}
