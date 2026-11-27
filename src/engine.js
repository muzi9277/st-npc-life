import { GENERIC_TITLES, KEYS, createBlankNpcCard } from "./constants.js";
import { callSubApi, createTurnBudget, parseJsonRobust, recordDiagnostic } from "./api.js";
import {
  advanceFateClocks,
  createClock,
  isDeceased,
  recordDeath,
  reviveDeceasedNpc,
  scanWorldbookForClocks
} from "./clocks.js";
import {
  buildMainPromptInjection,
  diffuseRumorsLocal,
  formatActiveWorldTrends,
  pushRumor,
  recordKnows,
  refreshEncounterQueue,
  runIsolatedNpcUpdates,
  upsertWorldTrend
} from "./livingWorld.js";
import {
  loadChatState,
  loadSettings,
  normalizeChatState,
  rollbackToLatestValidFloor,
  sanitizeNpcCard,
  saveChatState,
  saveFloorSnapshot,
  saveSettings
} from "./storage.js";
import {
  attachPersonaRefSmart,
  cleanReplyText,
  detectInSceneNpcs,
  estimateTokens,
  extractStoryDate,
  normalizeAliases
} from "./text.js";
import { findNpcPersonaRef, formatWorldbookEntry, readRelevantWorldbook, syncWorldbook } from "./worldbook.js";

export const COMPACT_SYSTEM_PROMPT = `你是「NPC Life · 活世界」的后台幕后状态引擎：当主角离开 NPC 视野后，让世界里的 NPC 依然按自身逻辑真实生活。
只输出严格 JSON（首个非空白字符必须是 {，最后一个必须是 }；禁止 <think> / <reasoning> / Markdown 代码围栏及任何 JSON 外文本）。

核心铁律（按优先级）：
1. 防全知（最高优先级）：未在最新正文中出场的 NPC 不知道正文里发生的事，也不知晓主角最新输入（除非正文写明传信/转述）。严禁清洗旧卡里已有的真实经历；严禁把未告知的正文事件写入幕后 NPC 任何字段。
2. 主角去中心化：NPC 为自己而活，绝不围绕主角旋转或刻意迎合主角。即使关系紧密，其内心与日程也必须保留自己的事业、烦恼、人际圈与独立追求。
3. 时间推进与反雷同：核心三字段「当前在做 / 当前状态 / 位置」每轮必返，且必须与最新正文时刻一致、真正往前推进（已有计划/目标就落到行动进展上，否则用生活流体现推移，严禁换近义词原地踏步）。
4. 身份锚点与一致性：首次建卡必填「身份锚点」（身份/性格底色/典型一天作息与常来往的人），已有锚点保持稳定；具体名词不可泛化（旧卡写“玩偶/城北药铺”等具体物件地点，严禁改写为“礼物/某处”）。
5. 角色筛选与别名（切勿遗漏在场角色）：凡是在【最新回复】中实际在场互动、对话或有明确戏份的重要角色（无论有正式姓名，还是如“姐姐/管家/老师”这类固定核心称谓），都要**全部识别并平铺建档，严禁漏掉任何一位在场重要角色**！只排除主角本人与无台词纯背景路人/店员。昵称/曾用名合并入原正式名下并写入 "别名" 数组。
6. 增量返回与精炼输出：除核心三字段外，其余字段仅在有实质变化时返回，单字段控制在 1 句话内以防多角色输出被截断；仅确实死亡的已建档角色列入 "移除NPC"（远行/失联绝不移除）。若旧的「藏起来的打算」已实施、暴露或放弃，或「伤势/体力」已痊愈，请显式返回空字符串 "" 清空该字段（或更新为新的下一步打算）。

输出 JSON 结构：
{
  "剧情时间": "YYYY-MM-DD HH:mm（严格以正文为准，无明确时间可省略）",
  "移除NPC": ["仅确实死亡的已追踪角色名"],
  "世界近况": [{"地点":"城北/全域","内容":"公开大事件如戒严/天灾/祭典（仅正文新发生公开大事时返，平时省略）","范围":"公开|传闻"}],
  "新命运钟": [{"npc":"角色名","location":"地点","title":"若无人干预会恶化的定时危机（如中毒/被囚断粮/重伤，无则省略）","deadlineDays":14,"outcome":"dead|critical|missing|leave|betray"}],
  "角色名": {
    "身份锚点": "角色核心底色与典型一天（新建必填）",
    "别名": ["昵称或绰号"],
    "位置": "当前所在具体地点",
    "当前在做": "此刻正在做什么（随时间推进，不雷同）",
    "当前状态": "神态/情绪/外在可观察表现",
    "生活状态": "吃饭/洗漱/睡眠最新时刻（有变化时返）",
    "心事": "情感层：放不下或瞒着的念头（严格防全知）",
    "藏起来的打算": "计划层：没说出口、正在盘算或悄悄动手的下一步",
    "当前目标": "公开/中长期方向（含受挫与调整）",
    "接下来想做": "紧接此刻的下一步（打算找主角可写明）",
    "近期关键事件": "值得跨楼层记住的新经历（YYYY-MM-DD 简述）",
    "未完成事项": [{"编号":"1","状态":"进行中|已完成|已作废","时间":"","内容":"含具体物品/人名/地点的约定","结果":""}],
    "衣物/随身物": "当下穿着与随身具体物件（有变动或新建时返）",
    "伤势/体力": "身体客观伤情或疲惫（无伤留空，不与情绪重复）",
    "传闻": "该角色主动散布或引发的可传播事件（可选）"
  }
}`;

