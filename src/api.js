import { MAX_DIAGNOSTIC_LOGS } from "./constants.js";
import { estimateTokens } from "./text.js";

const diagnosticLogs = [];

export function recordDiagnostic(entry) {
  const row = {
    at: Date.now(),
    kind: String(entry.kind || "update"),
    status: String(entry.status || "ok"), // "ok" | "error" | "skipped" | "budget"
    durationMs: Number(entry.durationMs) || 0,
    tokens: Number(entry.tokens) || 0,
    worldbookChars: Number(entry.worldbookChars) || 0,
    cardChars: Number(entry.cardChars) || 0,
    replyChars: Number(entry.replyChars) || 0,
    model: String(entry.model || ""),
    route: String(entry.route || ""),
    detail: String(entry.detail || "")
  };
  diagnosticLogs.unshift(row);
  if (diagnosticLogs.length > MAX_DIAGNOSTIC_LOGS) diagnosticLogs.length = MAX_DIAGNOSTIC_LOGS;
  return row;
}

export function getDiagnosticLogs() {
  return [...diagnosticLogs];
}

export function getLastTokenStats() {
  const found = diagnosticLogs.find((x) => x.tokens > 0 && x.status === "ok");
  return found || diagnosticLogs.find((x) => x.tokens > 0) || null;
}

export function clearDiagnosticLogs() {
  diagnosticLogs.length = 0;
}

/**
 * Per-turn hard budget fuse to guarantee sub-API calls never spiral out of control.
 */
export function createTurnBudget(cap = 3) {
  let state = { turnKey: "", used: 0, cap: Math.max(0, Math.round(Number(cap) || 0)) };
  return {
    reset(turnKey, nextCap) {
      const cleanCap = Number.isFinite(Number(nextCap)) ? Math.max(0, Math.round(Number(nextCap))) : state.cap;
      if (state.turnKey === turnKey) {
        state.cap = cleanCap;
        return;
      }
      state = { turnKey: String(turnKey || ""), used: 0, cap: cleanCap };
    },
    take(bypass = false) {
      if (bypass) return { allowed: true, used: state.used, cap: state.cap };
      if (state.cap <= 0 || state.used >= state.cap) {
        return { allowed: false, used: state.used, cap: state.cap };
      }
      state.used += 1;
      return { allowed: true, used: state.used, cap: state.cap };
    },
    snapshot() {
      return { ...state };
    }
  };
}

export function isSubApiConfigured(settings) {
  const api = settings?.api || {};
  return Boolean(String(api.apiurl || "").trim() && String(api.model || "").trim());
}

function normalizeEndpoint(rawUrl) {
  const u = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (/\/chat\/completions$/i.test(u)) return u;
  return `${u}/chat/completions`;
}

function normalizeModelsEndpoint(rawUrl) {
  const u = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (/\/models$/i.test(u)) return u;
  if (/\/chat\/completions$/i.test(u)) return u.replace(/\/chat\/completions$/i, "/models");
  return `${u}/models`;
}

function isMaxTokensConflict(msg) {
  const s = String(msg || "").toLowerCase();
  return (
    (s.includes("max_tokens") && s.includes("max_completion_tokens")) ||
    s.includes("cannot be set at the same time") ||
    s.includes("unsupported parameter: 'max_tokens'")
  );
}

function isMaxTokensRangeErr(msg) {
  const s = String(msg || "").toLowerCase();
  return s.includes("max_tokens") && (s.includes("range") || s.includes("exceed") || s.includes("too large") || s.includes("invalid"));
}

function isErrorTextPayload(text) {
  const s = String(text || "").trim();
  return s.startsWith("[API 错误]") || s.startsWith("[API Error]") || /^API Error:/i.test(s);
}

async function fetchDirectOnce(api, messages, maxTokens, signal) {
  const url = normalizeEndpoint(api.apiurl);
  const headers = { "Content-Type": "application/json" };
  if (api.key && String(api.key).trim()) {
    headers.Authorization = `Bearer ${String(api.key).trim()}`;
  }
  const body = {
    model: String(api.model).trim(),
    messages,
    temperature: Number.isFinite(Number(api.temperature)) ? Number(api.temperature) : 0.5,
    stream: false
  };
  if (maxTokens != null && Number(maxTokens) > 0) {
    body.max_tokens = Math.round(Number(maxTokens));
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal
  });
  const rawText = await res.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {}

  if (!res.ok) {
    const errMsg = data?.error?.message || data?.message || rawText.slice(0, 260) || `HTTP ${res.status}`;
    const err = new Error(errMsg);
    err.status = res.status;
    throw err;
  }

  const choice = data?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? "";
  const finishReason = String(choice?.finish_reason || "");
  const str = String(content || "").trim();
  if (!str) throw new Error("副 API 返回内容为空");
  if (isErrorTextPayload(str)) throw new Error(`接口返回错误: ${str}`);
  return { text: str, truncated: finishReason === "length" };
}

