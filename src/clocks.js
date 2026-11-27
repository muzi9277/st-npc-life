import { CLOCK_OUTCOMES } from "./constants.js";
import { callSubApi, parseJsonRobust } from "./api.js";
import { extractStoryDate, fastHash, parseElapsedDays, textMentionsNpc } from "./text.js";

const RISK_KEYWORDS = [
  "囚禁", "软禁", "饿死", "断粮", "绝食", "重伤", "毒发", "剧毒", "病危", "绝症",
  "失踪", "被捕", "处决", "斩首", "死刑", "流放", "叛变", "背叛", "远行", "离开",
  "期限", "最后期限", "活不过", "撑不过", "没人照料", "无人照顾", "倒计时"
];

export function isDeceased(chatState, npcName) {
  return Boolean(chatState?.world?.deceased?.[npcName]);
}

/**
 * Collect legacy items & unfinished promises from a dying NPC into tangible scene traces.
 */
function extractDeathTraces(card) {
  if (!card || typeof card !== "object") return [];
  const traces = [];
  const items = Array.isArray(card["未完成事项"]) ? card["未完成事项"] : [];
  for (const item of items) {
    if (item && item["状态"] === "进行中" && item["内容"]) {
      traces.push(`未竟遗愿/约定：${item["内容"]}`);
    }
  }
  const belongings = String(card["衣物/随身物"] || "").trim();
  if (belongings) {
    traces.push(`随身遗物：${belongings}`);
  }
  const plan = String(card["藏起来的打算"] || "").trim();
  if (plan) {
    traces.push(`生前未说出口的盘算（仅线索可察）：${plan}`);
  }
  return traces.slice(0, 6);
}

/**
 * Unified death archival for BOTH fate-clock expiration AND prose-triggered deaths.
 * Converts unfinished promises/belongings into scene traces and seeds an info-gap rumor if unwitnessed.
 */
export function recordDeath(chatState, { npc, reason = "", location = "", clockId = "", revealed = false, storyTime = "" }) {
  const name = String(npc || "").trim();
  if (!name) return null;
  const world = chatState.world;
  const card = chatState.npcs?.[name];
  const loc = String(location || card?.["位置"] || "").trim();
  const traces = extractDeathTraces(card);

  const info = {
    at: String(storyTime || chatState.storyTime || "未知时间"),
    reason: String(reason || "意外离世").trim(),
    clockId: String(clockId || ""),
    location: loc,
    revealed: Boolean(revealed),
    revealedAt: revealed ? String(storyTime || chatState.storyTime || "") : "",
    traces
  };
  world.deceased[name] = info;

  if (card) {
    card["当前状态"] = `已故（${info.reason}）`;
    card["当前在做"] = "已离世";
    if (Array.isArray(card["未完成事项"])) {
      for (const item of card["未完成事项"]) {
        if (item && item["状态"] === "进行中") {
          item["状态"] = "已作废";
          item["结果"] = `当事人已故（转为现场遗留痕迹）`;
        }
      }
    }
  }

  // Remove dead NPC from active approach queue
  world.queue = (world.queue || []).filter((q) => q && q.npc !== name);

  // If unwitnessed off-stage death, seed a subtle info-gap rumor instead of instant omniscience
  if (!revealed) {
    const clue = loc
      ? `有人留意到「${loc}」一带多日不见${name}露面，隐约觉得出了变故`
      : `附近街坊隐约议论，说已好些日子没见到${name}的踪影`;
    if (!world.rumors.some((r) => r.originNpc === name && r.content === clue)) {
      world.rumors.push({
        id: `rm_dead_${Date.now().toString(36)}`,
        originNpc: name,
        location: loc,
        content: clue,
        hops: 0,
        heardBy: [name],
        createdAt: Date.now()
      });
    }
  }
  return info;
}

export function preScreenClockCandidate(text) {
  const s = String(text || "");
  if (s.length < 15) return false;
  return RISK_KEYWORDS.some((kw) => s.includes(kw));
}

export function createClock(input = {}) {
  const outcome = CLOCK_OUTCOMES[input.outcome] ? input.outcome : "dead";
  const deadlineDays = Math.max(1, Math.round(Number(input.deadlineDays) || 14));
  return {
    id: String(input.id || `clk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`),
    npc: String(input.npc || "").trim(),
    location: String(input.location || "").trim(),
    title: String(input.title || "危机倒计时").trim(),
    deadlineDays,
    elapsedDays: Math.max(0, Math.round(Number(input.elapsedDays) || 0)),
    outcome,
    status: String(input.status || "active"), // "active" | "paused" | "triggered" | "resolved"
    revealed: Boolean(input.revealed),
    triggerDetail: String(input.triggerDetail || "").trim(),
    sourceHash: String(input.sourceHash || ""),
    createdAt: Number(input.createdAt) || Date.now()
  };
}