export const FULL_SYSTEM_PROMPT = `你是「NPC Life · 活世界」——维护角色扮演世界幕后状态的系统：当主角离开某位 NPC 的视野后，让世界里的 NPC 依然保持“正在生活”的状态。

核心原则：
0. 主角去中心化（最高基调）：
   - 绝对独立的人格与立场：任何 NPC 严禁刻意讨好或迎合主角，必须保持自身尊严、立场与既定性格，绝不为博取主角好感而降智或违背人设。
   - 动态幕后生活：世界不围绕主角旋转，主角不在场时 NPC 拥有独立动机、轨迹与目标并自主推进；拒绝“主角光环”，主角的选择或不作为都会引发客观后果。
   - 紧密关系也不是主角中心化的通行证：亲密 NPC 的内心世界（心事 / 当前目标 / 藏起来的打算 / 接下来想做）也必须有自己的事业、烦恼、人际圈与追求；无直接新互动时写它自己生活里的内容，不得大部分字段都围着主角转。
1. 时间推进与反雷同：
   - 时间流逝（几十分钟 / 几小时 / 过夜 / 数日 / 数月）必然改变 NPC 状态；所有 NPC 状态时刻必须与【最新回复】结尾时刻一致（不超前不落后），作息贴合昼夜（白天不无故赖床，深夜不无故上班逛街，夜班/病中除外）。
   - 反雷同自检：拿本轮「当前在做 / 位置 / 当前状态」对照旧卡，若只是换近义词原地踏步，必须重写为真正推进后的阶段/地点/行动；已有计划或目标时优先推进这些行动，无更大行动时再以生活流体现推移。
2. 不强行突变，允许行动自然进展：
   - 没有依据就不凭空杀死角色或改写既定关系；若旧卡已有计划、目标、未完成事项或藏起来的打算，则按时间、性格与条件自然推进（正在执行 / 取得进展 / 受挫调整 / 完成）。
3. 深层动机与角色一致性：
   - 行为由深层动机（守护所爱、生存、信念、补偿过往、野心等）驱动，而非表面标签；优先贴合世界书人设（职业、作息、家庭、社交圈），与已发生剧情冲突时以剧情为准；每个字段控制在 1~2 句。
4. 动态字段分工与一致性铁律：
   - 具体名词不可泛化（优先级仅次于防全知）：旧卡写下的具体物品名 / 人名 / 地点 / 约定（如“玩偶”“市二医院”），除非正文明确改换或遗失，必须原样保留，严禁泛化为“礼物 / 东西 / 某处”。
   - 「心事」（情感层：惦记/放不下/瞒着的念头）与「藏起来的打算」（计划层：没说出口的下一步手段）与「当前目标」（公开方向）分工明确；仅在有进展、新牵挂、改主意、动手或淡化时更新，不要因本轮未提及就清空旧心思。若旧的「藏起来的打算」确已实施完毕、被揭穿或彻底放弃，或「伤势/体力」已恢复正常，请显式返回空字符串 "" 予以清空（或改写为新的下一步打算）。
   - 「衣物/随身物」只写当下具体穿戴物件；「伤势/体力」只写身体客观状况（无伤留空，不与「当前状态」的情绪重复）。
5. 重要 NPC 判定、别名与移除：
   - 仅实际出场/说话/行动且有明确姓名的角色才建档（新建一次性补全字段）；主角、无名角色与纯背景路人/店员不建档。
   - 揭示正式姓名或出现昵称/绰号时，统一合并在正式名下并写入「别名」数组（不写单字称呼，不重复建两张卡）。
   - 仅明确死亡的角色列入顶层「移除NPC」；远行、失联、离开故事均不移除，照常在幕后推进生活。
6. 增量更新与「未完成事项」台账：
   - 核心三字段「当前在做 / 当前状态 / 位置」每轮必返；其余字段仅在有实质变化时返回，未返回字段自动沿用旧值。
   - 「未完成事项」只记录离散、可兑现的承诺/待办，内容须带具体物品/人名/地点与明确时间锚；仅当正文演到兑现/放弃，或与主角无关的 NPC 个人事务在幕后确已办完时改为「已完成 / 已作废」并写清「结果」。
7. 防全知铁律（第一优先级，覆盖所有字段）：
   - 每个 NPC 只知道自己亲眼看到、亲耳听到、亲身经历或正文明确写明被告知/传信的事。未出场的 NPC 不知道最新正文与【最新用户输入】里的任何内容，即使以“听说/担心”的形式也不得泄露未告知事件。
   - 旧状态卡内容是其过往亲历，默认可信，严禁以“本轮正文没出现渠道”为由清洗旧记忆；但若旧卡误写入越界信息，本轮应修正为它自己知道的内容。
8. 身份锚点：
   - 新建必填一句话「身份锚点」，概括其独立于主角的身份、性格底色与「典型一天」（几点起、白天在哪、常来往的人），后续只在人设被剧情改写时更新。

输出格式要求：
- 只输出一个完整 JSON 对象，首个非空白字符必须是 {，最后一个必须是 }。禁止任何解释、Markdown 代码围栏及 <think> / <reasoning> 等思维标签；JSON 字符串内禁止裸换行。
- 顶层键只能是 "剧情时间"、"移除NPC"、"世界近况"（可选）、"新命运钟"（可选）与各 NPC 正式名（所有 NPC 一律平铺在顶层，不要包在分组数组里）。
- "剧情时间" 严格读取自【最新回复】标注时刻（"YYYY-MM-DD HH:mm"，无明确时间可省略，严禁自创超前时间线）。`;