async function callViaTavernRelayOnce(host, api, messages, maxTokens) {
  const th = host.getTH?.();
  if (!th || typeof th.generateRaw !== "function") {
    throw new Error("未检测到酒馆转发接口（TavernHelper.generateRaw），请在「接口与提示词」开启直连模式");
  }
  // CRITICAL: Pass non-empty ordered_prompts + max_chat_history: 0 so ST NEVER injects main chat history!
  const orderedPrompts = messages.map((m) => ({
    role: m.role || "user",
    content: String(m.content || "")
  }));
  const customApi = {
    apiurl: String(api.apiurl).trim(),
    key: String(api.key || "").trim(),
    model: String(api.model).trim(),
    temperature: Number.isFinite(Number(api.temperature)) ? Number(api.temperature) : 0.5
  };
  if (maxTokens != null && Number(maxTokens) > 0) {
    customApi.max_tokens = Math.round(Number(maxTokens));
  }

  const raw = await th.generateRaw({
    ordered_prompts: orderedPrompts,
    custom_api: customApi,
    max_chat_history: 0,
    should_stream: false
  });
  const str = String(raw || "").trim();
  if (!str) throw new Error("副 API 转发返回为空");
  if (isErrorTextPayload(str)) throw new Error(`接口返回错误: ${str}`);
  return { text: str, truncated: false };
}

/**
 * Call secondary API ONLY. NEVER falls back to SillyTavern's main chat model!
 */
export async function callSubApi(host, settings, messages, opts = {}) {
  const started = Date.now();
  const kind = opts.kind || "update";
  const tokens = estimateTokens(messages);

  if (!isSubApiConfigured(settings)) {
    recordDiagnostic({
      kind,
      status: "skipped",
      tokens: 0,
      detail: "未配置副 API（已跳过，绝不调用主模型）"
    });
    return { ok: false, skipped: true, reason: "未配置副 API（请在「接口与提示词」填写接口地址与模型）" };
  }

  if (opts.budget) {
    const gate = opts.budget.take(Boolean(opts.bypassBudget));
    if (!gate.allowed) {
      recordDiagnostic({
        kind,
        status: "budget",
        tokens: 0,
        detail: `已达本轮上限 ${gate.used}/${gate.cap} 次，已熔断`
      });
      return { ok: false, skipped: true, budgetBlocked: true, reason: `已达本轮上限 ${gate.used}/${gate.cap}` };
    }
  }

  const api = settings.api;
  const route = api.direct !== false ? "直连" : "酒馆转发";
  const timeoutMs = Math.max(15, Math.min(240, Number(api.timeoutSec) || 90)) * 1000;
  let maxTokens = opts.maxTokens != null ? opts.maxTokens : Number(api.maxTokens) || 4096;

  const execOnce = async (mt) => {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      if (api.direct !== false) {
        return await fetchDirectOnce(api, messages, mt, controller?.signal);
      }
      return await callViaTavernRelayOnce(host, api, messages, mt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    let result;
    try {
      result = await execOnce(maxTokens);
    } catch (err) {
      const msg = String(err?.message || err);
      if (isMaxTokensConflict(msg)) {
        result = await execOnce(null);
      } else if (isMaxTokensRangeErr(msg) && maxTokens > 4096) {
        result = await execOnce(4096);
      } else if (err?.status === 429 && !opts.noRetry429) {
        await new Promise((r) => setTimeout(r, 1200));
        result = await execOnce(maxTokens);
      } else {
        throw err;
      }
    }

    const text = result.text;
    const truncated = Boolean(result.truncated);
    const durationMs = Date.now() - started;
    recordDiagnostic({
      kind,
      status: "ok",
      durationMs,
      tokens,
      worldbookChars: opts.worldbookChars || 0,
      cardChars: opts.cardChars || 0,
      replyChars: opts.replyChars || 0,
      model: api.model,
      route,
      detail: truncated
        ? `成功但输出被截断（返回 ${text.length} 字，建议在「接口」调大最大输出 Token）`
        : `成功（返回 ${text.length} 字）`
    });
    return { ok: true, text, truncated, tokens, durationMs, route };
  } catch (err) {
    const durationMs = Date.now() - started;
    const reason = err?.name === "AbortError" ? `请求超时（>${Math.round(timeoutMs / 1000)}s）` : String(err?.message || err);
    recordDiagnostic({
      kind,
      status: "error",
      durationMs,
      tokens,
      worldbookChars: opts.worldbookChars || 0,
      cardChars: opts.cardChars || 0,
      replyChars: opts.replyChars || 0,
      model: api.model,
      route,
      detail: reason
    });
    return { ok: false, error: reason, tokens, durationMs, route };
  }
}

export async function testSubApiConnection(host, settings) {
  return await callSubApi(
    host,
    settings,
    [
      { role: "system", content: "You are a connectivity test. Reply with a single JSON object: {\"ok\":true}" },
      { role: "user", content: "ping" }
    ],
    { kind: "test", bypassBudget: true, maxTokens: 64, noRetry429: true }
  );
}

/**
 * Fetch available model IDs from GET {apiurl}/models (or TavernHelper.getModelList when relay mode is used).
 */
export async function fetchModelList(host, settings) {
  const api = settings?.api || {};
  const rawUrl = String(api.apiurl || "").trim();
  if (!rawUrl) {
    return { ok: false, models: [], error: "请先填写 API 地址" };
  }

  // Try TavernHelper.getModelList first when using relay mode
  if (api.direct === false) {
    const th = host?.getTH?.();
    if (th && typeof th.getModelList === "function") {
      try {
        const list = await th.getModelList({ apiurl: rawUrl, key: String(api.key || "").trim() });
        if (Array.isArray(list) && list.length) {
          const ids = list
            .map((x) => (typeof x === "string" ? x : x?.id || x?.name || ""))
            .filter(Boolean)
            .sort();
          if (ids.length) return { ok: true, models: Array.from(new Set(ids)) };
        }
      } catch {}
    }
  }

  const url = normalizeModelsEndpoint(rawUrl);
  const headers = {};
  if (api.key && String(api.key).trim()) {
    headers.Authorization = `Bearer ${String(api.key).trim()}`;
  }

  try {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller?.signal });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, models: [], error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
      }
      const data = JSON.parse(text);
      const rawList = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      const ids = rawList
        .map((m) => (typeof m === "string" ? m : String(m?.id || m?.name || "").replace(/^models\//, "")))
        .filter(Boolean)
        .sort();
      const unique = Array.from(new Set(ids));
      if (!unique.length) return { ok: false, models: [], error: "接口返回的模型列表为空" };
      return { ok: true, models: unique };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      models: [],
      error: err?.name === "AbortError" ? "获取模型列表超时" : String(err?.message || err)
    };
  }
}