/**
 * Scan worldbook entries incrementally (deduped by hash) for latent fate clocks via sub-API.
 */
export async function scanWorldbookForClocks(host, chatState, settings, rawEntries = [], opts = {}) {
  const world = chatState.world;
  if (!Array.isArray(world.clockScanHashes)) world.clockScanHashes = [];
  const seen = new Set(world.clockScanHashes);

  const candidates = [];
  for (const e of rawEntries || []) {
    const hash = fastHash(`${e.name}|${e.content}`);
    if (seen.has(hash)) continue;
    if (!preScreenClockCandidate(e.content)) {
      world.clockScanHashes.push(hash);
      continue;
    }
    candidates.push({ ...e, hash });
  }

  if (!candidates.length) return { added: 0, scanned: 0 };

  const batch = candidates.slice(0, 6);
  const promptText = batch
    .map((c, idx) => `[${idx + 1}] ${c.name || "条目"}\n${c.content.slice(0, 800)}`)
    .join("\n\n");

  const res = await callSubApi(
    host,
    settings,
    [
      {
        role: "system",
        content:
          '从设定片段中提取「如果主角长期不管就会恶化/死亡/失踪/离开/背叛的定时危机」。只输出严格 JSON：{"clocks":[{"npc":"角色名","location":"地点","title":"简短危机原因","deadlineDays":14,"outcome":"dead|critical|missing|leave|betray"}]}。如果没有明确限时危机，返回 {"clocks":[]}。'
      },
      { role: "user", content: promptText }
    ],
    { kind: "clock-scan", budget: opts.budget, bypassBudget: Boolean(opts.bypassBudget), maxTokens: 600 }
  );

  for (const c of batch) world.clockScanHashes.push(c.hash);
  if (world.clockScanHashes.length > 300) {
    world.clockScanHashes = world.clockScanHashes.slice(-300);
  }

  if (!res.ok) return { added: 0, scanned: batch.length, error: res.error || res.reason };
  const parsed = parseJsonRobust(res.text);
  if (!parsed.ok || !Array.isArray(parsed.data?.clocks)) {
    return { added: 0, scanned: batch.length };
  }

  let added = 0;
  for (const raw of parsed.data.clocks) {
    const npc = String(raw?.npc || "").trim();
    if (!npc) continue;
    const dup = world.clocks.some((c) => c.npc === npc && c.title === String(raw.title || "").trim() && c.status !== "resolved");
    if (dup) continue;
    world.clocks.push(createClock(raw));
    added++;
  }
  return { added, scanned: batch.length };
}

/**
 * Advance all active fate clocks using elapsed story days & check if player returned/cared or revealed triggered fates.
 */
export function advanceFateClocks(chatState, latestText, settings) {
  if (!settings?.livingWorld?.fateClocks) {
    return { elapsedDays: 0, newlyTriggered: [], newlyRevealed: [], resetClocks: [] };
  }

  const world = chatState.world;
  const nextDate = extractStoryDate(latestText) || extractStoryDate(chatState.storyTime);
  const elapsedDays = parseElapsedDays(world.lastStoryDate, nextDate, latestText);
  if (nextDate) world.lastStoryDate = nextDate;

  const text = String(latestText || "");
  const careWords = /(照顾|喂食|送饭|救治|包扎|解毒|释放|放出来|探望|看望|陪伴|安抚|给水|送药)/;
  const newlyTriggered = [];
  const newlyRevealed = [];
  const resetClocks = [];

  for (const clk of world.clocks) {
    if (!clk || clk.status === "paused" || clk.status === "resolved") continue;
    const card = chatState.npcs?.[clk.npc];
    const mentionsNpc = textMentionsNpc(text, clk.npc, card?.aliases || []);
    const mentionsLoc = Boolean(clk.location && clk.location.length >= 2 && text.includes(clk.location));

    if (clk.status === "active") {
      // If player visits/cares before deadline -> reset elapsed timer!
      if ((mentionsNpc || mentionsLoc) && careWords.test(text)) {
        clk.elapsedDays = 0;
        resetClocks.push(clk);
        continue;
      }

      if (elapsedDays > 0) {
        clk.elapsedDays += elapsedDays;
      }

      if (clk.elapsedDays >= clk.deadlineDays) {
        clk.status = "triggered";
        const meta = CLOCK_OUTCOMES[clk.outcome] || CLOCK_OUTCOMES.dead;
        clk.triggerDetail = `${clk.npc}因「${clk.title}」已超过 ${clk.deadlineDays} 天无人干预，触发结果：${meta.label}`;
        newlyTriggered.push(clk);

        if (clk.outcome === "dead") {
          recordDeath(chatState, {
            npc: clk.npc,
            reason: clk.title,
            location: clk.location || card?.["位置"] || "",
            clockId: clk.id,
            revealed: false,
            storyTime: nextDate || chatState.storyTime || ""
          });
        } else if (card) {
          card["当前状态"] = `${meta.label}（${clk.title}）`;
        }
      }
    }

    // Delayed reveal: triggered but hidden until player returns to location or mentions NPC
    if (clk.status === "triggered" && !clk.revealed && (mentionsNpc || mentionsLoc)) {
      clk.revealed = true;
      if (world.deceased[clk.npc]) {
        world.deceased[clk.npc].revealed = true;
        world.deceased[clk.npc].revealedAt = nextDate || chatState.storyTime || "";
      }
      newlyRevealed.push(clk);
    }
  }

  return { elapsedDays, newlyTriggered, newlyRevealed, resetClocks };
}