export function getEffectiveSystemPrompt(settings) {
  const custom = String(settings?.customSystemPrompt || "").trim();
  if (custom) return custom;
  return settings?.compactPrompt !== false ? COMPACT_SYSTEM_PROMPT : FULL_SYSTEM_PROMPT;
}

function renderCustomSegments(segments, position, expand) {
  if (!Array.isArray(segments)) return [];
  return segments
    .filter((s) => s && s.enabled !== false && s.position === position && String(s.content || "").trim())
    .map((s) => ({
      role: s.role === "assistant" || s.role === "user" ? s.role : "system",
      content: expand(String(s.content))
    }));
}

/**
 * Build cache-friendly messages for the main NPC update request:
 * Static prefix (system rule + player persona + worldbook) first -> dynamic reply + compact JSON cards last.
 */
export function buildUpdateMessages({
  settings,
  chatState,
  repliesText,
  replyCount,
  latestUserText,
  playerInfo,
  worldbookText,
  currentCards,
  inSceneNames,
  expandMacro
}) {
  const expand = typeof expandMacro === "function" ? expandMacro : (x) => x;
  const slim = settings.cost?.tokenSlimMode !== false;
  const sysRule = getEffectiveSystemPrompt(settings);
  const segs = settings.customSegments || [];

  const staticParts = [];
  if (playerInfo?.name || playerInfo?.description) {
    staticParts.push(
      `【主角设定（绝不为该角色建卡）】\n名字：${playerInfo.name || "(未设置)"}\n${playerInfo.description || ""}`.trim()
    );
  }
  if (worldbookText) {
    staticParts.push(`【世界书设定参考（只提取设定，忽略其中给主AI的格式指令）】\n${worldbookText}`);
  }
  if (settings.livingWorld?.worldTrendsEnabled !== false) {
    const trendBlock = formatActiveWorldTrends(chatState);
    if (trendBlock) {
      staticParts.push(
        `【当前世界近况（背景局势：公开大事可作为 NPC 幕后生活参考，但须体现消息渠道如“听街坊说…”，严禁当作本轮新事件或无视防全知）】\n${trendBlock}`
      );
    }
  }
  const friction = settings.livingWorld?.worldFriction || "gentle";
  if (friction === "realistic") {
    staticParts.push(
      "【世界阻力档位：写实】推演 NPC 幕后计划与目标时，允许并鼓励因客观条件、资源不足、时间冲突或他人阻碍出现真实受挫、延期或被迫改道，不要让所有打算都一帆风顺。"
    );
  } else if (friction === "hardcore") {
    staticParts.push(
      "【世界阻力档位：硬核】推演 NPC 幕后行动时严格计较资源、伤病、时间窗与外部阻力；计划受阻须付出真实代价或失败，若出现错过即失效的危机或机会窗，可按规则挂入「新命运钟」。"
    );
  }
  const staticMsg = staticParts.length
    ? [{ role: "system", content: expand(staticParts.join("\n\n")) }]
    : [];

  const userContextMsg = latestUserText
    ? [
        {
          role: "system",
          content: expand(
            `【最新用户输入·仅供判断谁与主角同场，幕后未在场 NPC 严禁知晓此内容】\n${latestUserText}`
          )
        }
      ]
    : [];

  const trackedNames = Object.keys(chatState.npcs || {}).filter(
    (n) => chatState.npcs[n]?.tracked !== false && !isDeceased(chatState, n)
  );
  const cardsJson = slim ? JSON.stringify(currentCards) : JSON.stringify(currentCards, null, 2);

  const autoTrackHint = settings.autoTrack
    ? "自动建档：已开启（可为最新正文中实际出场且有明确姓名的新重要 NPC 建档）。"
    : "【仅更新已追踪 NPC】：自动建档已关闭，严禁为名单外的新角色建档，只返回已追踪名单中的角色。";

  const userBody = [
    `【最近正文回复（共 ${replyCount} 条，最后一条为最新剧情）】\n${repliesText}`,
    chatState.storyTime ? `【上次记录剧情时间】${chatState.storyTime}` : "",
    `【已追踪 NPC 名单】${trackedNames.length ? trackedNames.join("、") : "(暂无)"}`,
    `【本轮疑似在场 NPC】${inSceneNames.length ? inSceneNames.join("、") : "(无)"}`,
    autoTrackHint,
    `【现有幕后状态卡（全量保留，如附带人设参考为只读请勿回写）】\n${cardsJson}`,
    "请严格按系统规则输出本轮更新的纯 JSON 对象："
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = [
    ...renderCustomSegments(segs, "最前", expand),
    { role: "system", content: expand(sysRule) },
    ...staticMsg,
    ...renderCustomSegments(segs, "主提示词之后", expand),
    ...userContextMsg,
    ...renderCustomSegments(segs, "任务之前", expand),
    { role: "user", content: expand(userBody) },
    ...renderCustomSegments(segs, "任务之后", expand),
    ...renderCustomSegments(segs, "最后", expand)
  ];

  if (settings.prefillJson) {
    messages.push({ role: "assistant", content: "{" });
  } else if (messages.length && messages[messages.length - 1].role === "assistant") {
    messages.push({ role: "user", content: "现在按上述规则直接输出 JSON。" });
  }
  return { messages, cardChars: cardsJson.length };
}

function findExistingNpcByNameOrAlias(npcs, rawName) {
  const target = String(rawName || "").trim();
  if (!target) return null;
  if (npcs[target]) return target;
  for (const [formal, card] of Object.entries(npcs)) {
    if (Array.isArray(card?.aliases) && card.aliases.includes(target)) {
      return formal;
    }
  }
  return null;
}

/**
 * Merge 未完成事项 ledger safely:
 * - Status-only updates matching 编号 preserve original 内容 & 时间 (never generalizes concrete nouns!)
 * - New items without 编号 get a unique fresh T# ID without overwriting existing IDs
 * - Keeps active 进行中 items prioritized alongside recent terminal items (cap 12)
 */
function mergeUnfinishedItems(existingList = [], incomingList = [], storyTime = "") {
  const current = Array.isArray(existingList) ? existingList.map((x) => ({ ...x })) : [];
  const usedIds = new Set(current.map((x) => String(x["编号"] || "").trim()).filter(Boolean));
  const nextSeqId = () => {
    let n = current.length + 1;
    while (usedIds.has(`T${n}`) || usedIds.has(String(n))) n++;
    const id = `T${n}`;
    usedIds.add(id);
    return id;
  };

  for (const raw of incomingList || []) {
    if (!raw || typeof raw !== "object") continue;
    const rawId = raw["编号"] != null ? String(raw["编号"]).trim() : "";
    const rawContent = String(raw["内容"] || raw.content || "").trim();
    const rawStatus = String(raw["状态"] || "").trim();
    const rawResult = String(raw["结果"] || "").trim();
    const rawTime = String(raw["时间"] || "").trim();

    let target = rawId ? current.find((x) => String(x["编号"]) === rawId) : null;
    if (!target && rawContent) {
      target = current.find((x) => String(x["内容"]) === rawContent);
    }

    if (target) {
      if (rawStatus) target["状态"] = rawStatus;
      if (rawResult) target["结果"] = rawResult;
      if (!target["时间"] && rawTime) target["时间"] = rawTime;
    } else if (rawContent) {
      const assignedId = rawId && !usedIds.has(rawId) ? rawId : nextSeqId();
      usedIds.add(assignedId);
      current.push({
        编号: assignedId,
        状态: rawStatus || "进行中",
        时间: rawTime || (storyTime ? storyTime.slice(0, 10) : ""),
        内容: rawContent,
        结果: rawResult
      });
    }
  }

  const active = current.filter((x) => x["状态"] === "进行中");
  const closed = current.filter((x) => x["状态"] !== "进行中");
  const keepClosedCount = Math.max(0, 12 - active.length);
  return [...active.slice(-12), ...closed.slice(-keepClosedCount)];
}

/**
 * Append 近期关键事件 FIFO up to 3 lines instead of overwriting previous memories.
 */
function mergeKeyEvents(existingText, incomingText) {
  const next = String(incomingText || "").trim();
  if (!next) return String(existingText || "").trim();
  const prevLines = String(existingText || "")
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const incomingLines = next
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const line of incomingLines) {
    if (!prevLines.some((p) => p === line || p.includes(line))) {
      prevLines.push(line);
    }
  }
  return prevLines.slice(-3).join("\n");
}

