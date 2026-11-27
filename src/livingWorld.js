import { KEYS, MAX_QUEUE, MAX_RUMORS, MAX_TERMINAL_LEDGER, MAX_WORLD_TRENDS } from "./constants.js";
import { callSubApi, parseJsonRobust } from "./api.js";
import { buildClockMainDirectives, isDeceased } from "./clocks.js";
import { detectInSceneNpcs } from "./text.js";
import { formatWorldbookEntry } from "./worldbook.js";

/**
 * Record a witnessed / heard fact in the info-gap ledger (knows).
 * Trims terminal rows to last 25 while preserving pending rows.
 */
export function recordKnows(chatState, { npc, fact, source = "witness", storyTime = "" }) {
  if (!npc || !fact || isDeceased(chatState, npc)) return;
  const knows = chatState.world.ledger.knows;
  const dup = knows.some((k) => k.npc === npc && k.fact === fact);
  if (dup) return;
  knows.push({
    id: `kn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    npc,
    fact: String(fact).trim(),
    source, // "witness" | "rumor" | "self"
    status: "active",
    storyTime
  });
  trimLedger(chatState);
}

export function trimLedger(chatState) {
  const knows = chatState.world.ledger.knows;
  const active = knows.filter((k) => k.status !== "done");
  const done = knows.filter((k) => k.status === "done").slice(-MAX_TERMINAL_LEDGER);
  chatState.world.ledger.knows = [...active.slice(-60), ...done];
}

/**
 * Local-first rumor distortion (0 LLM calls by default).
 */
export function distortRumorLocally(text, hops = 1) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  const prefixes = [
    "坊间隐约有人议论，说",
    "听路过的人含糊提了一嘴，好像",
    "圈子里传得有点走样，有人说",
    "不知哪儿传出的风声，称"
  ];
  const prefix = prefixes[hops % prefixes.length];
  return `${prefix}${clean.replace(/^据说|^听说/, "")}`;
}

export function pushRumor(chatState, { originNpc, location, content, isSecret = false }) {
  const rumors = chatState.world.rumors;
  const body = isSecret ? `有模糊风声提及${location || "某处"}似有异动` : String(content || "").trim();
  if (!body) return;
  if (rumors.some((r) => r.content === body && r.originNpc === originNpc)) return;
  rumors.push({
    id: `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    originNpc: originNpc || "",
    location: location || "",
    content: body,
    hops: 0,
    heardBy: originNpc ? [originNpc] : [],
    createdAt: Date.now()
  });
  if (rumors.length > MAX_RUMORS) chatState.world.rumors = rumors.slice(-MAX_RUMORS);
}

/**
 * Diffuse rumors locally to NPCs sharing the same location (0 API calls by default).
 */
export function diffuseRumorsLocal(chatState) {
  const npcs = chatState.npcs || {};
  const rumors = chatState.world.rumors || [];
  let propagated = 0;

  for (const rumor of rumors) {
    if (rumor.hops >= 3) continue;
    for (const [name, card] of Object.entries(npcs)) {
      if (!card || card.tracked === false || isDeceased(chatState, name)) continue;
      if (rumor.heardBy.includes(name)) continue;
      const npcLoc = String(card["位置"] || "").trim();
      if (!rumor.location || !npcLoc || npcLoc !== rumor.location) continue;
      rumor.heardBy.push(name);
      rumor.hops += 1;
      recordKnows(chatState, {
        npc: name,
        fact: distortRumorLocally(rumor.content, rumor.hops),
        source: "rumor",
        storyTime: chatState.storyTime
      });
      propagated++;
    }
  }
  return propagated;
}

/**
 * Update encounter/approach queue cleanly (excluding deceased NPCs, deduping planned actions).
 */
export function refreshEncounterQueue(chatState, inSceneNames = []) {
  const inSceneSet = new Set(inSceneNames);
  const queue = (chatState.world.queue || []).filter((q) => {
    if (!q || !q.npc) return false;
    if (isDeceased(chatState, q.npc)) return false;
    // Mark delivered if NPC just entered the scene
    if (inSceneSet.has(q.npc) && q.status === "pending") {
      q.status = "delivered";
    }
    return q.status === "pending";
  });

  // Promote NPC's "接下来想做" if it clearly intends to seek out the player
  const seekRe = /(去找|联系|拜访|送去|告知|找主角|找你|见面|登门)/;
  for (const [name, card] of Object.entries(chatState.npcs || {})) {
    if (!card || card.tracked === false || isDeceased(chatState, name) || inSceneSet.has(name)) continue;
    const nextPlan = String(card["接下来想做"] || "").trim();
    if (!nextPlan || !seekRe.test(nextPlan)) continue;
    if (queue.some((q) => q.npc === name && q.action === nextPlan)) continue;
    queue.push({
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
      npc: name,
      action: nextPlan,
      status: "pending",
      createdAt: Date.now()
    });
  }

  chatState.world.queue = queue.slice(-MAX_QUEUE);
  return chatState.world.queue;
}

