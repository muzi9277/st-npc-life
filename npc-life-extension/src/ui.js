import {
  CLOCK_OUTCOMES,
  PLUGIN_NAME,
  VERSION,
  WB_FIELD_DEFS,
  WB_PRESETS
} from "./constants.js";
import {
  getDiagnosticLogs,
  getLastTokenStats,
  isSubApiConfigured,
  testSubApiConnection
} from "./api.js";
import { createClock, isDeceased, reviveOrUndoClock } from "./clocks.js";
import { getEffectiveSystemPrompt } from "./engine.js";
import { detectInSceneNpcs } from "./text.js";
import { syncWorldbook } from "./worldbook.js";

const POS_ORB_KEY = "npclife_v4_orb_pos";
const POS_WIN_KEY = "npclife_v4_win_rect";
const THEME_KEY = "npclife_v4_theme";

const GLOBE_SVG = `<svg class="nl4-globe-svg" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <radialGradient id="nl4GlobeBg" cx="35%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#8be0ff"/>
      <stop offset="52%" stop-color="#2c84b8"/>
      <stop offset="100%" stop-color="#173a5e"/>
    </radialGradient>
  </defs>
  <circle cx="16" cy="16" r="13" fill="url(#nl4GlobeBg)" stroke="#f3c57a" stroke-width="1.4"/>
  <path d="M16 3C19.6 6.8 21.3 11.2 21.3 16C21.3 20.8 19.6 25.2 16 29M16 3C12.4 6.8 10.7 11.2 10.7 16C10.7 20.8 12.4 25.2 16 29" stroke="#e9f7ff" stroke-opacity="0.72" stroke-width="1.15"/>
  <path d="M3.6 16H28.4M5.4 10.2C9.2 11.5 22.8 11.5 26.6 10.2M5.4 21.8C9.2 20.5 22.8 20.5 26.6 21.8" stroke="#e9f7ff" stroke-opacity="0.72" stroke-width="1.15"/>
  <path d="M10.5 8.5C12.3 9.2 13.6 10.8 12.8 12.6C12 14.3 9.4 14.2 8.7 12.5C8.1 11 9.2 9.1 10.5 8.5ZM18.4 14.3C20.5 13.8 23.2 15.2 23.4 17.6C23.5 19.6 21.4 21.6 19.5 21.2C17.8 20.8 17.1 18.8 17.4 17.1C17.6 15.8 17.4 14.6 18.4 14.3Z" fill="#7ee0a8" fill-opacity="0.72"/>
</svg>`;

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function readJsonLS(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonLS(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function mountUi(host, engine) {
  if (typeof document === "undefined") {
    return { open() {}, close() {}, toggle() {}, render() {}, destroy() {} };
  }

  let activeTab = "npcs";
  let isOpen = false;
  let selectedNpc = null;
  let editingNpc = null;
  let busyText = "";
  let theme = readJsonLS(THEME_KEY, "dark") === "light" ? "light" : "dark";

  // Root container
  let root = document.getElementById("nl4-root");
  if (root) root.remove();
  root = document.createElement("div");
  root.id = "nl4-root";
  root.className = "nl4-root";
  root.dataset.theme = theme;
  document.body.appendChild(root);

  // 1. Draggable Floating Globe Orb
  const orb = document.createElement("button");
  orb.id = "nl4-orb";
  orb.type = "button";
  orb.className = "nl4-orb";
  orb.title = `拖动移动 · 点击打开 ${PLUGIN_NAME}`;
  orb.innerHTML = `${GLOBE_SVG}<span class="nl4-orb-dot" id="nl4-orb-dot"></span>`;
  root.appendChild(orb);

  // 2. Draggable & Resizable Book-Ledger Floating Panel (Bifa-inspired)
  const panel = document.createElement("div");
  panel.id = "nl4-panel";
  panel.className = "nl4-panel nl4-hidden";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", PLUGIN_NAME);
  root.appendChild(panel);

  // Apply saved orb position (default bottom-right)
  const applyOrbPos = (pos) => {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const left = clamp(pos?.left ?? vw - 68, 8, Math.max(8, vw - 56));
    const top = clamp(pos?.top ?? vh - 128, 8, Math.max(8, vh - 56));
    orb.style.left = `${left}px`;
    orb.style.top = `${top}px`;
  };
  applyOrbPos(readJsonLS(POS_ORB_KEY));

  // Apply saved or centered window position/size
  const centerPanel = () => {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const w = Math.min(1040, Math.round(vw * 0.92));
    const h = Math.min(720, Math.round(vh - 64));
    const left = Math.max(10, Math.round((vw - w) / 2));
    const top = Math.max(16, Math.round((vh - h) / 2));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
  };

  const applyWinRect = (rect) => {
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
      centerPanel();
      return;
    }
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const w = clamp(rect.width || 980, 560, Math.max(560, vw - 24));
    const h = clamp(rect.height || 680, 420, Math.max(420, vh - 24));
    const left = clamp(rect.left, 6, Math.max(6, vw - 140));
    const top = clamp(rect.top, 6, Math.max(6, vh - 80));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
  };
  applyWinRect(readJsonLS(POS_WIN_KEY));

  // --- Orb Drag vs Click (Pointer Events: works on desktop mouse + mobile touch!) ---
  {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    orb.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = orb.getBoundingClientRect();
      origLeft = r.left;
      origTop = r.top;
      orb.setPointerCapture?.(e.pointerId);
    });

    orb.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        orb.classList.add("dragging");
      }
      if (moved) {
        applyOrbPos({ left: origLeft + dx, top: origTop + dy });
      }
    });

    const finishOrbDrag = () => {
      if (!dragging) return;
      dragging = false;
      orb.classList.remove("dragging");
      if (moved) {
        const r = orb.getBoundingClientRect();
        writeJsonLS(POS_ORB_KEY, { left: Math.round(r.left), top: Math.round(r.top) });
      } else {
        toggle();
      }
    };
    orb.addEventListener("pointerup", finishOrbDrag);
    orb.addEventListener("pointercancel", finishOrbDrag);
  }

  // --- Window Drag (by topbar) & Resize (by corner handle) ---
  {
    let winDrag = null;
    let winResize = null;

    panel.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;

      const resizeHandle = e.target.closest(".nl4-resize");
      if (resizeHandle) {
        const r = panel.getBoundingClientRect();
        winResize = { startX: e.clientX, startY: e.clientY, w: r.width, h: r.height };
        e.preventDefault();
        return;
      }

      const bar = e.target.closest(".nl4-topbar");
      if (bar && !e.target.closest("button, input, select, a")) {
        const r = panel.getBoundingClientRect();
        winDrag = { startX: e.clientX, startY: e.clientY, left: r.left, top: r.top, bar };
        bar.classList.add("dragging");
        e.preventDefault();
      }
    });

    window.addEventListener("pointermove", (e) => {
      if (winDrag) {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const left = clamp(winDrag.left + (e.clientX - winDrag.startX), -200, vw - 120);
        const top = clamp(winDrag.top + (e.clientY - winDrag.startY), 0, vh - 60);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      } else if (winResize) {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const w = clamp(winResize.w + (e.clientX - winResize.startX), 560, vw - 20);
        const h = clamp(winResize.h + (e.clientY - winResize.startY), 420, vh - 20);
        panel.style.width = `${w}px`;
        panel.style.height = `${h}px`;
      }
    });

    const endWinAction = () => {
      if (winDrag || winResize) {
        winDrag?.bar?.classList.remove("dragging");
        const r = panel.getBoundingClientRect();
        writeJsonLS(POS_WIN_KEY, {
          left: Math.round(r.left),
          top: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        });
        winDrag = null;
        winResize = null;
      }
    };
    window.addEventListener("pointerup", endWinAction);
    window.addEventListener("pointercancel", endWinAction);
  }

  const syncOrbStatus = () => {
    const s = engine.getSettings();
    orb.classList.toggle("nl4-hidden", s.showFloatingButton === false);
    orb.classList.toggle("busy", Boolean(busyText));
    const dot = orb.querySelector("#nl4-orb-dot");
    if (dot) dot.classList.toggle("warn", !isSubApiConfigured(s));
  };

  const open = () => {
    isOpen = true;
    panel.classList.remove("nl4-hidden");
    render();
  };

  const close = () => {
    isOpen = false;
    editingNpc = null;
    panel.classList.add("nl4-hidden");
  };

  const toggle = () => (isOpen ? close() : open());

  // Secondary menu entry points (ST #extensionsMenu & #extensions_settings2)
  const mountStEntryPoints = () => {
    const menu = document.getElementById("extensionsMenu");
    if (menu && !document.getElementById("nl4-ext-menu-item")) {
      const item = document.createElement("div");
      item.id = "nl4-ext-menu-item";
      item.className = "list-group-item flex-container flexGap5 interactable";
      item.innerHTML = `<i class="fa-solid fa-earth-asia"></i><span>${esc(PLUGIN_NAME)}</span>`;
      item.addEventListener("click", open);
      menu.appendChild(item);
    }

    const drawer = document.getElementById("extensions_settings2") || document.getElementById("extensions_settings");
    if (drawer && !document.getElementById("nl4-st-drawer-box")) {
      const box = document.createElement("div");
      box.id = "nl4-st-drawer-box";
      box.innerHTML = `
        <div class="inline-drawer">
          <div class="inline-drawer-toggle inline-drawer-header">
            <b>${esc(PLUGIN_NAME)} <small>v${esc(VERSION)}</small></b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>
          <div class="inline-drawer-content">
            <p style="margin:6px 0;opacity:.8;font-size:12px">点击屏幕上的「小地球」悬浮球或下方按钮打开可拖动主面板。</p>
            <button type="button" class="menu_button" id="nl4-open-from-drawer">打开「活世界」浮窗</button>
          </div>
        </div>`;
      box.querySelector("#nl4-open-from-drawer")?.addEventListener("click", open);
      drawer.appendChild(box);
    }
  };

  const renderTopbar = (settings, chatState) => `
    <div class="nl4-topbar" title="按住标题栏可拖动窗口，双击居中复位">
      <div class="nl4-brand">
        <div class="nl4-brand-globe">${GLOBE_SVG}</div>
        <div>
          <h2 class="nl4-title">${esc(PLUGIN_NAME)}</h2>
          <p class="nl4-subtitle">v${esc(VERSION)}${chatState.storyTime ? ` · 剧情时间 ${esc(chatState.storyTime)}` : " · 独立活世界引擎"}</p>
        </div>
      </div>
      <div class="nl4-top-actions">
        <button type="button" class="nl4-btn nl4-btn-primary" data-act="run-now" ${busyText ? "disabled" : ""}>
          ${busyText ? esc(busyText) : "立即更新"}
        </button>
        <button type="button" class="nl4-btn nl4-btn-sm" data-act="toggle-theme" title="切换深色/浅色宣纸主题">${theme === "dark" ? "☀ 宣纸" : "🌙 墨砚"}</button>
        <button type="button" class="nl4-btn nl4-btn-sm" data-act="center-win" title="窗口居中复位">复位</button>
        <button type="button" class="nl4-btn nl4-btn-sm" data-act="close" aria-label="关闭">✕</button>
      </div>
    </div>`;

  const renderRightBookTabs = (chatState) => {
    const npcCount = Object.keys(chatState.npcs || {}).length;
    const activeClocks = (chatState.world?.clocks || []).filter((c) => c.status === "active" || c.status === "triggered").length;
    const tabs = [
      { id: "npcs", label: "人物", badge: npcCount || "" },
      { id: "world", label: "活世界", badge: activeClocks || "" },
      { id: "api", label: "接口", badge: "" },
      { id: "settings", label: "设置", badge: "" }
    ];
    return `
      <nav class="nl4-nav" aria-label="主导航">
        ${tabs
          .map(
            (t) => `
          <button type="button" class="nl4-nav-item ${activeTab === t.id ? "active" : ""}" data-tab="${t.id}">
            ${t.badge ? `<span class="nl4-nav-badge">${esc(t.badge)}</span>` : ""}
            <span class="nl4-nav-label">${esc(t.label)}</span>
          </button>`
          )
          .join("")}
      </nav>`;
  };

  const renderFoot = (settings, budgetSnap) => {
    const apiOk = isSubApiConfigured(settings);
    const routeText = !apiOk
      ? "未配置副 API（绝不调主模型）"
      : `${settings.api.direct !== false ? "直连" : "转发"} · ${settings.api.model}`;
    const lastTok = getLastTokenStats();
    return `
      <div class="nl4-foot">
        <span class="nl4-foot-item"><span class="nl4-dot ${apiOk ? "" : "warn"}"></span>${esc(routeText)}</span>
        <span class="nl4-foot-item">本轮请求：${esc(budgetSnap.used)} / ${esc(budgetSnap.cap)}</span>
        ${
          lastTok
            ? `<span class="nl4-foot-right">上次约 ${esc(lastTok.tokens)} Token（世界书 ${esc(lastTok.worldbookChars)} 字 · 卡片 ${esc(lastTok.cardChars)} 字）</span>`
            : `<span class="nl4-foot-right">拖动标题栏可移动窗口 · 右下角可缩放</span>`
        }
      </div>`;
  };

  // Tab 1: Bifa-style Master/Detail Characters View
  const renderNpcsTab = (settings, chatState) => {
    const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
    const inScene = new Set(detectInSceneNpcs(recent, chatState.npcs));
    const names = Object.keys(chatState.npcs || {});
    if (!selectedNpc || !chatState.npcs[selectedNpc]) {
      selectedNpc = names[0] || null;
    }

    const rosterHtml = names.length
      ? names
          .map((name) => {
            const card = chatState.npcs[name];
            const dead = isDeceased(chatState, name);
            return `
              <button type="button" class="nl4-roster-item ${selectedNpc === name ? "active" : ""} ${dead ? "dead" : ""}" data-select-npc="${esc(name)}">
                <div class="nl4-roster-top">
                  <span class="nl4-roster-name">${esc(name)}</span>
                  <span>
                    ${inScene.has(name) && !dead ? '<span class="nl4-badge nl4-badge-scene">在场</span>' : ""}
                    ${dead ? '<span class="nl4-badge nl4-badge-dead">已故</span>' : ""}
                    ${card.tracked === false ? '<span class="nl4-badge">暂停</span>' : ""}
                  </span>
                </div>
                <div class="nl4-roster-sub">${esc(card["位置"] || "未知")} · ${esc(card["当前在做"] || "—")}</div>
              </button>`;
          })
          .join("")
      : `<div class="nl4-muted" style="padding:12px 4px">暂无角色</div>`;

    let detailHtml = `<div class="nl4-empty">点击左侧角色查看幕后详情，或点击上方「手动添加角色」创建追踪目标。</div>`;
    if (selectedNpc && chatState.npcs[selectedNpc]) {
      const name = selectedNpc;
      const card = chatState.npcs[name];
      const dead = isDeceased(chatState, name);
      const tracked = card.tracked !== false;
      const aliasesStr = (card.aliases || []).join("、");
      const promises = Array.isArray(card["未完成事项"]) ? card["未完成事项"] : [];

      if (editingNpc === name) {
        detailHtml = `
          <div class="nl4-box nl4-card-editing">
            <div class="nl4-card-head">
              <h3 class="nl4-h3">编辑角色：${esc(name)}</h3>
              <div class="nl4-row-gap">
                <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="save-npc" data-npc="${esc(name)}">保存</button>
                <button type="button" class="nl4-btn nl4-btn-sm" data-act="cancel-edit">取消</button>
              </div>
            </div>
            <div class="nl4-form-grid" style="margin-top:10px">
              <label>正式名（修改自动留旧名为别名）<input class="nl4-input" data-edit="newName" value="${esc(name)}"></label>
              <label>别名（顿号/逗号分隔）<input class="nl4-input" data-edit="aliases" value="${esc(aliasesStr)}"></label>
              <label class="nl4-span-2">身份锚点<input class="nl4-input" data-edit="身份锚点" value="${esc(card["身份锚点"])}"></label>
              <label>位置<input class="nl4-input" data-edit="位置" value="${esc(card["位置"])}"></label>
              <label>当前状态<input class="nl4-input" data-edit="当前状态" value="${esc(card["当前状态"])}"></label>
              <label class="nl4-span-2">当前在做<input class="nl4-input" data-edit="当前在做" value="${esc(card["当前在做"])}"></label>
              <label class="nl4-span-2">生活状态<input class="nl4-input" data-edit="生活状态" value="${esc(card["生活状态"])}"></label>
              <label class="nl4-span-2">心事<input class="nl4-input" data-edit="心事" value="${esc(card["心事"])}"></label>
              <label class="nl4-span-2">藏起来的打算<input class="nl4-input" data-edit="藏起来的打算" value="${esc(card["藏起来的打算"])}"></label>
              <label>当前目标<input class="nl4-input" data-edit="当前目标" value="${esc(card["当前目标"])}"></label>
              <label>接下来想做<input class="nl4-input" data-edit="接下来想做" value="${esc(card["接下来想做"])}"></label>
              <label class="nl4-span-2">近期关键事件<textarea class="nl4-textarea" rows="2" data-edit="近期关键事件">${esc(card["近期关键事件"])}</textarea></label>
              <label>衣着/随身物<input class="nl4-input" data-edit="衣物/随身物" value="${esc(card["衣物/随身物"])}"></label>
              <label>伤势/体力<input class="nl4-input" data-edit="伤势/体力" value="${esc(card["伤势/体力"])}"></label>
            </div>
          </div>`;
      } else {
        detailHtml = `
          <div class="nl4-box">
            <div class="nl4-card-head">
              <div class="nl4-row-gap">
                <h3 class="nl4-h3">${esc(name)}</h3>
                ${inScene.has(name) && !dead ? '<span class="nl4-badge nl4-badge-scene">在场</span>' : ""}
                ${dead ? '<span class="nl4-badge nl4-badge-dead">已故</span>' : ""}
                ${!tracked ? '<span class="nl4-badge">已暂停</span>' : ""}
                ${aliasesStr ? `<span class="nl4-muted">别名：${esc(aliasesStr)}</span>` : ""}
              </div>
              <div class="nl4-row-gap">
                <button type="button" class="nl4-btn nl4-btn-sm" data-act="edit-npc" data-npc="${esc(name)}">编辑</button>
                <button type="button" class="nl4-btn nl4-btn-sm" data-act="toggle-npc" data-npc="${esc(name)}">${tracked ? "暂停" : "恢复"}</button>
                <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-act="del-npc" data-npc="${esc(name)}">删除</button>
              </div>
            </div>

            <div class="nl4-now-banner" style="margin:10px 0">
              <div><b>此刻正在：</b>${esc(card["当前在做"] || "暂无记录")}</div>
              <div class="nl4-muted" style="margin-top:2px">位置：${esc(card["位置"] || "未知")} · 状态：${esc(card["当前状态"] || "—")}</div>
            </div>

            <dl class="nl4-dl">
              <dt>身份锚点</dt><dd>${esc(card["身份锚点"] || "—")}</dd>
              <dt>生活状态</dt><dd>${esc(card["生活状态"] || "—")}</dd>
              <dt>心事</dt><dd>${esc(card["心事"] || "—")}</dd>
              <dt>藏起来的打算</dt><dd>${esc(card["藏起来的打算"] || "—")}</dd>
              <dt>当前目标</dt><dd>${esc(card["当前目标"] || "—")}</dd>
              <dt>接下来想做</dt><dd>${esc(card["接下来想做"] || "—")}</dd>
              <dt>近期关键事件</dt><dd>${esc(card["近期关键事件"] || "—")}</dd>
              <dt>衣着 / 随身物</dt><dd>${esc(card["衣物/随身物"] || "—")}</dd>
              <dt>伤势 / 体力</dt><dd>${esc(card["伤势/体力"] || "—")}</dd>
              <dt>未完成事项</dt>
              <dd>${
                promises.length
                  ? promises
                      .map((p) => `<div>[${esc(p["状态"])}] ${esc(p["内容"])}${p["结果"] ? ` → ${esc(p["结果"])}` : ""}</div>`)
                      .join("")
                  : "—"
              }</dd>
            </dl>
          </div>`;
      }
    }

    return `
      <div class="nl4-section">
        <div class="nl4-bar">
          <label class="nl4-check"><input type="checkbox" data-setting="enabled" ${settings.enabled ? "checked" : ""}> 启用插件</label>
          <label class="nl4-check"><input type="checkbox" data-setting="autoUpdate" ${settings.autoUpdate ? "checked" : ""}> 回复后自动更新</label>
          <label class="nl4-check"><input type="checkbox" data-setting="autoTrack" ${settings.autoTrack ? "checked" : ""}> 自动识别新建 NPC</label>
        </div>

        <details class="nl4-box" ${names.length === 0 ? "open" : ""}>
          <summary>＋ 手动添加角色</summary>
          <div class="nl4-form-grid" style="margin-top:8px">
            <label>角色名 *<input class="nl4-input" id="nl4-add-name" placeholder="如：林霜"></label>
            <label>别名（可选）<input class="nl4-input" id="nl4-add-aliases" placeholder="如：霜姐、林铁匠"></label>
            <label class="nl4-span-2">身份锚点<input class="nl4-input" id="nl4-add-anchor" placeholder="一句定型：身份/性格底色/核心执念"></label>
            <label>初始位置<input class="nl4-input" id="nl4-add-loc" placeholder="如：城北铁匠铺"></label>
            <label>当前在做<input class="nl4-input" id="nl4-add-doing" placeholder="如：整理锻炉"></label>
          </div>
          <div style="margin-top:8px"><button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="add-npc">添加角色</button></div>
        </details>

        <div class="nl4-npc-split">
          <div class="nl4-npc-roster">${rosterHtml}</div>
          <div class="nl4-npc-detail">${detailHtml}</div>
        </div>
      </div>`;
  };

  // Tab 2: Living World & Fate Clocks
  const renderWorldTab = (settings, chatState) => {
    const lw = settings.livingWorld;
    const w = chatState.world;
    const clocks = w.clocks || [];
    const knows = (w.ledger?.knows || []).filter((k) => k.status !== "done").slice(-10).reverse();
    const queue = (w.queue || []).filter((q) => q.status === "pending");

    const clocksHtml = clocks.length
      ? clocks
          .map((c) => {
            const meta = CLOCK_OUTCOMES[c.outcome] || CLOCK_OUTCOMES.dead;
            const hiddenSpoiler = c.status === "triggered" && !c.revealed && !lw.godView;
            const statusText = hiddenSpoiler
              ? "状态未知（沉浸防剧透中，开启上帝视角或回现场揭晓）"
              : c.status === "triggered"
                ? `已触发：${meta.icon} ${meta.label}（${c.revealed ? "已揭晓" : "未揭晓"}）`
                : c.status === "paused"
                  ? "已暂停"
                  : c.status === "resolved"
                    ? "已解除"
                    : `倒计时 ${c.elapsedDays} / ${c.deadlineDays} 天（后果：${meta.icon}${meta.label}）`;

            return `
              <div class="nl4-card">
                <div class="nl4-card-head">
                  <div><b>${esc(c.npc)}</b> · ${esc(c.title)} ${c.location ? `<span class="nl4-muted">@${esc(c.location)}</span>` : ""}</div>
                  <div class="nl4-row-gap">
                    ${c.status === "triggered" ? `<button type="button" class="nl4-btn nl4-btn-sm nl4-btn-primary" data-act="revive-clock" data-id="${esc(c.id)}">复活 / 撤销</button>` : ""}
                    ${c.status === "active" || c.status === "paused" ? `<button type="button" class="nl4-btn nl4-btn-sm" data-act="toggle-clock" data-id="${esc(c.id)}">${c.status === "paused" ? "恢复" : "暂停"}</button>` : ""}
                    ${c.status !== "resolved" ? `<button type="button" class="nl4-btn nl4-btn-sm" data-act="resolve-clock" data-id="${esc(c.id)}">解除</button>` : ""}
                    <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-act="del-clock" data-id="${esc(c.id)}">删</button>
                  </div>
                </div>
                <div class="nl4-muted">${esc(statusText)}</div>
              </div>`;
          })
          .join("")
      : `<div class="nl4-muted">暂无命运钟。可手动添加，或点击「扫描世界书危机」自动提取。</div>`;

    return `
      <div class="nl4-section">
        <div class="nl4-box">
          <div class="nl4-bar">
            <label class="nl4-check"><input type="checkbox" data-lw="enabled" ${lw.enabled ? "checked" : ""}> 启用活世界（防全知账本 / 传闻 / 偶遇）</label>
            <label class="nl4-check"><input type="checkbox" data-lw="fateClocks" ${lw.fateClocks ? "checked" : ""}> 启用命运钟</label>
            <label class="nl4-check"><input type="checkbox" data-lw="godView" ${lw.godView ? "checked" : ""}> 上帝视角（显示未揭晓剧透）</label>
          </div>
          <div class="nl4-bar" style="margin-top:8px">
            <label class="nl4-check"><input type="checkbox" data-lw="isolatedNpcCalls" ${lw.isolatedNpcCalls ? "checked" : ""}> 按角色隔离侧写（每轮按角色独立请求）</label>
            <label class="nl4-inline-num">单轮上限 <input class="nl4-input nl4-num" type="number" min="1" max="6" data-lw="isolatedMaxNpcs" value="${esc(lw.isolatedMaxNpcs)}"></label>
            <label class="nl4-check"><input type="checkbox" data-lw="autoScanWorldbook" ${lw.autoScanWorldbook ? "checked" : ""}> 自动增量扫描世界书危机</label>
          </div>
        </div>

        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">⏳ 命运钟（死亡 / 危急 / 失踪 / 离开 / 背叛）</h3>
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="scan-clocks" ${busyText ? "disabled" : ""}>扫描世界书危机</button>
          </div>
          <div class="nl4-form-grid" style="margin:10px 0">
            <label>角色名 *<input class="nl4-input" id="nl4-clk-npc" placeholder="如：林霜"></label>
            <label>地点<input class="nl4-input" id="nl4-clk-loc" placeholder="如：地下室"></label>
            <label>危机原因 *<input class="nl4-input" id="nl4-clk-title" placeholder="如：被囚禁断粮"></label>
            <label>期限天数<input class="nl4-input" id="nl4-clk-days" type="number" min="1" value="14"></label>
            <label>到期后果
              <select class="nl4-input" id="nl4-clk-outcome">
                ${Object.entries(CLOCK_OUTCOMES).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join("")}
              </select>
            </label>
            <div style="display:flex;align-items:flex-end">
              <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="add-clock">添加命运钟</button>
            </div>
          </div>
          <div class="nl4-card-list">${clocksHtml}</div>
        </div>

        <div class="nl4-grid-2">
          <div class="nl4-box">
            <b>📒 知情账本（最近 10 条）</b>
            <div class="nl4-list-mini">
              ${knows.length ? knows.map((k) => `<div><b>${esc(k.npc)}</b> [${k.source === "rumor" ? "传闻" : "亲见"}]：${esc(k.fact)}</div>`).join("") : '<div class="nl4-muted">暂无记录</div>'}
            </div>
          </div>
          <div class="nl4-box">
            <b>🚶 待触发主动偶遇队列</b>
            <div class="nl4-list-mini">
              ${queue.length ? queue.map((q) => `<div><b>${esc(q.npc)}</b>：${esc(q.action)}</div>`).join("") : '<div class="nl4-muted">暂无待触发偶遇</div>'}
            </div>
          </div>
        </div>
      </div>`;
  };

  // Tab 3: Sub-API & Custom Prompt Segments
  const renderApiTab = (settings) => {
    const api = settings.api;
    const segs = settings.customSegments || [];

    const segsHtml = segs.length
      ? segs
          .map(
            (s, idx) => `
          <div class="nl4-card">
            <div class="nl4-card-head">
              <label class="nl4-check"><input type="checkbox" data-seg-toggle="${idx}" ${s.enabled !== false ? "checked" : ""}> <b>${esc(s.name || `段 ${idx + 1}`)}</b></label>
              <div class="nl4-row-gap">
                <span class="nl4-badge">${esc(s.role)}</span>
                <span class="nl4-badge">${esc(s.position)}</span>
                <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-seg-del="${idx}">删除</button>
              </div>
            </div>
            <div class="nl4-muted nl4-pre">${esc(s.content.slice(0, 220))}${s.content.length > 220 ? "…" : ""}</div>
          </div>`
          )
          .join("")
      : `<div class="nl4-muted">暂无自定义提示词 / 破限段。</div>`;

    return `
      <div class="nl4-section">
        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">🔌 独立副 API（严格隔离，绝不偷调主模型）</h3>
            <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="test-api" ${busyText ? "disabled" : ""}>一键测试连通</button>
          </div>
          <div class="nl4-form-grid" style="margin-top:10px">
            <label class="nl4-span-2">API 地址（OpenAI 兼容端点，如 https://api.deepseek.com/v1）
              <input class="nl4-input" data-api="apiurl" value="${esc(api.apiurl)}" placeholder="https://.../v1">
            </label>
            <label>API Key<input class="nl4-input" type="password" data-api="key" value="${esc(api.key)}" placeholder="sk-..."></label>
            <label>模型名称 *<input class="nl4-input" data-api="model" value="${esc(api.model)}" placeholder="如：deepseek-chat / gemini-2.5-flash"></label>
            <label>温度<input class="nl4-input" type="number" step="0.1" min="0" max="2" data-api="temperature" value="${esc(api.temperature)}"></label>
            <label>最大输出 Token<input class="nl4-input" type="number" min="256" max="16384" step="256" data-api="maxTokens" value="${esc(api.maxTokens)}"></label>
            <label>超时秒数<input class="nl4-input" type="number" min="15" max="240" data-api="timeoutSec" value="${esc(api.timeoutSec)}"></label>
            <label class="nl4-check" style="align-self:end">
              <input type="checkbox" data-api="direct" ${api.direct !== false ? "checked" : ""}> 浏览器直连（推荐，关闭走酒馆转发）
            </label>
          </div>
        </div>

        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">🧩 默认系统提示词（已保留原彼方核心去中心化 / 防全知 / 反雷同规则）</h3>
            <div class="nl4-row-gap">
              <button type="button" class="nl4-btn nl4-btn-sm" data-act="copy-sys-prompt">📋 复制当前提示词</button>
              ${settings.customSystemPrompt ? '<button type="button" class="nl4-btn nl4-btn-sm" data-act="reset-sys-prompt">恢复内置默认</button>' : ""}
            </div>
          </div>
          <div class="nl4-bar" style="margin-top:8px">
            <label class="nl4-check"><input type="checkbox" data-setting="compactPrompt" ${settings.compactPrompt !== false ? "checked" : ""}> 精简快跑提示词（省 Token，关掉可切完整经典版）</label>
            <label class="nl4-check"><input type="checkbox" data-setting="prefillJson" ${settings.prefillJson === true ? "checked" : ""}> 启用 JSON 预填充（Prefill，减少模型废话与拒答）</label>
          </div>
          <details style="margin-top:8px">
            <summary class="nl4-muted" style="cursor:pointer">查看 / 自定义主系统提示词（当前：${settings.customSystemPrompt ? "已自定义" : settings.compactPrompt !== false ? "内置精简版" : "内置完整经典版"}）</summary>
            <textarea class="nl4-textarea" id="nl4-sys-prompt-edit" rows="8" style="margin-top:6px">${esc(getEffectiveSystemPrompt(settings))}</textarea>
            <div class="nl4-row-gap" style="margin-top:6px">
              <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="save-sys-prompt">保存为主系统提示词</button>
              <button type="button" class="nl4-btn nl4-btn-sm" data-act="reset-sys-prompt">恢复内置默认</button>
            </div>
          </details>
        </div>

        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">📌 自定义附加提示词段（可按位置插入副 API 请求）</h3>
          </div>
          <div class="nl4-form-grid" style="margin:10px 0">
            <label>段落名称<input class="nl4-input" id="nl4-seg-name" placeholder="如：破限段"></label>
            <label>角色
              <select class="nl4-input" id="nl4-seg-role">
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
            </label>
            <label>插入位置
              <select class="nl4-input" id="nl4-seg-pos">
                <option value="最前">最前</option>
                <option value="主提示词之后">主提示词之后</option>
                <option value="任务之前">任务之前</option>
                <option value="任务之后">任务之后</option>
                <option value="最后">最后</option>
              </select>
            </label>
            <div style="display:flex;align-items:flex-end">
              <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="add-seg">添加段落</button>
            </div>
            <label class="nl4-span-2">内容<textarea class="nl4-textarea" id="nl4-seg-content" rows="2" placeholder="填写插入副 API 的提示词内容..."></textarea></label>
          </div>
          <div class="nl4-card-list">${segsHtml}</div>
        </div>
      </div>`;
  };

  // Tab 4: Worldbook Injection, Cost Fuse, & Diagnostics
  const renderSettingsTab = (settings) => {
    const wb = settings.worldbook;
    const cost = settings.cost;
    const logs = getDiagnosticLogs();
    const activeFields =
      wb.injectMode === "minimal" ? WB_PRESETS.minimal : wb.injectMode === "custom" ? wb.customFields : WB_PRESETS.full;

    const logsHtml = logs.length
      ? logs
          .map(
            (l) => `
          <div class="nl4-log-row">
            <span class="nl4-badge ${l.status === "ok" ? "nl4-badge-scene" : l.status === "error" ? "nl4-badge-dead" : ""}">${esc(l.status)}</span>
            <span>${esc(fmtTime(l.at))}</span>
            <span>${esc(l.kind)}</span>
            <span>${l.tokens ? `~${esc(l.tokens)} tok` : "-"}</span>
            <span>${l.durationMs ? `${(l.durationMs / 1000).toFixed(1)}s` : "-"}</span>
            <span class="nl4-muted">${esc(l.detail)}</span>
          </div>`
          )
          .join("")
      : `<div class="nl4-muted">暂无请求记录。</div>`;

    return `
      <div class="nl4-section">
        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">📚 世界书读写与主模型注入</h3>
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="sync-wb">立即同步世界书</button>
          </div>
          <div class="nl4-form-grid" style="margin-top:10px">
            <label>写入目标
              <select class="nl4-input" data-wb="writeTarget">
                <option value="chat" ${wb.writeTarget === "chat" ? "selected" : ""}>聊天世界书（推荐，群聊兼容）</option>
                <option value="primary" ${wb.writeTarget === "primary" ? "selected" : ""}>角色卡主世界书</option>
                <option value="off" ${wb.writeTarget === "off" ? "selected" : ""}>关闭写入</option>
              </select>
            </label>
            <label>注入主模型模式
              <select class="nl4-input" data-wb="injectMode">
                <option value="full" ${wb.injectMode === "full" ? "selected" : ""}>全量注入（默认：全部核心字段）</option>
                <option value="minimal" ${wb.injectMode === "minimal" ? "selected" : ""}>极简动态（仅注入：位置 / 当前在做 / 当前状态）</option>
                <option value="custom" ${wb.injectMode === "custom" ? "selected" : ""}>自定义勾选列</option>
              </select>
            </label>
            <label class="nl4-check nl4-span-2">
              <input type="checkbox" data-wb="readEnabled" ${wb.readEnabled !== false ? "checked" : ""}> 后台更新时读取世界书设定参考
            </label>
          </div>
          <div class="nl4-field-chips" style="margin-top:8px">
            ${WB_FIELD_DEFS.map(
              (f) => `<label class="nl4-chip"><input type="checkbox" data-wb-field="${esc(f.key)}" ${activeFields.includes(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`
            ).join("")}
          </div>
          <div class="nl4-muted" style="margin-top:6px">提示：切到「极简动态」后，承诺/关键事件仅保留在插件内部与面板，不再注入世界书，避免与总结/数据库冲突。</div>
        </div>

        <div class="nl4-box">
          <h3 class="nl4-h3">💰 成本熔断与省 Token</h3>
          <div class="nl4-form-grid" style="margin-top:10px">
            <label>每轮副 API 上限（0=纯本地）<input class="nl4-input" type="number" min="0" max="10" data-cost="maxSubApiCallsPerTurn" value="${esc(cost.maxSubApiCallsPerTurn)}"></label>
            <label>世界书读取字数上限<input class="nl4-input" type="number" min="1000" max="30000" step="500" data-cost="worldbookCharCap" value="${esc(cost.worldbookCharCap)}"></label>
            <label>单条正文字数上限（0=不截断）<input class="nl4-input" type="number" min="0" max="20000" step="500" data-cost="replyCharCap" value="${esc(cost.replyCharCap)}"></label>
            <label>读取最近回复条数<input class="nl4-input" type="number" min="1" max="6" data-setting-num="recentReplyCount" value="${esc(settings.recentReplyCount)}"></label>
          </div>
          <div class="nl4-bar" style="margin-top:8px">
            <label class="nl4-check"><input type="checkbox" data-cost="tokenSlimMode" ${cost.tokenSlimMode !== false ? "checked" : ""}> 智能省 Token 瘦身（世界书上限 / 人设一次性注入 / 紧凑 JSON）</label>
            <label class="nl4-check"><input type="checkbox" data-cost="skipIdleTurns" ${cost.skipIdleTurns === true ? "checked" : ""}> 可选省钱：跳过无在场NPC且时间未推进的空转轮</label>
            <label class="nl4-check"><input type="checkbox" data-setting="showFloatingButton" ${settings.showFloatingButton !== false ? "checked" : ""}> 显示悬浮「小地球」图标</label>
          </div>
        </div>

        <div class="nl4-box">
          <h3 class="nl4-h3">🩺 最近 5 次副 API 请求诊断</h3>
          <div class="nl4-logs">${logsHtml}</div>
        </div>

        <div class="nl4-box">
          <div class="nl4-bar">
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="export-chat">导出当前聊天档案 JSON</button>
            <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-act="clear-chat">清空当前聊天 NPC 数据</button>
          </div>
        </div>
      </div>`;
  };

  const render = () => {
    syncOrbStatus();
    mountStEntryPoints();
    if (!isOpen) return;
    const settings = engine.getSettings();
    const chatState = engine.getChatState();
    const budgetSnap = engine.getBudget().snapshot();

    let body = "";
    if (activeTab === "npcs") body = renderNpcsTab(settings, chatState);
    else if (activeTab === "world") body = renderWorldTab(settings, chatState);
    else if (activeTab === "api") body = renderApiTab(settings);
    else body = renderSettingsTab(settings);

    panel.innerHTML =
      renderTopbar(settings, chatState) +
      `<div class="nl4-main">${body}</div>` +
      renderFoot(settings, budgetSnap) +
      renderRightBookTabs(chatState) +
      `<div class="nl4-resize" title="拖拽缩放窗口"></div>`;
  };

  // Double-click titlebar to re-center window
  panel.addEventListener("dblclick", (e) => {
    if (e.target.closest(".nl4-topbar") && !e.target.closest("button")) {
      centerPanel();
    }
  });

  // Delegated click handler
  panel.addEventListener("click", async (e) => {
    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) {
      activeTab = tabBtn.dataset.tab;
      editingNpc = null;
      render();
      return;
    }

    const rosterBtn = e.target.closest("[data-select-npc]");
    if (rosterBtn) {
      selectedNpc = rosterBtn.dataset.selectNpc;
      editingNpc = null;
      render();
      return;
    }

    const segDel = e.target.closest("[data-seg-del]");
    if (segDel) {
      const idx = Number(segDel.dataset.segDel);
      engine.updateSettings((s) => {
        s.customSegments.splice(idx, 1);
        return s;
      });
      return;
    }

    const actBtn = e.target.closest("[data-act]");
    if (!actBtn) return;
    const act = actBtn.dataset.act;

    if (act === "close") return close();
    if (act === "center-win") {
      centerPanel();
      return;
    }
    if (act === "toggle-theme") {
      theme = theme === "dark" ? "light" : "dark";
      root.dataset.theme = theme;
      writeJsonLS(THEME_KEY, theme);
      render();
      return;
    }

    if (act === "run-now") {
      busyText = "更新中…";
      render();
      try {
        const res = await engine.runUpdateTurn({ force: true, bypassBudget: true });
        if (res.ok) host.toast.success(`更新完成（变动 ${res.changedNpcs.length} 人，约 ${res.tokens} Token）`);
        else host.toast.warn(res.error || res.reason || "本次未更新");
      } finally {
        busyText = "";
        render();
      }
      return;
    }

    if (act === "add-npc") {
      const name = panel.querySelector("#nl4-add-name")?.value?.trim();
      if (!name) return host.toast.warn("请填写角色名");
      await engine.addNpc(name, {
        aliases: panel.querySelector("#nl4-add-aliases")?.value || "",
        身份锚点: panel.querySelector("#nl4-add-anchor")?.value || "",
        位置: panel.querySelector("#nl4-add-loc")?.value || "",
        当前在做: panel.querySelector("#nl4-add-doing")?.value || ""
      });
      selectedNpc = name;
      host.toast.success(`已添加角色「${name}」`);
      render();
      return;
    }

    if (act === "edit-npc") {
      editingNpc = actBtn.dataset.npc;
      render();
      return;
    }
    if (act === "cancel-edit") {
      editingNpc = null;
      render();
      return;
    }
    if (act === "save-npc") {
      const oldName = actBtn.dataset.npc;
      const box = panel.querySelector(".nl4-card-editing");
      if (!box) return;
      const fields = {};
      let newName = oldName;
      for (const el of box.querySelectorAll("[data-edit]")) {
        const k = el.dataset.edit;
        if (k === "newName") newName = el.value.trim() || oldName;
        else fields[k] = el.value;
      }
      await engine.updateNpc(oldName, fields);
      if (newName !== oldName) await engine.renameNpc(oldName, newName);
      selectedNpc = newName;
      editingNpc = null;
      host.toast.success(`已保存「${newName}」`);
      render();
      return;
    }

    if (act === "toggle-npc") {
      await engine.toggleNpcTracked(actBtn.dataset.npc);
      return;
    }
    if (act === "del-npc") {
      const target = actBtn.dataset.npc;
      await engine.deleteNpc(target);
      if (selectedNpc === target) selectedNpc = null;
      host.toast.info(`已删除「${target}」`);
      render();
      return;
    }

    if (act === "add-clock") {
      const npc = panel.querySelector("#nl4-clk-npc")?.value?.trim();
      const title = panel.querySelector("#nl4-clk-title")?.value?.trim();
      if (!npc || !title) return host.toast.warn("请填写角色名和危机原因");
      engine.getChatState().world.clocks.push(
        createClock({
          npc,
          location: panel.querySelector("#nl4-clk-loc")?.value?.trim() || "",
          title,
          deadlineDays: Number(panel.querySelector("#nl4-clk-days")?.value) || 14,
          outcome: panel.querySelector("#nl4-clk-outcome")?.value || "dead"
        })
      );
      await engine.persistState(null, false);
      host.toast.success(`已为「${npc}」添加命运钟`);
      return;
    }

    if (act === "scan-clocks") {
      busyText = "扫描中…";
      render();
      try {
        const res = await engine.scanClocksNow();
        if (res.error) host.toast.warn(res.error);
        else host.toast.success(`扫描 ${res.scanned} 条设定，新增 ${res.added} 个命运钟`);
      } finally {
        busyText = "";
        render();
      }
      return;
    }

    if (act === "revive-clock") {
      reviveOrUndoClock(engine.getChatState(), actBtn.dataset.id);
      await engine.persistState(null, true);
      host.toast.success("已复活并重置该命运钟");
      return;
    }
    if (act === "toggle-clock") {
      const clk = engine.getChatState().world.clocks.find((c) => c.id === actBtn.dataset.id);
      if (clk) {
        clk.status = clk.status === "paused" ? "active" : "paused";
        await engine.persistState(null, false);
      }
      return;
    }
    if (act === "resolve-clock") {
      const clk = engine.getChatState().world.clocks.find((c) => c.id === actBtn.dataset.id);
      if (clk) {
        clk.status = "resolved";
        await engine.persistState(null, false);
      }
      return;
    }
    if (act === "del-clock") {
      const w = engine.getChatState().world;
      w.clocks = w.clocks.filter((c) => c.id !== actBtn.dataset.id);
      await engine.persistState(null, false);
      return;
    }

    if (act === "test-api") {
      busyText = "测试中…";
      render();
      try {
        const res = await testSubApiConnection(host, engine.getSettings());
        if (res.ok) host.toast.success(`连通成功（${res.route}，耗时 ${(res.durationMs / 1000).toFixed(1)}s）`);
        else host.toast.error(`连通失败：${res.error || res.reason}`);
      } finally {
        busyText = "";
        render();
      }
      return;
    }

    if (act === "copy-sys-prompt") {
      const text = getEffectiveSystemPrompt(engine.getSettings());
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        host.toast.success(`已复制当前默认提示词（共 ${text.length} 字）`);
      } catch {
        host.toast.warn("复制失败，请展开下方文本框手动全选复制");
      }
      return;
    }

    if (act === "save-sys-prompt") {
      const val = panel.querySelector("#nl4-sys-prompt-edit")?.value?.trim() || "";
      engine.updateSettings((s) => {
        s.customSystemPrompt = val;
        return s;
      });
      host.toast.success("已保存自定义主系统提示词");
      return;
    }

    if (act === "reset-sys-prompt") {
      engine.updateSettings((s) => {
        s.customSystemPrompt = "";
        return s;
      });
      host.toast.info("已恢复内置默认提示词");
      return;
    }

    if (act === "add-seg") {
      const content = panel.querySelector("#nl4-seg-content")?.value?.trim();
      if (!content) return host.toast.warn("请填写提示词内容");
      engine.updateSettings((s) => {
        s.customSegments.push({
          id: `seg_${Date.now().toString(36)}`,
          name: panel.querySelector("#nl4-seg-name")?.value?.trim() || `自定义段 ${s.customSegments.length + 1}`,
          role: panel.querySelector("#nl4-seg-role")?.value || "system",
          position: panel.querySelector("#nl4-seg-pos")?.value || "最前",
          enabled: true,
          content
        });
        return s;
      });
      return;
    }

    if (act === "sync-wb") {
      const res = await syncWorldbook(host, engine.getChatState(), engine.getSettings());
      if (res.ok) host.toast.success(res.removed ? "已移除世界书条目" : `已同步到「${res.bookName || "世界书"}」`);
      else host.toast.warn(res.reason || "同步失败");
      return;
    }

    if (act === "export-chat") {
      const json = JSON.stringify(engine.getChatState(), null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `npc-life-chat-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (act === "clear-chat") {
      await engine.clearCurrentChat();
      selectedNpc = null;
      host.toast.info("已清空当前聊天的 NPC Life 数据");
      render();
    }
  });

  // Delegated change handler
  panel.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset.setting) {
      const k = el.dataset.setting;
      engine.updateSettings((s) => {
        s[k] = el.type === "checkbox" ? el.checked : el.value;
        return s;
      });
      return;
    }
    if (el.dataset.settingNum) {
      const k = el.dataset.settingNum;
      engine.updateSettings((s) => {
        s[k] = Math.max(1, Math.min(6, Math.round(Number(el.value) || 2)));
        return s;
      });
      return;
    }
    if (el.dataset.lw) {
      const k = el.dataset.lw;
      engine.updateSettings((s) => {
        s.livingWorld[k] = el.type === "checkbox" ? el.checked : Math.max(1, Math.min(6, Math.round(Number(el.value) || 3)));
        return s;
      });
      return;
    }
    if (el.dataset.api) {
      const k = el.dataset.api;
      engine.updateSettings((s) => {
        if (el.type === "checkbox") s.api[k] = el.checked;
        else if (el.type === "number") s.api[k] = Number(el.value);
        else s.api[k] = el.value.trim();
        return s;
      });
      return;
    }
    if (el.dataset.wb) {
      const k = el.dataset.wb;
      engine.updateSettings((s) => {
        s.worldbook[k] = el.type === "checkbox" ? el.checked : el.value;
        if (k === "injectMode" && el.value === "minimal") s.worldbook.customFields = [...WB_PRESETS.minimal];
        else if (k === "injectMode" && el.value === "full") s.worldbook.customFields = [...WB_PRESETS.full];
        return s;
      });
      await syncWorldbook(host, engine.getChatState(), engine.getSettings()).catch(() => {});
      return;
    }
    if (el.dataset.wbField) {
      const fieldKey = el.dataset.wbField;
      engine.updateSettings((s) => {
        const cur = new Set(
          s.worldbook.injectMode === "minimal"
            ? WB_PRESETS.minimal
            : s.worldbook.injectMode === "full"
              ? WB_PRESETS.full
              : s.worldbook.customFields
        );
        if (el.checked) cur.add(fieldKey);
        else cur.delete(fieldKey);
        s.worldbook.injectMode = "custom";
        s.worldbook.customFields = Array.from(cur);
        return s;
      });
      await syncWorldbook(host, engine.getChatState(), engine.getSettings()).catch(() => {});
      return;
    }
    if (el.dataset.cost) {
      const k = el.dataset.cost;
      engine.updateSettings((s) => {
        if (el.type === "checkbox") s.cost[k] = el.checked;
        else if (k === "maxSubApiCallsPerTurn") s.cost[k] = Math.max(0, Math.min(10, Math.round(Number(el.value) || 0)));
        else if (k === "worldbookCharCap") s.cost[k] = Math.max(1000, Math.min(30000, Math.round(Number(el.value) || 6000)));
        else if (k === "replyCharCap") {
          const v = Number(el.value);
          s.cost[k] = Number.isFinite(v) && v > 0 ? Math.max(800, Math.min(20000, Math.round(v))) : 0;
        }
        return s;
      });
      return;
    }
    if (el.dataset.segToggle != null) {
      const idx = Number(el.dataset.segToggle);
      engine.updateSettings((s) => {
        if (s.customSegments[idx]) s.customSegments[idx].enabled = el.checked;
        return s;
      });
    }
  });

  const unsub = engine.subscribe(() => render());
  mountStEntryPoints();
  syncOrbStatus();

  return {
    open,
    close,
    toggle,
    render,
    destroy() {
      unsub();
      root.remove();
      document.getElementById("nl4-ext-menu-item")?.remove();
      document.getElementById("nl4-st-drawer-box")?.remove();
    }
  };
}