/**
 * Merge parsed JSON response from sub-API into chatState safely.
 */
export function mergeUpdateResponse(chatState, parsedData, settings, playerName = "", inSceneNames = []) {
  if (!parsedData || typeof parsedData !== "object") return { changedNpcs: [], addedNpcs: [] };

  const metaKeys = new Set(["剧情时间", "移除NPC", "世界近况", "新命运钟", "storyTime", "removeNpcs"]);
  if (typeof parsedData["剧情时间"] === "string" && parsedData["剧情时间"].trim()) {
    chatState.storyTime = parsedData["剧情时间"].trim();
  } else if (parsedData["剧情时间"] && typeof parsedData["剧情时间"] === "object") {
    const endT = String(parsedData["剧情时间"]["结束"] || parsedData["剧情时间"]["开始"] || "").trim();
    if (endT) chatState.storyTime = endT;
  }

  const removeList = Array.isArray(parsedData["移除NPC"]) ? parsedData["移除NPC"] : [];
  for (const rawDead of removeList) {
    const deadName = typeof rawDead === "string" ? rawDead : rawDead?.npc || rawDead?.name || "";
    const deadReason = typeof rawDead === "object" && rawDead?.reason ? rawDead.reason : "剧情中已确认死亡";
    const formal = findExistingNpcByNameOrAlias(chatState.npcs, deadName);
    if (formal && !chatState.world.deceased[formal]) {
      recordDeath(chatState, {
        npc: formal,
        reason: deadReason,
        location: chatState.npcs[formal]?.["位置"] || "",
        revealed: true,
        storyTime: chatState.storyTime || ""
      });
    }
  }

  // Optional 0-extra-request world trends
  if (settings.livingWorld?.worldTrendsEnabled !== false && Array.isArray(parsedData["世界近况"])) {
    for (const rawT of parsedData["世界近况"]) {
      if (!rawT || typeof rawT !== "object") continue;
      upsertWorldTrend(chatState, {
        location: rawT["地点"] || rawT.location || "全域",
        content: rawT["内容"] || rawT.content || "",
        scope: rawT["范围"] || rawT.scope || "公开",
        storyTime: chatState.storyTime
      });
    }
  }

  // Optional 0-extra-request prose fate clocks
  if (
    settings.livingWorld?.fateClocks &&
    settings.livingWorld?.autoCreateClocksFromProse !== false &&
    Array.isArray(parsedData["新命运钟"])
  ) {
    for (const rawC of parsedData["新命运钟"]) {
      if (!rawC || typeof rawC !== "object") continue;
      const npc = String(rawC.npc || rawC["角色"] || "").trim();
      const title = String(rawC.title || rawC["原因"] || "").trim();
      if (!npc || !title || isDeceased(chatState, npc)) continue;
      const dup = chatState.world.clocks.some(
        (c) => c.npc === npc && c.title === title && c.status !== "resolved"
      );
      if (dup) continue;
      chatState.world.clocks.push(
        createClock({
          npc,
          location: rawC.location || rawC["地点"] || chatState.npcs[npc]?.["位置"] || "",
          title,
          deadlineDays: Number(rawC.deadlineDays || rawC["天数"]) || 14,
          outcome: rawC.outcome || rawC["后果"] || "dead"
        })
      );
    }
  }

  const changedNpcs = [];
  const addedNpcs = [];
  const cleanPlayer = String(playerName || "").trim();

  // Unwrap accidental container keys (e.g. {"NPC": {"A": {...}, "B": {...}}} or {"在场NPC": [{name:"A",...}]})
  const wrapperKeys = new Set(["NPC", "npcs", "NPCs", "角色", "在场NPC", "新建NPC", "更新NPC", "characters"]);
  const flatCandidates = [];
  for (const [rawKey, val] of Object.entries(parsedData)) {
    if (metaKeys.has(rawKey) || !val || typeof val !== "object") continue;
    if (wrapperKeys.has(rawKey)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (!item || typeof item !== "object") continue;
          const nm = String(item.name || item["名字"] || item["角色名"] || item["姓名"] || "").trim();
          if (nm) flatCandidates.push([nm, item]);
        }
      } else {
        for (const [subK, subV] of Object.entries(val)) {
          if (subV && typeof subV === "object" && !Array.isArray(subV)) {
            flatCandidates.push([subK, subV]);
          }
        }
      }
      continue;
    }
    if (!Array.isArray(val)) flatCandidates.push([rawKey, val]);
  }

  for (const [rawKey, val] of flatCandidates) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    if (cleanPlayer && key === cleanPlayer) continue;
    if (GENERIC_TITLES.has(key)) continue;

    const existingName = findExistingNpcByNameOrAlias(chatState.npcs, key);
    if (existingName && isDeceased(chatState, existingName)) continue;

    if (!existingName) {
      if (!settings.autoTrack) continue;
      const newCard = sanitizeNpcCard(key, val);
      chatState.npcs[key] = newCard;
      addedNpcs.push(key);
      changedNpcs.push(key);
    } else {
      const card = chatState.npcs[existingName];
      const strFields = [
        "位置", "当前在做", "当前状态", "生活状态",
        "心事", "藏起来的打算", "当前目标", "接下来想做",
        "衣物/随身物", "伤势/体力"
      ];
      const clearableFields = new Set(["藏起来的打算", "伤势/体力"]);
      const clearSentinelRe = /^(无|没有|暂无|已清空|已解决|已放弃|已暴露|已恢复|痊愈|无伤)$/i;
      // Preserve stable 身份锚点 unless empty or explicitly provided when short
      if (typeof val["身份锚点"] === "string" && val["身份锚点"].trim()) {
        if (!card["身份锚点"] || card["身份锚点"].length < 8) {
          card["身份锚点"] = val["身份锚点"].trim();
        }
      }
      for (const f of strFields) {
        if (typeof val[f] === "string") {
          const trimmed = val[f].trim();
          if (clearableFields.has(f) && (!trimmed || clearSentinelRe.test(trimmed))) {
            card[f] = "";
          } else if (trimmed) {
            card[f] = trimmed;
          }
        }
      }
      if (typeof val["近期关键事件"] === "string" && val["近期关键事件"].trim()) {
        card["近期关键事件"] = mergeKeyEvents(card["近期关键事件"], val["近期关键事件"]);
      }
      const nextAliases = [...(card.aliases || [])];
      if (key !== existingName) nextAliases.push(key);
      if (Array.isArray(val["别名"])) nextAliases.push(...val["别名"]);
      if (Array.isArray(val.aliases)) nextAliases.push(...val.aliases);
      card.aliases = normalizeAliases(nextAliases, existingName);

      if (Array.isArray(val["未完成事项"]) && val["未完成事项"].length) {
        card["未完成事项"] = mergeUnfinishedItems(card["未完成事项"], val["未完成事项"], chatState.storyTime);
      }
      changedNpcs.push(existingName);
    }

    const targetName = existingName || key;
    const card = chatState.npcs[targetName];
    if (typeof val["传闻"] === "string" && val["传闻"].trim()) {
      pushRumor(chatState, {
        originNpc: targetName,
        location: card?.["位置"] || "",
        content: val["传闻"].trim()
      });
    }
    if (inSceneNames.includes(targetName) && card?.["近期关键事件"]) {
      recordKnows(chatState, {
        npc: targetName,
        fact: card["近期关键事件"],
        source: "witness",
        storyTime: chatState.storyTime
      });
    }
  }

  return { changedNpcs, addedNpcs };
}

