import {
  CLOCK_OUTCOMES,
  PLUGIN_NAME,
  VERSION,
  WB_FIELD_DEFS,
  WB_PRESETS
} from "./constants.js";
import {
  fetchModelList,
  getDiagnosticLogs,
  getLastTokenStats,
  isSubApiConfigured,
  testSubApiConnection
} from "./api.js";
import { createClock, isDeceased, reviveOrUndoClock } from "./clocks.js";
import { getEffectiveSystemPrompt } from "./engine.js";
import { upsertWorldTrend } from "./livingWorld.js";
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

function renderToggleRow({ title, desc = "", attrs = "", checked = false }) {
  return `
    <div class="nl4-setting-row">
      <div class="nl4-setting-info">
        <div class="nl4-setting-title">${esc(title)}</div>
        ${desc ? `<div class="nl4-setting-desc">${esc(desc)}</div>` : ""}
      </div>
      <div class="nl4-setting-ctrl">
        <label class="nl4-switch">
          <input type="checkbox" ${attrs} ${checked ? "checked" : ""}>
          <span class="nl4-slider"></span>
        </label>
      </div>
    </div>`;
}

function renderControlRow({ title, desc = "", controlHtml = "" }) {
  return `
    <div class="nl4-setting-row">
      <div class="nl4-setting-info">
        <div class="nl4-setting-title">${esc(title)}</div>
        ${desc ? `<div class="nl4-setting-desc">${esc(desc)}</div>` : ""}
      </div>
      <div class="nl4-setting-ctrl">${controlHtml}</div>
    </div>`;
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
  let fetchedModels = [];
  let rosterFilter = "";
  let dockSide = "right";
  let dockTimer = null;
  let isOrbDragging = false;
  let theme = readJsonLS(THEME_KEY, "dark") === "light" ? "light" : "dark";

  const resolveLayout = () => {
    const pref = engine.getSettings().uiLayout || "auto";
    if (pref === "mobile" || pref === "desktop") return pref;
    return (window.innerWidth || 1280) <= 760 ? "mobile" : "desktop";
  };

  let root = document.getElementById("nl4-root");
  if (root) root.remove();
  root = document.createElement("div");
  root.id = "nl4-root";
  root.className = "nl4-root";
  root.dataset.theme = theme;
  root.dataset.layout = resolveLayout();
  document.body.appendChild(root);

  // 1. Draggable Floating Globe Orb
  const orb = document.createElement("button");
  orb.id = "nl4-orb";
  orb.type = "button";
  orb.className = "nl4-orb";
  orb.title = `拖动移动 · 轻点开关 ${PLUGIN_NAME}`;
  orb.innerHTML = `${GLOBE_SVG}<span class="nl4-orb-dot" id="nl4-orb-dot"></span>`;
  root.appendChild(orb);

  // 2. Draggable & Resizable Book-Ledger Floating Panel
  const panel = document.createElement("div");
  panel.id = "nl4-panel";
  panel.className = "nl4-panel nl4-hidden";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", PLUGIN_NAME);
  root.appendChild(panel);

  const applyEdgeDockState = (side) => {
    orb.classList.remove("docked-left", "docked-right");
    const autoHide = engine.getSettings().orbAutoHideEdge !== false;
    if (!autoHide || !side || isOrbDragging) return;
    const vw = window.innerWidth || 1280;
    const orbW = 48;
    orb.style.left = side === "left" ? "0px" : `${Math.max(0, vw - orbW)}px`;
    orb.classList.add(side === "left" ? "docked-left" : "docked-right");
  };

  const scheduleEdgeDock = (delayMs = 1200) => {
    if (dockTimer) {
      clearTimeout(dockTimer);
      dockTimer = null;
    }
    if (engine.getSettings().orbAutoHideEdge === false || !dockSide) return;
    dockTimer = setTimeout(() => {
      dockTimer = null;
      applyEdgeDockState(dockSide);
    }, delayMs);
  };

  const applyOrbPos = (pos, snapEdge = false) => {
    const vw = window.innerWidth || 1280;
    const vh = window.visualViewport?.height || window.innerHeight || 800;
    const autoHide = engine.getSettings().orbAutoHideEdge !== false;
    const margin = autoHide ? 0 : 10;
    const orbW = 48;
    const isMobile = vw <= 760;
    const defaultTop = isMobile ? Math.round(vh * 0.38) : vh - 128;
    let left = clamp(pos?.left ?? (autoHide ? vw - orbW : vw - orbW - 14), margin, Math.max(margin, vw - orbW - margin));
    const top = clamp(pos?.top ?? defaultTop, 10, Math.max(10, vh - orbW - 10));

    if (autoHide) {
      if (!pos || snapEdge) {
        dockSide = left + orbW / 2 < vw / 2 ? "left" : "right";
        left = dockSide === "left" ? 0 : Math.max(0, vw - orbW);
      } else if (left <= 24) {
        dockSide = "left";
        left = 0;
      } else if (left + orbW >= vw - 24) {
        dockSide = "right";
        left = Math.max(0, vw - orbW);
      } else {
        dockSide = "";
      }
      orb.style.left = `${Math.round(left)}px`;
      orb.style.top = `${Math.round(top)}px`;
      if (dockSide) applyEdgeDockState(dockSide);
      else orb.classList.remove("docked-left", "docked-right");
    } else {
      dockSide = "";
      orb.classList.remove("docked-left", "docked-right");
      if (snapEdge) {
        if (left <= 44) left = 10;
        else if (vw - (left + orbW) <= 44) left = vw - orbW - 10;
      }
      orb.style.left = `${Math.round(left)}px`;
      orb.style.top = `${Math.round(top)}px`;
    }
    return { left: Math.round(left), top: Math.round(top) };
  };
  applyOrbPos(readJsonLS(POS_ORB_KEY), false);

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
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.width = `${Math.round(w)}px`;
    panel.style.height = `${Math.round(h)}px`;
  };
  applyWinRect(readJsonLS(POS_WIN_KEY));

  // Keep orb & panel visible when viewport resizes, keyboard opens, or phone rotates
  const onViewportResize = () => {
    root.dataset.layout = resolveLayout();
    const curLeft = parseFloat(orb.style.left);
    const curTop = parseFloat(orb.style.top);
    if (Number.isFinite(curLeft) && Number.isFinite(curTop)) {
      applyOrbPos({ left: curLeft, top: curTop }, false);
    }
    if (isOpen) {
      const pr = panel.getBoundingClientRect();
      applyWinRect({ left: pr.left, top: pr.top, width: pr.width, height: pr.height });
      render();
    }
  };
  window.addEventListener("resize", onViewportResize);
  window.addEventListener("orientationchange", onViewportResize);
  window.visualViewport?.addEventListener("resize", onViewportResize);

  // --- Silky GPU-Accelerated Orb Drag (rAF + translate3d + Edge-Tucking) ---
  {
    let drag = null;
    let rafId = 0;
    let pendingDx = 0;
    let pendingDy = 0;

    orb.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (dockTimer) {
        clearTimeout(dockTimer);
        dockTimer = null;
      }
      isOrbDragging = true;
      // Remove edge tuck before measuring origLeft so drag never jumps
      orb.classList.remove("docked-left", "docked-right");
      const r = orb.getBoundingClientRect();
      const origLeft = Number.isFinite(parseFloat(orb.style.left)) ? parseFloat(orb.style.left) : r.left;
      const origTop = Number.isFinite(parseFloat(orb.style.top)) ? parseFloat(orb.style.top) : r.top;
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origLeft,
        origTop,
        moved: false
      };
      pendingDx = 0;
      pendingDy = 0;
      orb.setPointerCapture?.(e.pointerId);
    });

    orb.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 5) {
        drag.moved = true;
        orb.classList.add("dragging");
      }
      if (!drag.moved) return;
      const vw = window.innerWidth || 1280;
      const vh = window.visualViewport?.height || window.innerHeight || 800;
      pendingDx = clamp(drag.origLeft + dx, 0, Math.max(0, vw - 48)) - drag.origLeft;
      pendingDy = clamp(drag.origTop + dy, 8, Math.max(8, vh - 56)) - drag.origTop;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (drag?.moved) {
            orb.style.transform = `translate3d(${pendingDx}px, ${pendingDy}px, 0) scale(0.95)`;
          }
        });
      }
    });

    const finishOrb = (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      const wasMoved = drag.moved;
      const finalLeft = drag.origLeft + pendingDx;
      const finalTop = drag.origTop + pendingDy;
      drag = null;
      isOrbDragging = false;
      orb.style.transform = "";
      orb.classList.remove("dragging");
      if (wasMoved) {
        const snapped = applyOrbPos({ left: finalLeft, top: finalTop }, true);
        writeJsonLS(POS_ORB_KEY, snapped);
        scheduleEdgeDock(1100);
      } else {
        toggle();
        scheduleEdgeDock(1400);
      }
    };
    orb.addEventListener("pointerup", finishOrb);
    orb.addEventListener("pointercancel", finishOrb);
  }

  // --- Silky GPU-Accelerated Window Drag (translate3d + rAF + Pointer Capture) & Resize ---
  {
    let winDrag = null;
    let winResize = null;
    let rafId = 0;
    let dx = 0;
    let dy = 0;

    panel.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;

      const resizeHandle = e.target.closest(".nl4-resize");
      if (resizeHandle) {
        const r = panel.getBoundingClientRect();
        winResize = { pointerId: e.pointerId, el: resizeHandle, startX: e.clientX, startY: e.clientY, w: r.width, h: r.height };
        resizeHandle.setPointerCapture?.(e.pointerId);
        panel.classList.add("dragging");
        e.preventDefault();
        return;
      }

      const bar = e.target.closest(".nl4-topbar");
      if (bar && !e.target.closest("button, input, select, a")) {
        const r = panel.getBoundingClientRect();
        winDrag = { pointerId: e.pointerId, bar, startX: e.clientX, startY: e.clientY, left: r.left, top: r.top };
        dx = 0;
        dy = 0;
        bar.setPointerCapture?.(e.pointerId);
        bar.classList.add("dragging");
        panel.classList.add("dragging");
        e.preventDefault();
      }
    });

    panel.addEventListener("pointermove", (e) => {
      if (winDrag && e.pointerId === winDrag.pointerId) {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        dx = clamp(winDrag.left + (e.clientX - winDrag.startX), -220, vw - 140) - winDrag.left;
        dy = clamp(winDrag.top + (e.clientY - winDrag.startY), 0, vh - 60) - winDrag.top;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (winDrag) panel.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
          });
        }
      } else if (winResize && e.pointerId === winResize.pointerId) {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 800;
        const nextW = clamp(winResize.w + (e.clientX - winResize.startX), 560, vw - 20);
        const nextH = clamp(winResize.h + (e.clientY - winResize.startY), 420, vh - 20);
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (winResize) {
              panel.style.width = `${Math.round(nextW)}px`;
              panel.style.height = `${Math.round(nextH)}px`;
            }
          });
        }
      }
    });

    const endWinAction = (e) => {
      if (winDrag && e.pointerId === winDrag.pointerId) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        const finalLeft = Math.round(winDrag.left + dx);
        const finalTop = Math.round(winDrag.top + dy);
        winDrag.bar.classList.remove("dragging");
        panel.classList.remove("dragging");
        panel.style.transform = "";
        panel.style.left = `${finalLeft}px`;
        panel.style.top = `${finalTop}px`;
        const r = panel.getBoundingClientRect();
        writeJsonLS(POS_WIN_KEY, { left: finalLeft, top: finalTop, width: Math.round(r.width), height: Math.round(r.height) });
        winDrag = null;
      } else if (winResize && e.pointerId === winResize.pointerId) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        panel.classList.remove("dragging");
        const r = panel.getBoundingClientRect();
        writeJsonLS(POS_WIN_KEY, { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
        winResize = null;
      }
    };
    panel.addEventListener("pointerup", endWinAction);
    panel.addEventListener("pointercancel", endWinAction);
  }

  const syncOrbStatus = () => {
    const s = engine.getSettings();
    root.dataset.layout = resolveLayout();
    orb.classList.toggle("nl4-hidden", s.showFloatingButton === false);
    orb.classList.toggle("busy", Boolean(busyText));
    const dot = orb.querySelector("#nl4-orb-dot");
    if (dot) dot.classList.toggle("warn", !isSubApiConfigured(s));
    if (s.orbAutoHideEdge === false) {
      orb.classList.remove("docked-left", "docked-right");
    } else if (!isOrbDragging) {
      if (!dockSide) {
        const vw = window.innerWidth || 1280;
        const curLeft = parseFloat(orb.style.left);
        dockSide = Number.isFinite(curLeft) && curLeft + 24 < vw / 2 ? "left" : "right";
      }
      applyEdgeDockState(dockSide);
    }
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
            <p style="margin:6px 0;opacity:.8;font-size:12px">轻点屏幕上的「小地球」悬浮球或下方按钮打开可拖动浮窗。</p>
            <button type="button" class="menu_button" id="nl4-open-from-drawer">打开「活世界」浮窗</button>
          </div>
        </div>`;
      box.querySelector("#nl4-open-from-drawer")?.addEventListener("click", open);
      drawer.appendChild(box);
    }
  };

  const renderTopbar = (_settings, chatState) => {
    const isMob = resolveLayout() === "mobile";
    return `
      <div class="nl4-topbar" title="按住标题栏自由拖动，双击居中复位">
        <div class="nl4-brand">
          <div class="nl4-brand-globe">${GLOBE_SVG}</div>
          <div>
            <h2 class="nl4-title">${esc(PLUGIN_NAME)}</h2>
            <p class="nl4-subtitle">v${esc(VERSION)}${chatState.storyTime ? ` · ${isMob ? "" : "剧情时间 "}${esc(chatState.storyTime)}` : isMob ? "" : " · 独立活世界引擎"}</p>
          </div>
        </div>
        <div class="nl4-top-actions">
          <button type="button" class="nl4-btn nl4-btn-primary ${isMob ? "nl4-btn-sm" : ""}" data-act="run-now" ${busyText ? "disabled" : ""}>
            ${busyText ? esc(busyText) : isMob ? "更新" : "立即更新"}
          </button>
          <button type="button" class="nl4-btn nl4-btn-sm" data-act="toggle-theme" title="切换墨砚/宣纸主题">${isMob ? (theme === "dark" ? "☀" : "🌙") : theme === "dark" ? "☀ 宣纸" : "🌙 墨砚"}</button>
          <button type="button" class="nl4-btn nl4-btn-sm nl4-desktop-only" data-act="center-win" title="窗口居中复位">复位</button>
          <button type="button" class="nl4-btn nl4-btn-sm" data-act="close" aria-label="关闭">✕</button>
        </div>
      </div>`;
  };

  const renderRightBookTabs = (chatState) => {
    const livingCount = Object.keys(chatState.npcs || {}).filter((n) => !isDeceased(chatState, n)).length;
    const activeClocks = (chatState.world?.clocks || []).filter((c) => c.status === "active" || c.status === "triggered").length;
    const tabs = [
      { id: "npcs", label: "人物", badge: livingCount || "" },
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
            ? `<span class="nl4-foot-right">上次约 ${esc(lastTok.tokens)} Token<span class="nl4-desktop-only">（世界书 ${esc(lastTok.worldbookChars)} 字 · 卡片 ${esc(lastTok.cardChars)} 字）</span></span>`
            : `<span class="nl4-foot-right nl4-desktop-only">拖动标题栏可移动 · 右下角可缩放</span>`
        }
      </div>`;
  };

  // Tab 1: Master/Detail Characters + Dedicated Deceased Memorial Archive
  const renderNpcsTab = (settings, chatState) => {
    const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
    const inScene = new Set(detectInSceneNpcs(recent, chatState.npcs));
    const godView = settings.livingWorld?.godView === true;
    const allNames = Object.keys(chatState.npcs || {});
    const livingNames = allNames.filter((n) => !isDeceased(chatState, n));
    const deadNames = allNames.filter((n) => isDeceased(chatState, n));

    if (!selectedNpc || !chatState.npcs[selectedNpc]) {
      selectedNpc = livingNames[0] || deadNames[0] || null;
    }

    const renderRosterItem = (name, isDeadRow) => {
      const card = chatState.npcs[name];
      const deadInfo = chatState.world?.deceased?.[name];
      const hideSpoiler = isDeadRow && deadInfo && !deadInfo.revealed && !godView;
      const subText = hideSpoiler
        ? "暂无最新动向（沉浸防剧透中）"
        : `${card["位置"] || "未知"} · ${card["当前在做"] || "—"}`;
      return `
        <button type="button" class="nl4-roster-item ${selectedNpc === name ? "active" : ""} ${isDeadRow && !hideSpoiler ? "dead" : ""}" data-select-npc="${esc(name)}">
          <div class="nl4-roster-top">
            <span class="nl4-roster-name">${esc(name)}</span>
            <span>
              ${inScene.has(name) && !isDeadRow ? '<span class="nl4-badge nl4-badge-scene">在场</span>' : ""}
              ${isDeadRow && !hideSpoiler ? '<span class="nl4-badge nl4-badge-dead">已故</span>' : ""}
              ${card.tracked === false ? '<span class="nl4-badge">暂停</span>' : ""}
            </span>
          </div>
          <div class="nl4-roster-sub">${esc(subText)}</div>
        </button>`;
    };

    const buildRosterInnerHtml = (filterStr = "") => {
      const q = String(filterStr || "").trim().toLowerCase();
      const matchesFilter = (name) => {
        if (!q) return true;
        const c = chatState.npcs[name];
        const blob = `${name} ${(c?.aliases || []).join(" ")} ${c?.["位置"] || ""} ${c?.["身份锚点"] || ""}`.toLowerCase();
        return blob.includes(q);
      };
      const fLiving = livingNames.filter(matchesFilter);
      const fDead = deadNames.filter(matchesFilter);
      return (
        (fLiving.length
          ? fLiving.map((n) => renderRosterItem(n, false)).join("")
          : `<div class="nl4-muted" style="padding:8px 4px">${q ? "无匹配角色" : "暂无在世角色"}</div>`) +
        (fDead.length
          ? `<details class="nl4-roster-group" ${fDead.includes(selectedNpc) || q ? "open" : ""}>
              <summary>🕊️ 已故归档（${fDead.length}）</summary>
              <div style="display:flex;flex-direction:column;gap:6px">
                ${fDead.map((n) => renderRosterItem(n, true)).join("")}
              </div>
            </details>`
          : "")
      );
    };

    const isMob = resolveLayout() === "mobile";
    const rosterSearchHtml =
      allNames.length > 5
        ? `<input class="nl4-input" id="nl4-roster-search" type="search" value="${esc(rosterFilter)}" placeholder="${isMob ? "🔍 筛选" : "🔍 筛选角色名 / 别名 / 地点…"}" style="margin-bottom:6px">`
        : "";
    const rosterHtml = `${rosterSearchHtml}<div id="nl4-roster-items" style="display:flex;flex-direction:column;gap:6px">${buildRosterInnerHtml(rosterFilter)}</div>`;

    let detailHtml = `<div class="nl4-empty">点击左侧角色查看幕后详情，或在上方手动添加追踪角色。</div>`;
    if (selectedNpc && chatState.npcs[selectedNpc]) {
      const name = selectedNpc;
      const card = chatState.npcs[name];
      const deadInfo = chatState.world?.deceased?.[name] || null;
      const hideSpoiler = Boolean(deadInfo && !deadInfo.revealed && !godView);
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
        const deathBannerHtml = deadInfo
          ? hideSpoiler
            ? `<div class="nl4-now-banner" style="margin:10px 0">
                <div><b>状态遮罩中（沉浸防剧透）</b></div>
                <div class="nl4-muted" style="margin-top:2px">主角暂未获知该角色最新遭遇，亲临现场或开启「上帝视角」后可见。</div>
              </div>`
            : `<div class="nl4-death-banner">
                <div class="nl4-card-head">
                  <b>🕊️ 已故档案 · ${esc(deadInfo.reason || "已离世")}</b>
                  <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="revive-npc" data-npc="${esc(name)}">🕊️ 复活 / 撤销死亡</button>
                </div>
                <div class="nl4-muted" style="margin-top:4px">
                  时间：${esc(deadInfo.at || "未知")} · 地点：${esc(deadInfo.location || "未知")} · ${deadInfo.revealed ? "主角已知晓" : "尚未揭晓（上帝视角可见）"}
                </div>
                ${
                  Array.isArray(deadInfo.traces) && deadInfo.traces.length
                    ? `<div style="margin-top:6px;font-size:12.5px"><b>现场遗留痕迹：</b><ul class="nl4-trace-list">${deadInfo.traces.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`
                    : ""
                }
              </div>`
          : `<div class="nl4-now-banner" style="margin:10px 0">
              <div><b>此刻正在：</b>${esc(card["当前在做"] || "暂无记录")}</div>
              <div class="nl4-muted" style="margin-top:2px">位置：${esc(card["位置"] || "未知")} · 状态：${esc(card["当前状态"] || "—")}</div>
            </div>`;

        detailHtml = `
          <div class="nl4-box">
            <div class="nl4-card-head">
              <div class="nl4-row-gap">
                <h3 class="nl4-h3">${esc(name)}</h3>
                ${inScene.has(name) && !deadInfo ? '<span class="nl4-badge nl4-badge-scene">在场</span>' : ""}
                ${deadInfo && !hideSpoiler ? '<span class="nl4-badge nl4-badge-dead">已故</span>' : ""}
                ${!tracked ? '<span class="nl4-badge">已暂停</span>' : ""}
                ${aliasesStr ? `<span class="nl4-muted">别名：${esc(aliasesStr)}</span>` : ""}
              </div>
              <div class="nl4-row-gap">
                <button type="button" class="nl4-btn nl4-btn-sm" data-act="edit-npc" data-npc="${esc(name)}">编辑</button>
                <button type="button" class="nl4-btn nl4-btn-sm" data-act="toggle-npc" data-npc="${esc(name)}">${tracked ? "暂停" : "恢复"}</button>
                <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-act="del-npc" data-npc="${esc(name)}">删除</button>
              </div>
            </div>

            ${deathBannerHtml}

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
        <div class="nl4-npc-split">
          <div class="nl4-npc-roster">${rosterHtml}</div>
          <div class="nl4-npc-detail">${detailHtml}</div>
        </div>

        <details class="nl4-box nl4-add-drawer" ${allNames.length === 0 ? "open" : ""}>
          <summary>＋ 手动添加角色</summary>
          <div class="nl4-form-grid" style="margin-top:8px">
            <label>角色名 *<input class="nl4-input" id="nl4-add-name" placeholder="如：林霜"></label>
            <label>别名（可选）<input class="nl4-input" id="nl4-add-aliases" placeholder="如：霜姐、林铁匠"></label>
            <label class="nl4-span-2">身份锚点<input class="nl4-input" id="nl4-add-anchor" placeholder="一句定型：身份/性格底色/典型一天作息"></label>
            <label>初始位置<input class="nl4-input" id="nl4-add-loc" placeholder="如：城北铁匠铺"></label>
            <label>当前在做<input class="nl4-input" id="nl4-add-doing" placeholder="如：整理锻炉"></label>
          </div>
          <div style="margin-top:8px"><button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="add-npc">添加角色</button></div>
        </details>
      </div>`;
  };

  // Tab 2: Living World, World Trends (0-cost), & Fate Clocks
  const renderWorldTab = (settings, chatState) => {
    const lw = settings.livingWorld;
    const w = chatState.world;
    const clocks = w.clocks || [];
    const trends = (w.trends || []).filter((t) => t && t.status === "active");
    const knows = (w.ledger?.knows || []).filter((k) => k.status !== "done").slice(-10).reverse();
    const queue = (w.queue || []).filter((q) => q.status === "pending");

    const trendsHtml = trends.length
      ? trends
          .map(
            (t) => `
          <div class="nl4-card">
            <div class="nl4-card-head">
              <div><span class="nl4-badge">${esc(t.scope || "公开")}</span> <b>${esc(t.location || "全域")}</b> · ${esc(t.content)}</div>
              <div class="nl4-row-gap">
                <button type="button" class="nl4-btn nl4-btn-sm" data-act="settle-trend" data-id="${esc(t.id)}">已平息</button>
                <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-act="del-trend" data-id="${esc(t.id)}">删</button>
              </div>
            </div>
          </div>`
          )
          .join("")
      : `<div class="nl4-muted">当前无活跃公共局势。正文发生重大公开事件时会自动随更新记录（0 额外请求），也可手动添加。</div>`;

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
      : `<div class="nl4-muted">暂无命运钟。可手动添加、扫描世界书，或开启「正文危机自动挂钟」。</div>`;

    return `
      <div class="nl4-section">
        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">🌍 世界近况（公共局势 · 最多 5 条活跃）</h3>
            <div class="nl4-row-gap">
              <span class="nl4-muted">上帝视角</span>
              <label class="nl4-switch" title="临时切换是否显示未揭晓的死亡/变故剧透">
                <input type="checkbox" data-lw="godView" ${lw.godView ? "checked" : ""}>
                <span class="nl4-slider"></span>
              </label>
            </div>
          </div>
          <div class="nl4-card-list" style="margin-top:8px">${trendsHtml}</div>
          <details style="margin-top:8px">
            <summary class="nl4-muted" style="cursor:pointer">＋ 手动添加世界近况</summary>
            <div class="nl4-form-grid" style="margin:8px 0">
              <label>影响区域<input class="nl4-input" id="nl4-tr-loc" placeholder="如：城北 / 全域"></label>
              <label>传播范围
                <select class="nl4-input" id="nl4-tr-scope">
                  <option value="公开">公开公告 / 街坊皆知</option>
                  <option value="传闻">坊间风声 / 传闻</option>
                </select>
              </label>
              <label class="nl4-span-2">局势内容 *<input class="nl4-input" id="nl4-tr-content" placeholder="如：官府宣布城北宵禁三日，商旅进出受限"></label>
            </div>
            <button type="button" class="nl4-btn nl4-btn-primary nl4-btn-sm" data-act="add-trend">添加世界近况</button>
          </details>
        </div>

        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">⏳ 命运钟（死亡 / 危急 / 失踪 / 离开 / 背叛）</h3>
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="scan-clocks" ${busyText ? "disabled" : ""}>扫描世界书危机</button>
          </div>
          <div class="nl4-card-list" style="margin-top:8px">${clocksHtml}</div>
          <details style="margin-top:8px">
            <summary class="nl4-muted" style="cursor:pointer">＋ 手动添加命运钟</summary>
            <div class="nl4-form-grid" style="margin:8px 0">
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
          </details>
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

  // Tab 3: Sub-API & Prompt Controls (One-per-row Toggles)
  const renderApiTab = (settings) => {
    const api = settings.api;
    const segs = settings.customSegments || [];

    const segsHtml = segs.length
      ? segs
          .map(
            (s, idx) => `
          <div class="nl4-card">
            <div class="nl4-card-head">
              <div class="nl4-row-gap">
                <label class="nl4-switch" style="transform:scale(0.84)">
                  <input type="checkbox" data-seg-toggle="${idx}" ${s.enabled !== false ? "checked" : ""}>
                  <span class="nl4-slider"></span>
                </label>
                <b>${esc(s.name || `段 ${idx + 1}`)}</b>
              </div>
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
      : `<div class="nl4-muted">暂无自定义附加提示词段。</div>`;

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
            <label>模型名称 *
              <div class="nl4-row-gap" style="flex-wrap:nowrap">
                <input class="nl4-input" list="nl4-model-datalist" data-api="model" value="${esc(api.model)}" placeholder="如：deepseek-chat / gemini-2.5-flash">
                <button type="button" class="nl4-btn nl4-btn-sm" style="white-space:nowrap" data-act="fetch-models" ${busyText ? "disabled" : ""}>获取模型</button>
              </div>
              <datalist id="nl4-model-datalist">
                ${fetchedModels.map((m) => `<option value="${esc(m)}"></option>`).join("")}
              </datalist>
            </label>
            ${
              fetchedModels.length
                ? `<label class="nl4-span-2">从已获取的模型列表快速选择（共 ${fetchedModels.length} 个）
                    <select class="nl4-input" data-api="model">
                      <option value="">-- 请选择模型 --</option>
                      ${fetchedModels.map((m) => `<option value="${esc(m)}" ${api.model === m ? "selected" : ""}>${esc(m)}</option>`).join("")}
                    </select>
                  </label>`
                : ""
            }
            <label>温度<input class="nl4-input" type="number" step="0.1" min="0" max="2" data-api="temperature" value="${esc(api.temperature)}"></label>
            <label>最大输出 Token（多角色建议 ≥ 4096）<input class="nl4-input" type="number" min="512" max="32768" step="512" data-api="maxTokens" value="${esc(api.maxTokens)}"></label>
          </div>
          <div class="nl4-setting-list" style="margin-top:8px">
            ${renderControlRow({ title: "请求超时秒数", desc: "超过设定秒数自动中止，避免后台卡死（15~240 秒）", controlHtml: `<input class="nl4-input nl4-num" type="number" min="15" max="240" data-api="timeoutSec" value="${esc(api.timeoutSec)}">` })}
            ${renderToggleRow({ title: "浏览器直连副 API（推荐）", desc: "开启后直接请求上述端点；若遇跨域 CORS 拦截再关闭改走酒馆转发", attrs: 'data-api="direct"', checked: api.direct !== false })}
          </div>
        </div>

        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">🧩 默认系统提示词（保留去中心化 / 防全知 / 反雷同核心规则）</h3>
            <div class="nl4-row-gap">
              <button type="button" class="nl4-btn nl4-btn-sm" data-act="copy-sys-prompt">📋 复制当前提示词</button>
              ${settings.customSystemPrompt ? '<button type="button" class="nl4-btn nl4-btn-sm" data-act="reset-sys-prompt">恢复内置默认</button>' : ""}
            </div>
          </div>
          <div class="nl4-setting-list" style="margin-top:6px">
            ${renderToggleRow({ title: "精简快跑提示词", desc: "约 1100 字高信噪比核心规则，更快更省 Token；关闭可切完整经典详规", attrs: 'data-setting="compactPrompt"', checked: settings.compactPrompt !== false })}
            ${renderToggleRow({ title: "启用 JSON 预填充（Prefill）", desc: "在请求末尾预填 { 引导模型直接出纯 JSON，减少废话与拒答", attrs: 'data-setting="prefillJson"', checked: settings.prefillJson === true })}
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
          <h3 class="nl4-h3">📌 自定义附加提示词段</h3>
          <div class="nl4-form-grid" style="margin:10px 0">
            <label>段落名称<input class="nl4-input" id="nl4-seg-name" placeholder="如：自定义破限 / 文风"></label>
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
            <label class="nl4-span-2">内容<textarea class="nl4-textarea" id="nl4-seg-content" rows="2" placeholder="填写要插入副 API 的附加提示词..."></textarea></label>
          </div>
          <div class="nl4-card-list">${segsHtml}</div>
        </div>
      </div>`;
  };

  // Tab 4: Worldbook, Cost Controls (One-per-row Toggles), & Diagnostics
  const renderSettingsTab = (settings) => {
    const wb = settings.worldbook;
    const cost = settings.cost;
    const lw = settings.livingWorld;
    const logs = getDiagnosticLogs();
    const preview = engine.getMainInjectionPreview();
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
          <h3 class="nl4-h3">⚙️ 核心运行开关</h3>
          <div class="nl4-setting-list" style="margin-top:6px">
            ${renderToggleRow({ title: "启用 NPC Life 后台引擎", desc: "总开关；关闭后不会自动请求副 API 或向主模型注入提示词", attrs: 'data-setting="enabled"', checked: settings.enabled })}
            ${renderToggleRow({ title: "AI 回复后自动更新角色", desc: "每轮新剧情结束后自动用副 API 推进在场与幕后角色状态", attrs: 'data-setting="autoUpdate"', checked: settings.autoUpdate })}
            ${renderToggleRow({ title: "自动识别并建档新 NPC", desc: "关闭后仅更新已追踪名单中的角色，不再为新出场人物建卡", attrs: 'data-setting="autoTrack"', checked: settings.autoTrack })}
          </div>
        </div>

        <div class="nl4-box">
          <h3 class="nl4-h3">🌍 活世界与命运钟开关</h3>
          <div class="nl4-setting-list" style="margin-top:6px">
            ${renderToggleRow({ title: "启用活世界引擎", desc: "开启防全知知情账本、本地传闻扩散与主动偶遇队列", attrs: 'data-lw="enabled"', checked: lw.enabled })}
            ${renderToggleRow({ title: "启用轻量「世界近况」（0 额外请求）", desc: "记录封城/天灾/祭典等公共大事并同轮喂给幕后 NPC，保持大环境连贯", attrs: 'data-lw="worldTrendsEnabled"', checked: lw.worldTrendsEnabled !== false })}
            ${renderToggleRow({ title: "启用命运钟与真实死亡后果", desc: "按剧情天数推进危机倒计时；死亡自动生成现场遗留痕迹并严防诈尸", attrs: 'data-lw="fateClocks"', checked: lw.fateClocks })}
            ${renderToggleRow({ title: "正文危机自动挂命运钟（0 额外请求）", desc: "正文出现中毒/囚禁断粮/重伤垂危等限时危机时，由主更新顺带挂钟", attrs: 'data-lw="autoCreateClocksFromProse"', checked: lw.autoCreateClocksFromProse !== false })}
            ${renderToggleRow({ title: "按角色隔离侧写（进阶防全知）", desc: "每轮按单个角色隔离上下文独立请求副 API（会增加本轮请求次数）", attrs: 'data-lw="isolatedNpcCalls"', checked: lw.isolatedNpcCalls })}
            ${renderControlRow({ title: "隔离侧写单轮人数上限", desc: "限制开启隔离侧写时每轮最多更新多少个角色（1~6 人）", controlHtml: `<input class="nl4-input nl4-num" type="number" min="1" max="6" data-lw="isolatedMaxNpcs" value="${esc(lw.isolatedMaxNpcs)}">` })}
            ${renderToggleRow({ title: "自动增量扫描世界书危机", desc: "按条目哈希增量提取世界书里的潜伏命运钟（默认关，可去活世界页手动扫）", attrs: 'data-lw="autoScanWorldbook"', checked: lw.autoScanWorldbook })}
          </div>
        </div>

        <div class="nl4-box">
          <div class="nl4-card-head">
            <h3 class="nl4-h3">📚 世界书读写与主模型注入</h3>
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="sync-wb">立即同步世界书</button>
          </div>
          <div class="nl4-setting-list" style="margin-top:6px">
            ${renderToggleRow({ title: "后台更新时读取世界书参考", desc: "按与当前 NPC 的相关度筛选设定条目喂给副 API", attrs: 'data-wb="readEnabled"', checked: wb.readEnabled !== false })}
            ${renderControlRow({
              title: "世界书写入目标",
              desc: "群聊选主世界书时会自动平滑回退到聊天世界书",
              controlHtml: `<select class="nl4-input nl4-select-sm" data-wb="writeTarget">
                <option value="chat" ${wb.writeTarget === "chat" ? "selected" : ""}>聊天世界书（推荐）</option>
                <option value="primary" ${wb.writeTarget === "primary" ? "selected" : ""}>角色卡主世界书</option>
                <option value="off" ${wb.writeTarget === "off" ? "selected" : ""}>关闭写入</option>
              </select>`
            })}
            ${renderControlRow({
              title: "注入主模型字段模式",
              desc: "搭配总结/数据库插件时推荐切「极简动态」，插件内部仍保留全量记录；「藏起来的打算」默认不注入防剧透",
              controlHtml: `<select class="nl4-input nl4-select-sm" data-wb="injectMode">
                <option value="full" ${wb.injectMode === "full" ? "selected" : ""}>全量注入（默认）</option>
                <option value="minimal" ${wb.injectMode === "minimal" ? "selected" : ""}>极简动态（仅位置/在做/状态）</option>
                <option value="custom" ${wb.injectMode === "custom" ? "selected" : ""}>自定义勾选列</option>
              </select>`
            })}
            ${renderToggleRow({
              title: "无世界书时原生直注 NPC 状态表",
              desc: "关闭世界书写入或未安装酒馆助手时，自动通过酒馆原生扩展提示词直接注入 NPC 状态表",
              attrs: 'data-wb="nativeInjectFallback"',
              checked: wb.nativeInjectFallback !== false
            })}
            ${renderControlRow({
              title: "原生提示词注入深度 (Depth)",
              desc: "活世界边界 / 死亡铁律 / 原生直注状态表在聊天历史中的插入深度（0~10，默认 3）",
              controlHtml: `<input class="nl4-input nl4-num" type="number" min="0" max="10" data-wb-num="injectDepth" value="${esc(wb.injectDepth ?? 3)}">`
            })}
          </div>
          <div class="nl4-field-chips" style="margin-top:10px">
            ${WB_FIELD_DEFS.map(
              (f) => `<label class="nl4-chip"><input type="checkbox" data-wb-field="${esc(f.key)}" ${activeFields.includes(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`
            ).join("")}
          </div>
          <details style="margin-top:10px">
            <summary class="nl4-muted" style="cursor:pointer">👁️ 预览当前注入给主模型的内容（总计约 ${esc(preview.totalTokens)} Token）</summary>
            <div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">
              <div class="nl4-muted"><b>通道 A · 世界书条目：</b>${preview.worldbookActive ? "已启用" : "未启用（已走通道 B 原生兜底）"}</div>
              <pre class="nl4-card nl4-pre" style="margin:0;max-height:150px;overflow:auto;font-size:11.5px">${esc(preview.worldbookText || "（当前无世界书条目输出）")}</pre>
              <div class="nl4-muted"><b>通道 B · 原生直注（Depth ${esc(wb.injectDepth ?? 3)}）：</b></div>
              <pre class="nl4-card nl4-pre" style="margin:0;max-height:150px;overflow:auto;font-size:11.5px">${esc(preview.nativeInjectionText || "（当前无额外原生注入内容）")}</pre>
            </div>
          </details>
        </div>

        <div class="nl4-box">
          <h3 class="nl4-h3">💰 成本熔断与省 Token</h3>
          <div class="nl4-setting-list" style="margin-top:6px">
            ${renderToggleRow({ title: "智能省 Token 瘦身", desc: "世界书相关度上限 + 人设一次性注入 + 紧凑 JSON + 缓存前缀（保留完整正文与状态卡）", attrs: 'data-cost="tokenSlimMode"', checked: cost.tokenSlimMode !== false })}
            ${renderToggleRow({ title: "跳过无变化空转轮（可选省钱）", desc: "无在场 NPC 且剧情时间未推进时省 1 次请求；默认关以保持幕后每轮活跃", attrs: 'data-cost="skipIdleTurns"', checked: cost.skipIdleTurns === true })}
            ${renderControlRow({ title: "每轮副 API 请求硬上限", desc: "设为 0 即纯本地零消耗模式，彻底防止意外刷爆额度", controlHtml: `<input class="nl4-input nl4-num" type="number" min="0" max="10" data-cost="maxSubApiCallsPerTurn" value="${esc(cost.maxSubApiCallsPerTurn)}">` })}
            ${renderControlRow({ title: "世界书读取字数上限", desc: "控制单次喂给副 API 的世界书总量（1,000 ~ 30,000 字）", controlHtml: `<input class="nl4-input nl4-num" type="number" min="1000" max="30000" step="500" data-cost="worldbookCharCap" value="${esc(cost.worldbookCharCap)}">` })}
            ${renderControlRow({ title: "单条正文字数上限（0 = 不截断）", desc: "默认 0 完整保留全部正文与状态栏，仅清思维链噪音", controlHtml: `<input class="nl4-input nl4-num" type="number" min="0" max="20000" step="500" data-cost="replyCharCap" value="${esc(cost.replyCharCap)}">` })}
            ${renderControlRow({ title: "读取最近回复条数", desc: "每次后台更新附带最近几楼 AI 回复作为上下文（1~6 条）", controlHtml: `<input class="nl4-input nl4-num" type="number" min="1" max="6" data-setting-num="recentReplyCount" value="${esc(settings.recentReplyCount)}">` })}
            ${renderToggleRow({ title: "显示屏幕悬浮「小地球」图标", desc: "关闭后仍可从酒馆魔法棒菜单或扩展设置里打开浮窗", attrs: 'data-setting="showFloatingButton"', checked: settings.showFloatingButton !== false })}
            ${renderToggleRow({ title: "悬浮「小地球」贴边半隐藏", desc: "闲置时自动半隐藏在屏幕左右边缘只露出一点不挡正文，轻点或拖动即滑出", attrs: 'data-setting="orbAutoHideEdge"', checked: settings.orbAutoHideEdge !== false })}
            ${renderControlRow({
              title: "面板布局模式",
              desc: "自动模式在手机窄屏下启用「左人右信息」紧凑双栏，电脑端保持完整手账布局",
              controlHtml: `<select class="nl4-input nl4-select-sm" data-setting="uiLayout">
                <option value="auto" ${(settings.uiLayout || "auto") === "auto" ? "selected" : ""}>自动识别电脑 / 手机端（推荐）</option>
                <option value="mobile" ${settings.uiLayout === "mobile" ? "selected" : ""}>强制手机端（左人右信息）</option>
                <option value="desktop" ${settings.uiLayout === "desktop" ? "selected" : ""}>强制电脑端手账布局</option>
              </select>`
            })}
          </div>
        </div>

        <div class="nl4-box">
          <h3 class="nl4-h3">🩺 最近 5 次副 API 请求诊断</h3>
          <div class="nl4-logs">${logsHtml}</div>
        </div>

        <div class="nl4-box">
          <div class="nl4-bar">
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="export-chat">导出当前聊天档案 JSON</button>
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="import-chat">导入聊天档案 JSON</button>
            <button type="button" class="nl4-btn nl4-btn-sm" data-act="check-update" ${busyText ? "disabled" : ""}>检查线上新版</button>
            <button type="button" class="nl4-btn nl4-btn-sm nl4-btn-danger" data-act="clear-chat">清空当前聊天 NPC 数据</button>
          </div>
          <input type="file" id="nl4-import-file" accept=".json,application/json" class="nl4-hidden">
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

    const mainClass = activeTab === "npcs" ? "nl4-main nl4-main-npcs" : "nl4-main";
    panel.innerHTML =
      renderTopbar(settings, chatState) +
      `<div class="${mainClass}">${body}</div>` +
      renderFoot(settings, budgetSnap) +
      renderRightBookTabs(chatState) +
      `<div class="nl4-resize" title="拖拽缩放窗口"></div>`;
  };

  panel.addEventListener("dblclick", (e) => {
    if (e.target.closest(".nl4-topbar") && !e.target.closest("button")) {
      centerPanel();
    }
  });

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
    if (act === "center-win") return centerPanel();
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
        if (res.ok) {
          if (res.truncated) {
            host.toast.warn(`更新完成（变动 ${res.changedNpcs.length} 人），但输出被 maxTokens 截断，请在「接口」调大最大输出 Token`);
          } else {
            host.toast.success(`更新完成（变动 ${res.changedNpcs.length} 人，约 ${res.tokens} Token）`);
          }
        } else host.toast.warn(res.error || res.reason || "本次未更新");
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

    if (act === "toggle-npc") return await engine.toggleNpcTracked(actBtn.dataset.npc);
    if (act === "revive-npc") {
      await engine.reviveNpc(actBtn.dataset.npc);
      host.toast.success(`已复活「${actBtn.dataset.npc}」`);
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

    if (act === "add-trend") {
      const content = panel.querySelector("#nl4-tr-content")?.value?.trim();
      if (!content) return host.toast.warn("请填写世界近况内容");
      upsertWorldTrend(engine.getChatState(), {
        location: panel.querySelector("#nl4-tr-loc")?.value?.trim() || "全域",
        scope: panel.querySelector("#nl4-tr-scope")?.value || "公开",
        content
      });
      await engine.persistState(null, false);
      host.toast.success("已添加世界近况");
      return;
    }
    if (act === "settle-trend") {
      const t = (engine.getChatState().world.trends || []).find((x) => x.id === actBtn.dataset.id);
      if (t) {
        t.status = "settled";
        await engine.persistState(null, false);
      }
      return;
    }
    if (act === "del-trend") {
      const w = engine.getChatState().world;
      w.trends = (w.trends || []).filter((x) => x.id !== actBtn.dataset.id);
      await engine.persistState(null, false);
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

    if (act === "fetch-models") {
      busyText = "拉取中…";
      render();
      try {
        const res = await fetchModelList(host, engine.getSettings());
        if (res.ok) {
          fetchedModels = res.models;
          host.toast.success(`已获取 ${res.models.length} 个模型，可在下拉框直接选择`);
        } else {
          host.toast.warn(`获取模型失败：${res.error}`);
        }
      } finally {
        busyText = "";
        render();
      }
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
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
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

    if (act === "import-chat") {
      panel.querySelector("#nl4-import-file")?.click();
      return;
    }

    if (act === "check-update") {
      busyText = "检查中…";
      render();
      try {
        const urls = [
          `https://cdn.jsdelivr.net/gh/muzi9277/st-npc-life@main/manifest.json?t=${Date.now()}`,
          `https://raw.githubusercontent.com/muzi9277/st-npc-life/main/manifest.json?t=${Date.now()}`
        ];
        let remoteVer = "";
        for (const u of urls) {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(u, { cache: "no-store", signal: ctrl.signal }).finally(() => clearTimeout(timer));
            if (r.ok) {
              const j = await r.json();
              if (j?.version) {
                remoteVer = String(j.version).trim();
                break;
              }
            }
          } catch {}
        }
        if (!remoteVer) {
          host.toast.warn("未能连接 GitHub 检查版本（请检查网络/代理）");
        } else if (remoteVer === VERSION) {
          host.toast.success(`当前已是最新版本 v${VERSION}`);
        } else {
          host.toast.info(`发现仓库版本 v${remoteVer}（当前 v${VERSION}），请到酒馆「扩展→管理扩展」点更新后强刷页面`);
        }
      } finally {
        busyText = "";
        render();
      }
      return;
    }

    if (act === "clear-chat") {
      await engine.clearCurrentChat();
      selectedNpc = null;
      host.toast.info("已清空当前聊天的 NPC Life 数据");
      render();
    }
  });

  // Live roster search filter without losing input focus
  panel.addEventListener("input", (e) => {
    if (e.target.id === "nl4-roster-search") {
      rosterFilter = e.target.value;
      const box = panel.querySelector("#nl4-roster-items");
      if (box) {
        const chatState = engine.getChatState();
        const settings = engine.getSettings();
        const recent = host.chat.getRecentAssistantMessages(1)[0]?.message || "";
        const inScene = new Set(detectInSceneNpcs(recent, chatState.npcs));
        const godView = settings.livingWorld?.godView === true;
        const allNames = Object.keys(chatState.npcs || {});
        const q = rosterFilter.trim().toLowerCase();
        const match = (name) => {
          if (!q) return true;
          const c = chatState.npcs[name];
          return `${name} ${(c?.aliases || []).join(" ")} ${c?.["位置"] || ""} ${c?.["身份锚点"] || ""}`.toLowerCase().includes(q);
        };
        const living = allNames.filter((n) => !isDeceased(chatState, n) && match(n));
        const dead = allNames.filter((n) => isDeceased(chatState, n) && match(n));
        const rowHtml = (name, isDeadRow) => {
          const card = chatState.npcs[name];
          const deadInfo = chatState.world?.deceased?.[name];
          const hideSpoiler = isDeadRow && deadInfo && !deadInfo.revealed && !godView;
          const subText = hideSpoiler ? "暂无最新动向（沉浸防剧透中）" : `${card["位置"] || "未知"} · ${card["当前在做"] || "—"}`;
          return `<button type="button" class="nl4-roster-item ${selectedNpc === name ? "active" : ""} ${isDeadRow && !hideSpoiler ? "dead" : ""}" data-select-npc="${esc(name)}"><div class="nl4-roster-top"><span class="nl4-roster-name">${esc(name)}</span><span>${inScene.has(name) && !isDeadRow ? '<span class="nl4-badge nl4-badge-scene">在场</span>' : ""}${isDeadRow && !hideSpoiler ? '<span class="nl4-badge nl4-badge-dead">已故</span>' : ""}${card.tracked === false ? '<span class="nl4-badge">暂停</span>' : ""}</span></div><div class="nl4-roster-sub">${esc(subText)}</div></button>`;
        };
        box.innerHTML =
          (living.length ? living.map((n) => rowHtml(n, false)).join("") : `<div class="nl4-muted" style="padding:8px 4px">${q ? "无匹配角色" : "暂无在世角色"}</div>`) +
          (dead.length ? `<details class="nl4-roster-group" ${dead.includes(selectedNpc) || q ? "open" : ""}><summary>🕊️ 已故归档（${dead.length}）</summary><div style="display:flex;flex-direction:column;gap:6px">${dead.map((n) => rowHtml(n, true)).join("")}</div></details>` : "");
      }
    }
  });

  panel.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.id === "nl4-import-file" && el.files?.[0]) {
      try {
        const text = await el.files[0].text();
        const parsed = JSON.parse(text);
        await engine.importChatState(parsed);
        selectedNpc = null;
        host.toast.success("成功导入聊天档案！");
        render();
      } catch (err) {
        host.toast.error(`导入失败：${err?.message || err}`);
      } finally {
        el.value = "";
      }
      return;
    }
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
      await engine.persistState(null, true).catch(() => {});
      return;
    }
    if (el.dataset.wbNum) {
      const k = el.dataset.wbNum;
      engine.updateSettings((s) => {
        s.worldbook[k] = Math.max(0, Math.min(10, Math.round(Number(el.value) || 0)));
        return s;
      });
      await engine.persistState(null, false).catch(() => {});
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
      if (dockTimer) {
        clearTimeout(dockTimer);
        dockTimer = null;
      }
      window.removeEventListener("resize", onViewportResize);
      window.removeEventListener("orientationchange", onViewportResize);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      root.remove();
      document.getElementById("nl4-ext-menu-item")?.remove();
      document.getElementById("nl4-st-drawer-box")?.remove();
    }
  };
}