/**
 * Lightweight 0-extra-request World Trends (public events / lockdowns / weather / festivals).
 */
export function upsertWorldTrend(chatState, { location = "", content = "", scope = "公开", storyTime = "" }) {
  const cleanContent = String(content || "").trim();
  if (!cleanContent || cleanContent.length < 4) return null;
  if (!Array.isArray(chatState.world.trends)) chatState.world.trends = [];
  const loc = String(location || "全域").trim();
  const dup = chatState.world.trends.find(
    (t) => t.status === "active" && t.content === cleanContent && t.location === loc
  );
  if (dup) return dup;

  const trend = {
    id: `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    location: loc,
    content: cleanContent,
    scope: scope === "传闻" ? "传闻" : "公开",
    status: "active",
    storyTime: String(storyTime || chatState.storyTime || ""),
    createdAt: Date.now()
  };
  chatState.world.trends.unshift(trend);

  // Keep at most MAX_WORLD_TRENDS active trends + 5 settled history
  const active = chatState.world.trends.filter((t) => t.status === "active").slice(0, MAX_WORLD_TRENDS);
  const settled = chatState.world.trends.filter((t) => t.status !== "active").slice(0, 5);
  chatState.world.trends = [...active, ...settled];
  return trend;
}

export function formatActiveWorldTrends(chatState) {
  const active = (chatState?.world?.trends || []).filter((t) => t && t.status === "active");
  if (!active.length) return "";
  return active
    .map((t) => `- [${t.scope || "公开"}·${t.location || "全域"}] ${t.content}${t.storyTime ? `（${t.storyTime}）` : ""}`)
    .join("\n");
}

/**
 * Build a strictly isolated packet for a single NPC (only their own card + their own known facts!).
 * Off-stage NPCs NEVER receive latest story text involving the player.
 */
export function buildIsolatedNpcPacket(chatState, npcName, latestReply, isInScene) {
  const card = chatState.npcs?.[npcName];
  if (!card) return null;
  const myKnows = (chatState.world.ledger.knows || [])
    .filter((k) => k.npc === npcName && k.status !== "done")
    .slice(-10)
    .map((k) => `[${k.source === "rumor" ? "听闻" : "已知"}] ${k.fact}`);

  const lines = [
    `你现在只负责推演角色「${npcName}」的幕后生活。严格遵守防全知：你只能依据下方该角色自己的档案与已知信息推演，严禁知晓其他角色或主角未告知的事。`,
    `【角色档案】${JSON.stringify(card)}`,
    myKnows.length ? `【该角色已知信息】\n${myKnows.join("\n")}` : "【该角色已知信息】（暂无额外传闻）"
  ];
  if (chatState.storyTime) lines.push(`【当前剧情时间】${chatState.storyTime}`);
  if (isInScene && latestReply) {
    lines.push(`【该角色在场的最新正文】\n${latestReply}`);
  } else {
    lines.push("【状态说明】该角色本轮未与主角同场景，请仅根据其自身日程、心事与目标自然推进幕后生活。");
  }
  lines.push(
    '只输出严格 JSON（不含 Markdown 围栏外的文字）：{"位置":"...","当前在做":"...","当前状态":"...","心事":"...","接下来想做":"...","近期关键事件":"..."}'
  );
  return lines.join("\n\n");
}

/**
 * Run isolated per-NPC updates with strict max cap, skipping deceased NPCs, staggered slightly to reduce 429 bursts.
 */
export async function runIsolatedNpcUpdates(host, chatState, settings, latestReply, opts = {}) {
  const maxNpcs = Math.max(1, Math.min(6, Number(settings.livingWorld?.isolatedMaxNpcs) || 3));
  const inScene = detectInSceneNpcs(latestReply, chatState.npcs);
  const candidates = Object.keys(chatState.npcs || {}).filter(
    (name) => chatState.npcs[name]?.tracked !== false && !isDeceased(chatState, name)
  );
  if (!candidates.length) return { updated: [], totalTokens: 0 };

  // Prioritize in-scene NPCs first, then remaining tracked NPCs up to maxNpcs
  const ordered = [
    ...inScene.filter((n) => candidates.includes(n)),
    ...candidates.filter((n) => !inScene.includes(n))
  ].slice(0, maxNpcs);

  const updated = [];
  let totalTokens = 0;

  const tasks = ordered.map(async (name, idx) => {
    if (idx > 0) await new Promise((r) => setTimeout(r, idx * 250));
    const isIn = inScene.includes(name);
    const packet = buildIsolatedNpcPacket(chatState, name, latestReply, isIn);
    if (!packet) return;

    const res = await callSubApi(
      host,
      settings,
      [
        { role: "system", content: "你是严格的防全知单角色幕后状态更新器。只输出合法 JSON 对象。" },
        { role: "user", content: packet }
      ],
      { kind: `isolated:${name}`, budget: opts.budget, maxTokens: 700, cardChars: JSON.stringify(chatState.npcs[name]).length }
    );
    totalTokens += res.tokens || 0;
    if (!res.ok) return;

    const parsed = parseJsonRobust(res.text);
    if (!parsed.ok || !parsed.data || typeof parsed.data !== "object") return;
    const patch = parsed.data[name] && typeof parsed.data[name] === "object" ? parsed.data[name] : parsed.data;
    const card = chatState.npcs[name];
    if (!card) return;

    for (const k of ["位置", "当前在做", "当前状态", "生活状态", "心事", "当前目标", "接下来想做", "近期关键事件"]) {
      if (typeof patch[k] === "string" && patch[k].trim()) {
        card[k] = patch[k].trim();
      }
    }
    updated.push(name);
  });

  await Promise.all(tasks);
  return { updated, totalTokens };
}

/**
 * Compose the concise living-world prompt injection for the main model via ST setExtensionPrompt.
 * Supports:
 * - Native fallback NPC table when worldbook write is off / unavailable
 * - Anti-resurrection + delayed reveal + scene traces
 * - Public world trends (excludes rumors)
 * - In-scene info-gap boundary + active approach queue
 */
export function buildMainPromptInjection(chatState, settings, recentText = "", opts = {}) {
  if (!settings.enabled) return "";
  const sections = [];

  if (opts.includeNpcTable) {
    const rawTable = formatWorldbookEntry(chatState, settings);
    const cleanTable = rawTable.replace(KEYS.WORLDBOOK_MARKER, "").trim();
    if (cleanTable) sections.push(cleanTable);
  }

  if (settings.livingWorld?.enabled) {
    const clockBlock = buildClockMainDirectives(chatState);
    if (clockBlock) sections.push(clockBlock);

    if (settings.livingWorld?.worldTrendsEnabled !== false) {
      const publicTrends = (chatState.world.trends || [])
        .filter((t) => t && t.status === "active" && t.scope !== "传闻")
        .slice(0, 3);
      if (publicTrends.length) {
        sections.push(
          "【当前世界公开局势（供主剧情保持环境一致，勿强行刷屏）】\n" +
            publicTrends.map((t) => `- [${t.location || "全域"}] ${t.content}`).join("\n")
        );
      }
    }

    const inScene = detectInSceneNpcs(recentText, chatState.npcs);
    const onSceneKnows = (chatState.world.ledger.knows || []).filter(
      (k) => inScene.includes(k.npc) && k.status !== "done" && !isDeceased(chatState, k.npc)
    );
    if (onSceneKnows.length) {
      sections.push(
        "【在场 NPC 的信息边界（仅以下为其真实已知，未提及的幕后情报严禁全知）】\n" +
          onSceneKnows.slice(-8).map((k) => `- ${k.npc}（${k.source === "rumor" ? "听闻" : "亲见"}）：${k.fact}`).join("\n")
      );
    }

    const pendingQueue = (chatState.world.queue || []).filter(
      (q) => q.status === "pending" && !isDeceased(chatState, q.npc)
    );
    if (pendingQueue.length) {
      sections.push(
        "【可能自然触发的主动偶遇 / 来访（若剧情节奏合适可自然安排，勿生硬打断）】\n" +
          pendingQueue.slice(0, 3).map((q) => `- ${q.npc}：${q.action}`).join("\n")
      );
    }
  }

  if (!sections.length) return "";
  return `<npc_life_parallel>\n${sections.join("\n\n")}\n</npc_life_parallel>`;
}