export function reviveDeceasedNpc(chatState, npcName) {
  const name = String(npcName || "").trim();
  if (!name) return false;
  const world = chatState.world;
  const info = world.deceased?.[name];
  if (info?.clockId) {
    const clk = (world.clocks || []).find((c) => c.id === info.clockId);
    if (clk) {
      clk.status = "active";
      clk.elapsedDays = 0;
      clk.revealed = false;
      clk.triggerDetail = "";
    }
  }
  delete world.deceased[name];
  const card = chatState.npcs?.[name];
  if (card) {
    if (String(card["当前状态"] || "").startsWith("已故")) card["当前状态"] = "恢复正常";
    if (card["当前在做"] === "已离世") card["当前在做"] = "休养中";
    if (Array.isArray(card["未完成事项"])) {
      for (const item of card["未完成事项"]) {
        if (item && item["结果"] === "当事人已故（转为现场遗留痕迹）") {
          item["状态"] = "进行中";
          item["结果"] = "";
        }
      }
    }
  }
  return true;
}

export function reviveOrUndoClock(chatState, clockId) {
  const world = chatState.world;
  const clk = world.clocks.find((c) => c.id === clockId);
  if (!clk) return false;
  clk.status = "active";
  clk.elapsedDays = 0;
  clk.revealed = false;
  clk.triggerDetail = "";
  if (world.deceased[clk.npc]) {
    reviveDeceasedNpc(chatState, clk.npc);
  }
  return true;
}

/**
 * Build anti-resurrection + delayed reveal + scene遗留痕迹 directives for the main model.
 */
export function buildClockMainDirectives(chatState) {
  const world = chatState.world;
  const lines = [];

  const deadEntries = Object.entries(world.deceased || {});
  if (deadEntries.length) {
    lines.push("【已故人物铁律（严禁诈尸）】");
    for (const [name, info] of deadEntries) {
      const traceText =
        Array.isArray(info.traces) && info.traces.length
          ? ` 现场遗留痕迹：${info.traces.join("；")}。`
          : "";
      if (info.revealed) {
        lines.push(
          `- ${name} 已死亡（原因：${info.reason || "危机到期"}），严禁让其作为活人出场、对话或发消息。${traceText}`
        );
      } else {
        lines.push(
          `- ${name} 在幕后已于「${info.location || "原处"}」因「${info.reason || "长期无人干预"}」死亡，但主角**尚未得知**。严禁让其作为活人出现；只有当主角亲临现场、派人打听或触发相关线索时，再自然揭露死讯。${traceText}`
        );
      }
    }
  }

  const triggeredNonDead = (world.clocks || []).filter(
    (c) => c.status === "triggered" && c.outcome !== "dead"
  );
  if (triggeredNonDead.length) {
    lines.push("【已触发的幕后变故】");
    for (const c of triggeredNonDead) {
      const meta = CLOCK_OUTCOMES[c.outcome] || CLOCK_OUTCOMES.missing;
      const visibility = c.revealed
        ? "主角已可感知此变故，请自然衔接。"
        : "主角暂未亲眼见到，严禁直接旁白剧透，等主角前往相关地点或联系对方时再揭晓。";
      lines.push(`- ${c.npc}（${c.location || "某处"}）：${meta.label}——${c.title}。${visibility}`);
    }
  }

  return lines.join("\n");
}
