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

async function boot() {
  if (globalThis.__npcLifeV4Loaded) return;
  globalThis.__npcLifeV4Loaded = true;

  const st = await waitForSillyTavern();
  if (!st) {
    console.warn("[NPCLife v4] 未检测到 SillyTavern 上下文，跳过初始化。");
    return;
  }

  const host = createHostAdapter();
  const engine = createNpcLifeEngine(host);
  const ui = mountUi(host, engine);
  const ev = host.events.types();

  // 1. After AI replies -> run background NPC update if enabled & autoUpdate is on
  host.events.on(ev.MESSAGE_RECEIVED, async () => {
    const s = engine.getSettings();
    if (!s.enabled || !s.autoUpdate) return;
    await engine.runUpdateTurn({ force: false });
  });

  // 2. Before main generation -> single-flight prompt injection + optional isolated NPC side-updates
  host.events.on(ev.GENERATION_STARTED, async () => {
    await engine.handleBeforeGeneration();
  });

  // 3. Swipe / delete / edit -> unified rollback for BOTH NPC cards & living-world/clocks!
  host.events.on(ev.MESSAGE_DELETED, async () => {
    await engine.handleRollback();
  });

  host.events.on(ev.MESSAGE_SWIPED, async () => {
    const lastId = host.chat.lastMessageId();
    // Roll back to snapshot BEFORE the swiped floor so the new swipe starts cleanly
    await engine.handleRollback(Math.max(-1, lastId - 1));
  });

  // 4. Switch chat -> reload independent v4 chat state (and auto-migrate legacy 3.6 chat if first visit)
  host.events.on(ev.CHAT_CHANGED, () => {
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