/**
 * Strip markdown fences, prose wrappers, and repair truncated JSON (Gemini 3.8f / Flash friendly).
 */
export function repairTruncatedJson(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  // Remove trailing incomplete escape
  if (s.endsWith("\\")) s = s.slice(0, -1);

  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
    }
  }

  let fixed = s;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*$/, "");
  // If ending right after a colon (e.g., `"key":`), append null
  if (/:\s*$/.test(fixed)) fixed += "null";
  while (stack.length) {
    fixed = fixed.replace(/,\s*$/, "");
    fixed += stack.pop();
  }
  return fixed;
}

export function parseJsonRobust(raw) {
  let text = String(raw || "").trim();
  if (!text) return { ok: false, error: "空响应" };

  // Strip reasoning tags if model leaked them
  text = text.replace(/<\s*(think_nya|think|thinking|thought|reasoning)(?=[\s>/])[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").trim();

  // Extract fenced JSON block if present (including unclosed fence)
  const fenceClosed = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceClosed) {
    text = fenceClosed[1].trim();
  } else {
    const fenceOpen = text.match(/```(?:json)?\s*([\s\S]*)$/i);
    if (fenceOpen) text = fenceOpen[1].trim();
  }

  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) start = firstBrace;
  else if (firstBracket !== -1) start = firstBracket;
  if (start === -1) return { ok: false, error: "未找到 JSON 起始符号" };

  let candidate = text.slice(start);
  const lastBrace = candidate.lastIndexOf("}");
  const lastBracket = candidate.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  const trimmedCandidate = end > 0 ? candidate.slice(0, end + 1) : candidate;

  const attempts = [
    trimmedCandidate,
    trimmedCandidate.replace(/,\s*([}\]])/g, "$1"),
    repairTruncatedJson(candidate.replace(/,\s*([}\]])/g, "$1"))
  ];

  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object") {
        return { ok: true, data: parsed };
      }
    } catch {}
  }
  return { ok: false, error: "JSON 解析失败（含截断修复）" };
}