/**
 * Create the complete stateful NPC Life 4.0 engine bound to a host adapter.
 */
export function createNpcLifeEngine(host) {
  let settings = loadSettings(host);
  let chatState = loadChatState(host);
  const budget = createTurnBudget(settings.cost?.maxSubApiCallsPerTurn ?? 3);

  const listeners = new Set();
  let runningUpdate = null;
  let lastGenGuardKey = "";
  let runningBeforeGen = null;

  const emitChange = () => {
    for (const fn of listeners) {
      try {
        fn({ settings, chatState, budget: budget.snapshot() });
      } catch {}
    }
  };

  const reloadForCurrentChat = () => {
    chatState = loadChatState(host);
    emitChange();
    return chatState;
  };

  const tryLateLegacyMigration = () => {
    let migrated = false;
    if (!host.storage.readGlobal(KEYS.SETTINGS) && !settings._migratedFromLegacy) {
      const nextS = loadSettings(host);
      if (nextS._migratedFromLegacy) {
        settings = nextS;
        budget.reset(budget.snapshot().turnKey, settings.cost?.maxSubApiCallsPerTurn ?? 3);
        migrated = true;
      }
    }
    if (!host.storage.readChatMeta(KEYS.CHAT_STATE) && Object.keys(chatState.npcs || {}).length === 0) {
      const nextC = loadChatState(host);
      if (Object.keys(nextC.npcs || {}).length > 0 || (nextC.world?.clocks || []).length > 0) {
        chatState = nextC;
        migrated = true;
      }
    }
    if (migrated) {
      emitChange();
      handleBeforeGeneration().catch(() => {});
    }
    return migrated;
  };

  const updateSettings = (updater) => {
    const next = typeof updater === "function" ? updater(structuredClone(settings)) : { ...settings, ...updater };
    settings = saveSettings(host, next);
    budget.reset(budget.snapshot().turnKey, settings.cost?.maxSubApiCallsPerTurn ?? 3);
    emitChange();
    return settings;
  };

  const computeNativeInjOpts = () => {
    const wbActive = settings.worldbook?.writeTarget !== "off" && host.worldbook.isAvailable();
    const includeNpcTable = !wbActive && settings.worldbook?.nativeInjectFallback !== false;
    return { wbActive, includeNpcTable, depth: settings.worldbook?.injectDepth ?? 3 };
  };

  const persistState = async (floorId = null, shouldSyncWb = true) => {
    if (Number.isSafeInteger(floorId) && floorId >= 0) {
      chatState = saveFloorSnapshot(host, chatState, floorId);
    } else {
      chatState = saveChatState(host, chatState);
    }
    if (shouldSyncWb) {
      try {
        await syncWorldbook(host, chatState, settings);
      } catch (err) {
        console.warn("[NPCLife v4] 同步世界书失败:", err);
      }
    }
    const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
    const { includeNpcTable, depth } = computeNativeInjOpts();
    const inj = buildMainPromptInjection(chatState, settings, recent, { includeNpcTable });
    await host.prompt.setInjection(inj, depth);
    emitChange();
    return chatState;
  };

  // --- Character CRUD (preserving user's auto-track & manual add/edit/rename workflow) ---
  const addNpc = async (name, fields = {}) => {
    const clean = String(name || "").trim();
    if (!clean) throw new Error("角色名不能为空");
    chatState.npcs[clean] = sanitizeNpcCard(clean, { ...createBlankNpcCard(), ...fields });
    return await persistState(null, true);
  };

  const updateNpc = async (name, fields = {}) => {
    if (!chatState.npcs[name]) throw new Error(`未找到角色「${name}」`);
    chatState.npcs[name] = sanitizeNpcCard(name, { ...chatState.npcs[name], ...fields });
    return await persistState(null, true);
  };

  const renameNpc = async (oldName, newName) => {
    const cleanNew = String(newName || "").trim();
    if (!cleanNew || !chatState.npcs[oldName] || oldName === cleanNew) return chatState;
    const card = chatState.npcs[oldName];
    card.aliases = normalizeAliases([...(card.aliases || []), oldName], cleanNew);
    chatState.npcs[cleanNew] = card;
    delete chatState.npcs[oldName];
    for (const clk of chatState.world.clocks) {
      if (clk.npc === oldName) clk.npc = cleanNew;
    }
    if (chatState.world.deceased[oldName]) {
      chatState.world.deceased[cleanNew] = chatState.world.deceased[oldName];
      delete chatState.world.deceased[oldName];
    }
    for (const k of chatState.world.ledger?.knows || []) {
      if (k.npc === oldName) k.npc = cleanNew;
    }
    for (const q of chatState.world.queue || []) {
      if (q.npc === oldName) q.npc = cleanNew;
    }
    for (const r of chatState.world.rumors || []) {
      if (r.originNpc === oldName) r.originNpc = cleanNew;
      if (Array.isArray(r.heardBy)) {
        r.heardBy = r.heardBy.map((n) => (n === oldName ? cleanNew : n));
      }
    }
    return await persistState(null, true);
  };

  const deleteNpc = async (name) => {
    delete chatState.npcs[name];
    delete chatState.world.deceased[name];
    chatState.world.clocks = chatState.world.clocks.filter((c) => c.npc !== name);
    chatState.world.queue = chatState.world.queue.filter((q) => q.npc !== name);
    return await persistState(null, true);
  };

  const toggleNpcTracked = async (name) => {
    if (!chatState.npcs[name]) return chatState;
    chatState.npcs[name].tracked = chatState.npcs[name].tracked === false;
    return await persistState(null, true);
  };

  const reviveNpc = async (name) => {
    if (!reviveDeceasedNpc(chatState, name)) return chatState;
    return await persistState(null, true);
  };

  const clearCurrentChat = async () => {
    // Prune all saved floor snapshots so cleared NPCs cannot resurrect on future swipe/delete
    for (const floorId of chatState.snapshotFloors || []) {
      host.storage.deleteMessageMeta?.(floorId, KEYS.FLOOR_SNAP);
    }
    chatState = loadChatState({
      ...host,
      storage: { ...host.storage, readChatMeta: () => null, readLegacyChat: () => null }
    });
    return await persistState(null, true);
  };

  const importChatState = async (rawObj) => {
    if (!rawObj || typeof rawObj !== "object" || (!rawObj.npcs && !rawObj.world)) {
      throw new Error("无效的聊天档案 JSON 格式");
    }
    chatState = normalizeChatState(rawObj);
    return await persistState(null, true);
  };

  const getMainInjectionPreview = () => {
    const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
    const { wbActive, includeNpcTable } = computeNativeInjOpts();
    const worldbookText = wbActive ? formatWorldbookEntry(chatState, settings) : "";
    const nativeInjectionText = buildMainPromptInjection(chatState, settings, recent, { includeNpcTable });
    const totalTokens = estimateTokens(worldbookText) + estimateTokens(nativeInjectionText);
    return { worldbookText, worldbookActive: wbActive, nativeInjectionText, totalTokens };
  };

  // --- Main Turn Update (called on MESSAGE_RECEIVED or manual button) ---
  const runUpdateTurn = async ({ force = false, bypassBudget = false } = {}) => {
    if (runningUpdate) return runningUpdate;
    if (!settings.enabled && !force) return { ok: false, skipped: true, reason: "插件已关闭" };

    runningUpdate = (async () => {
      try {
        const recentCount = Math.max(1, Math.min(6, Number(settings.recentReplyCount) || 2));
        const recentMsgs = host.chat.getRecentAssistantMessages(recentCount);
        if (!recentMsgs.length) {
          return { ok: false, skipped: true, reason: "暂无 AI 回复可分析" };
        }

        const latestMsg = recentMsgs[recentMsgs.length - 1];
        const floorId = latestMsg.message_id;
        const replyCap = settings.cost?.tokenSlimMode !== false ? Number(settings.cost?.replyCharCap) || 0 : 0;
        const cleanedReplies = recentMsgs.map((m, idx) => {
          const label = idx === recentMsgs.length - 1 ? "最新回复" : `较早回复 ${idx + 1}`;
          const text = settings.cost?.tokenSlimMode !== false ? cleanReplyText(m.message, replyCap) : m.message;
          return `【${label}】\n${text}`;
        });
        const repliesText = cleanedReplies.join("\n\n");
        const latestClean = cleanReplyText(latestMsg.message, 0);

        if (!force && latestClean.length < (Number(settings.minReplyChars) || 120)) {
          recordDiagnostic({ kind: "update", status: "skipped", detail: `最新回复不足 ${settings.minReplyChars} 字` });
          emitChange();
          return { ok: false, skipped: true, reason: "回复过短" };
        }

        const turnKey = `${host.chat.currentChatId()}|${floorId}`;
        budget.reset(turnKey, settings.cost?.maxSubApiCallsPerTurn ?? 3);

        const inSceneNames = detectInSceneNpcs(latestClean, chatState.npcs);
        const trackedNames = Object.keys(chatState.npcs).filter(
          (n) => chatState.npcs[n]?.tracked !== false && !isDeceased(chatState, n)
        );
        const latestDate = extractStoryDate(latestClean);

        // Optional idle-turn skip (default OFF so off-stage NPCs update every turn)
        if (
          !force &&
          settings.cost?.tokenSlimMode !== false &&
          settings.cost?.skipIdleTurns === true &&
          trackedNames.length > 0 &&
          inSceneNames.length === 0 &&
          (!latestDate || latestDate === chatState.world.lastStoryDate) &&
          floorId - (chatState.lastProcessedFloor || 0) < 2
        ) {
          recordDiagnostic({ kind: "update", status: "skipped", detail: "空转跳过（无在场NPC且时间未推进）" });
          emitChange();
          return { ok: false, skipped: true, reason: "空转跳过" };
        }

        // Advance fate clocks locally (0 API calls)
        advanceFateClocks(chatState, latestClean, settings);

        // Read relevant worldbook entries with relevance ranking + hard cap
        const latestUserText = host.chat.getLatestUserMessage();
        const wbRes = await readRelevantWorldbook(
          host,
          settings,
          [latestUserText, repliesText].filter(Boolean).join("\n\n"),
          inSceneNames,
          trackedNames
        );

        // Optional incremental worldbook fate-clock scan (default OFF)
        if (settings.livingWorld?.fateClocks && settings.livingWorld?.autoScanWorldbook && wbRes.rawEntries.length) {
          await scanWorldbookForClocks(host, chatState, settings, wbRes.rawEntries, { budget });
        }

        // Prepare full NPC cards for prompt + one-time persona ref attachment
        const promptCards = {};
        let refBudget = 2400;
        const chatId = host.chat.currentChatId();
        let includedWb = wbRes.text;

        for (const name of trackedNames) {
          const cardCopy = structuredClone(chatState.npcs[name]);
          if (settings.worldbook?.readEnabled && wbRes.rawEntries.length) {
            const rawRef = findNpcPersonaRef(wbRes.rawEntries, name, cardCopy.aliases, includedWb);
            if (rawRef) {
              const used = attachPersonaRefSmart(cardCopy, name, rawRef, {
                slim: settings.cost?.tokenSlimMode !== false,
                chatId,
                remainingBudget: refBudget
              });
              if (used > 0) {
                refBudget = Math.max(0, refBudget - used);
                includedWb += `\n\n${cardCopy["人设参考"]}`;
              }
            }
          }
          promptCards[name] = cardCopy;
        }

        const playerInfo = host.chat.getPlayerInfo();
        const { messages, cardChars } = buildUpdateMessages({
          settings,
          chatState,
          repliesText,
          replyCount: recentMsgs.length,
          latestUserText,
          playerInfo,
          worldbookText: wbRes.text,
          currentCards: promptCards,
          inSceneNames,
          expandMacro: host.prompt.expandMacros
        });

        // Call sub-API (max 2 attempts only when JSON parse fails; never retry hard API errors)
        let parsed = null;
        let lastRes = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          lastRes = await callSubApi(host, settings, messages, {
            kind: attempt === 1 ? "update" : "update-retry",
            budget,
            bypassBudget: bypassBudget || attempt > 1,
            worldbookChars: wbRes.keptChars || wbRes.text.length,
            cardChars,
            replyChars: repliesText.length
          });
          if (!lastRes.ok) break;
          const rawForParse =
            settings.prefillJson && !String(lastRes.text || "").trim().startsWith("{")
              ? `{${lastRes.text}`
              : lastRes.text;
          const tryParse = parseJsonRobust(rawForParse);
          if (tryParse.ok) {
            parsed = tryParse.data;
            break;
          }
          if (attempt === 2) {
            recordDiagnostic({
              kind: "update",
              status: "error",
              tokens: lastRes.tokens,
              model: settings.api.model,
              detail: tryParse.error || "JSON 解析失败"
            });
          }
        }

        if (!parsed) {
          emitChange();
          return {
            ok: false,
            skipped: Boolean(lastRes?.skipped),
            error: lastRes?.error || lastRes?.reason || "JSON 解析失败"
          };
        }

        const merged = mergeUpdateResponse(chatState, parsed, settings, playerInfo.name, inSceneNames);
        chatState.updateCount = (chatState.updateCount || 0) + 1;
        chatState.lastUpdateAt = Date.now();

        // Local living-world tick (0 extra API calls)
        diffuseRumorsLocal(chatState);
        refreshEncounterQueue(chatState, inSceneNames);

        await persistState(floorId, true);
        return {
          ok: true,
          floorId,
          changedNpcs: merged.changedNpcs,
          addedNpcs: merged.addedNpcs,
          truncated: Boolean(lastRes?.truncated),
          tokens: lastRes?.tokens || 0
        };
      } finally {
        runningUpdate = null;
      }
    })();

    return runningUpdate;
  };

  // --- Before Main Generation (single-flight per turn!) ---
  const handleBeforeGeneration = async () => {
    if (!settings.enabled) {
      await host.prompt.setInjection("", settings.worldbook?.injectDepth ?? 3);
      return;
    }
    const lastId = host.chat.lastMessageId();
    const guardKey = `${host.chat.currentChatId()}|${lastId}`;
    if (runningBeforeGen && lastGenGuardKey === guardKey) {
      return runningBeforeGen;
    }
    lastGenGuardKey = guardKey;
    runningBeforeGen = (async () => {
      try {
        budget.reset(guardKey, settings.cost?.maxSubApiCallsPerTurn ?? 3);
        const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
        const cleanRecent = cleanReplyText(recent, 0);

        if (settings.livingWorld?.enabled && settings.livingWorld?.isolatedNpcCalls) {
          const iso = await runIsolatedNpcUpdates(host, chatState, settings, cleanRecent, { budget });
          if (iso.updated.length) {
            await persistState(null, true);
            return;
          }
        }

        const { includeNpcTable, depth } = computeNativeInjOpts();
        const inj = buildMainPromptInjection(chatState, settings, cleanRecent, { includeNpcTable });
        await host.prompt.setInjection(inj, depth);
        emitChange();
      } finally {
        runningBeforeGen = null;
      }
    })();
    return runningBeforeGen;
  };

  // --- Unified Rollback on Message Delete / Swipe ---
  const handleRollback = async (maxValidFloor = null) => {
    const res = rollbackToLatestValidFloor(host, chatState, maxValidFloor);
    chatState = res.state;
    if (res.rolledBack) {
      try {
        await syncWorldbook(host, chatState, settings);
      } catch {}
      const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
      const { includeNpcTable, depth } = computeNativeInjOpts();
      await host.prompt.setInjection(buildMainPromptInjection(chatState, settings, recent, { includeNpcTable }), depth);
      emitChange();
    }
    return res;
  };

  return {
    getSettings: () => settings,
    getChatState: () => chatState,
    getBudget: () => budget,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reloadForCurrentChat,
    tryLateLegacyMigration,
    updateSettings,
    persistState,
    addNpc,
    updateNpc,
    renameNpc,
    deleteNpc,
    toggleNpcTracked,
    reviveNpc,
    clearCurrentChat,
    importChatState,
    getMainInjectionPreview,
    runUpdateTurn,
    handleBeforeGeneration,
    handleRollback,
    async scanClocksNow() {
      const wb = await readRelevantWorldbook(host, settings, "", [], Object.keys(chatState.npcs));
      const res = await scanWorldbookForClocks(host, chatState, settings, wb.rawEntries, {
        budget,
        bypassBudget: true
      });
      await persistState(null, false);
      return res;
    }
  };
}
