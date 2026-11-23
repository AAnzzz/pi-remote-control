/**
 * Dual-mode PI-Desktop Host Adapter:
 * - Standard Mode: official `pi.desktop.invoke` (`desktop.control`), strictly honoring desktop
 *   native confirmation dialogs for dangerous ops (such as `session/configure` and approvals).
 * - Optional Headless MCP Control Mode: when user explicitly starts PI-Desktop with
 *   `PI_DESKTOP_MCP_CONTROL=1`, detects loopback `~/.pi-desktop/mcp-control.json` + token
 *   and allows headless mobile resolution of approvals / asktool / plan checkpoints / session config.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VALID_SESSION_MODES,
  VALID_PERMISSION_MODES,
  VALID_THINKING_LEVELS,
} from "./vendor/protocol/index.mjs";

function safeParseJson(v) {
  if (v && typeof v === "object") return v;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function extractMessageParts(m) {
  if (!m || typeof m !== "object") return { text: "", thinking: "", toolName: null };
  const textParts = [];
  const thinkParts = [];
  let toolName = null;

  const consumeArray = (arr) => {
    for (const part of arr) {
      if (!part) continue;
      if (typeof part === "string") {
        textParts.push(part);
        continue;
      }
      const t = part.type;
      if (t === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      } else if (t === "thinking" || t === "reasoning") {
        const tk = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
        if (tk) thinkParts.push(tk);
      } else if (t === "toolCall" || t === "tool_call" || t === "tool_use") {
        toolName = toolName || part.name || part.toolName || null;
      }
    }
  };

  if (Array.isArray(m.blocks)) {
    consumeArray(m.blocks);
  } else if (Array.isArray(m.content)) {
    consumeArray(m.content);
  } else if (typeof m.content === "string") {
    textParts.push(m.content);
  } else if (typeof m.text === "string") {
    textParts.push(m.text);
  }

  if (typeof m.thinking === "string" && m.thinking) {
    thinkParts.push(m.thinking);
  }

  return {
    text: textParts.join(""),
    thinking: thinkParts.join("\n"),
    toolName,
  };
}

export function normalizeSessionSummary(s, fallbackId = "") {
  const id = s?.id || s?.sessionId || fallbackId;
  const mode = VALID_SESSION_MODES.has(s?.mode) ? s.mode : "agent";
  const permissionMode = VALID_PERMISSION_MODES.has(s?.permissionMode)
    ? s.permissionMode
    : VALID_PERMISSION_MODES.has(s?.permission_mode)
    ? s.permission_mode
    : "inherit";
  const providerId = s?.providerId || s?.provider_id || "";
  const modelId = s?.modelId || s?.model_id || s?.model || "";
  const thinkingLevel = VALID_THINKING_LEVELS.has(s?.thinkingLevel)
    ? s.thinkingLevel
    : VALID_THINKING_LEVELS.has(s?.thinking_level)
    ? s.thinking_level
    : undefined;

  return {
    id,
    title: s?.title || s?.name || "Untitled Session",
    projectPath: s?.projectPath || s?.cwd || "",
    status: s?.activeTurn ? "running" : s?.status || "idle",
    updatedAt: s?.updatedAt || s?.createdAt || new Date().toISOString(),
    mode,
    permissionMode,
    providerId,
    modelId,
    model: modelId || s?.model || "",
    thinkingLevel,
    fastMode: Boolean(s?.fastMode ?? s?.fast_mode),
    activeTurnId: s?.activeTurn?.id || s?.activeTurnId || null,
  };
}

export function normalizeTodoList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const validStatuses = new Set(["pending", "in_progress", "completed", "cancelled"]);
  return rawList
    .filter((item) => item && typeof item.content === "string" && item.content.trim().length > 0)
    .map((item) => ({
      content: item.content.trim().slice(0, 500),
      status: validStatuses.has(item.status) ? item.status : "pending",
      priority: item.priority === "high" || item.priority === "medium" || item.priority === "low" ? item.priority : undefined,
    }));
}

function normalizeTaskState(rawState) {
  const s = String(rawState || "").toLowerCase();
  if (s === "running" || s === "in_progress" || s === "active" || s === "queued") return "running";
  if (s === "completed" || s === "done" || s === "settled" || s === "succeeded") return "completed";
  if (s === "exited") return "exited";
  if (s === "stopped" || s === "canceled" || s === "cancelled") return "stopped";
  if (s === "failed" || s === "error") return "failed";
  return "running";
}

function mergeBackgroundTask(map, incoming) {
  if (!incoming || !incoming.id) return;
  const prev = map.get(incoming.id) || {};
  map.set(incoming.id, {
    ...prev,
    ...incoming,
    title: incoming.title || prev.title || incoming.command || incoming.id,
    command: incoming.command || prev.command,
    agent: incoming.agent || prev.agent,
    outputPreview: incoming.outputPreview || prev.outputPreview,
    exitCode: incoming.exitCode !== undefined ? incoming.exitCode : prev.exitCode ?? null,
    startedAt: prev.startedAt || incoming.startedAt,
    updatedAt: incoming.updatedAt || prev.updatedAt || new Date().toISOString(),
  });
}

export function applyToolTraceToWorkState({ toolName, toolArgs, toolResult, toolStatus, sessionId, timestamp }, state) {
  const name = String(toolName || "");
  const args = safeParseJson(toolArgs) || (toolArgs && typeof toolArgs === "object" ? toolArgs : {});
  const res = safeParseJson(toolResult) || (toolResult && typeof toolResult === "object" ? toolResult : null);
  const ts = timestamp || new Date().toISOString();

  if (name === "TodoWrite" && Array.isArray(args.todos)) {
    state.todos = normalizeTodoList(args.todos);
    return true;
  }

  if (name === "Bash" && args.runInBackground) {
    const taskId = res?.backgroundTaskId || res?.taskId || res?.id || args.backgroundTaskId;
    if (taskId) {
      const cmd = String(args.command || "").trim();
      const shortTitle = cmd.length > 72 ? `${cmd.slice(0, 72)}…` : cmd || "后台命令";
      mergeBackgroundTask(state.tasks, {
        id: String(taskId),
        kind: "bash",
        title: shortTitle,
        command: cmd.slice(0, 400),
        sessionId,
        state: toolStatus === "error" ? "failed" : normalizeTaskState(res?.state || "running"),
        exitCode: typeof res?.exitCode === "number" ? res.exitCode : null,
        outputPreview: res?.stdout || res?.stderr ? String(res.stdout || res.stderr).slice(-400) : undefined,
        startedAt: ts,
        updatedAt: ts,
      });
      return true;
    }
  }

  if (name === "Task") {
    const taskId = res?.delegationId || res?.id;
    if (taskId) {
      mergeBackgroundTask(state.tasks, {
        id: String(taskId),
        kind: "subagent",
        title: String(args.description || args.agent || "Subagent Task").slice(0, 100),
        agent: args.agent ? String(args.agent) : undefined,
        sessionId,
        state: toolStatus === "error" ? "failed" : normalizeTaskState(res?.status || res?.state || "running"),
        startedAt: ts,
        updatedAt: ts,
      });
      return true;
    }
  }

  if (name === "TaskWait" || name === "TaskStop") {
    const jobId = args?.job?.id || res?.id || res?.backgroundTaskId;
    if (jobId) {
      const nextState =
        name === "TaskStop"
          ? normalizeTaskState(res?.state || "stopped")
          : normalizeTaskState(res?.state || (typeof res?.exitCode === "number" ? (res.exitCode === 0 ? "exited" : "failed") : "running"));
      const preview = [res?.stdout, res?.stderr].filter(Boolean).join("\n").slice(-500);
      mergeBackgroundTask(state.tasks, {
        id: String(jobId),
        kind: args?.job?.kind === "bash" ? "bash" : "task",
        sessionId,
        state: nextState,
        exitCode: typeof res?.exitCode === "number" ? res.exitCode : undefined,
        outputPreview: preview || undefined,
        updatedAt: ts,
      });
      return true;
    }
    if (Array.isArray(res?.reports)) {
      for (const rep of res.reports) {
        if (!rep?.delegationId && !rep?.id) continue;
        mergeBackgroundTask(state.tasks, {
          id: String(rep.delegationId || rep.id),
          kind: "subagent",
          title: rep.description || rep.agent || undefined,
          agent: rep.agent || undefined,
          sessionId,
          state: normalizeTaskState(rep.status || rep.state || "completed"),
          outputPreview: rep.summary ? String(rep.summary).slice(0, 400) : undefined,
          updatedAt: ts,
        });
      }
      return true;
    }
  }

  if (name === "TaskList" && res) {
    let changed = false;
    const bashJobs = res.bashJobs || res.backgroundTasks || res.tasks || [];
    if (Array.isArray(bashJobs)) {
      for (const bj of bashJobs) {
        if (!bj?.id) continue;
        mergeBackgroundTask(state.tasks, {
          id: String(bj.id),
          kind: "bash",
          title: String(bj.title || bj.command || bj.id).slice(0, 90),
          command: bj.command ? String(bj.command).slice(0, 400) : undefined,
          sessionId: bj.sessionId || sessionId,
          state: normalizeTaskState(bj.state || bj.status),
          exitCode: typeof bj.exitCode === "number" ? bj.exitCode : null,
          updatedAt: bj.updatedAt || ts,
        });
        changed = true;
      }
    }
    const delegations = res.delegations || res.subagents || [];
    if (Array.isArray(delegations)) {
      for (const d of delegations) {
        const id = d?.delegationId || d?.id;
        if (!id) continue;
        mergeBackgroundTask(state.tasks, {
          id: String(id),
          kind: "subagent",
          title: String(d.description || d.agent || id).slice(0, 90),
          agent: d.agent ? String(d.agent) : undefined,
          sessionId,
          state: normalizeTaskState(d.status || d.state),
          updatedAt: ts,
        });
        changed = true;
      }
    }
    return changed;
  }

  return false;
}

export function extractWorkStateFromRawMessages(rawMessages = [], sessionId = "") {
  const work = { todos: [], tasks: new Map() };
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;
    const ts = m.createdAt || new Date().toISOString();

    if (m.role === "tool") {
      const toolBlock = Array.isArray(m.blocks) ? m.blocks.find((b) => b?.type === "tool_call" || b?.type === "toolCall") : null;
      const toolName = m.toolName || toolBlock?.name || "";
      const toolStatus = m.toolStatus || toolBlock?.status || (toolBlock?.isError ? "error" : "success");
      const toolArgs = m.toolArgs ?? toolBlock?.args ?? toolBlock?.input;
      const toolResult = m.toolResult ?? toolBlock?.result ?? toolBlock?.output;
      if (toolName) {
        applyToolTraceToWorkState({ toolName, toolArgs, toolResult, toolStatus, sessionId, timestamp: ts }, work);
      }
      continue;
    }

    // Also inspect blocks array on assistant messages in case tool_call blocks live inline
    const blocks = Array.isArray(m.blocks) ? m.blocks : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_call" || b.type === "toolCall" || b.type === "tool_use") {
        const toolName = b.name || b.toolName || "";
        if (toolName) {
          applyToolTraceToWorkState(
            {
              toolName,
              toolArgs: b.args ?? b.input,
              toolResult: b.result ?? b.output,
              toolStatus: b.status || (b.isError ? "error" : "success"),
              sessionId,
              timestamp: ts,
            },
            work
          );
        }
      }
    }
  }

  return {
    todos: work.todos,
    backgroundTasks: Array.from(work.tasks.values()).sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    ),
  };
}

export class PiHostAdapter {
  constructor({ pi, allowMcpHeadless = true, mcpConfigDir = null } = {}) {
    this.pi = pi;
    this.allowMcpHeadless = allowMcpHeadless;
    this.mcpConfigDir = mcpConfigDir || path.join(os.homedir(), ".pi-desktop");
    this._mcpState = { available: false, url: null, token: null, checkedAt: 0 };
  }

  setAllowMcpHeadless(enabled) {
    this.allowMcpHeadless = Boolean(enabled);
    this._mcpState.checkedAt = 0;
  }

  async detectCapabilityMode() {
    if (!this.allowMcpHeadless) return "standard";
    const now = Date.now();
    if (now - this._mcpState.checkedAt < 10_000) {
      return this._mcpState.available ? "mcp-full" : "standard";
    }
    this._mcpState.checkedAt = now;
    this._mcpState.available = false;

    try {
      const cfgPath = path.join(this.mcpConfigDir, "mcp-control.json");
      const tokenPath = path.join(this.mcpConfigDir, "mcp-control.token");
      if (!fs.existsSync(cfgPath) || !fs.existsSync(tokenPath)) return "standard";
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const token = fs.readFileSync(tokenPath, "utf8").trim();
      const url = cfg.url || (cfg.port ? `http://127.0.0.1:${cfg.port}/mcp` : null);
      if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) return "standard";

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      try {
        const res = await fetch(url, {
          method: "POST",
          redirect: "error",
          signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "probe",
            method: "tools/list",
            params: {},
          }),
        });
        if (res.ok) {
          this._mcpState = { available: true, url, token, checkedAt: now };
          return "mcp-full";
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // MCP control plane not enabled or unreachable
    }
    return "standard";
  }

  async _desktopInvoke(operation, args = [], { confirm = false, preferMcp = false } = {}) {
    if (preferMcp && (await this.detectCapabilityMode()) === "mcp-full") {
      return this._invokeMcpDesktopOp(operation, args, confirm);
    }
    if (!this.pi?.desktop?.invoke) {
      throw new Error("Host pi.desktop.invoke API is unavailable");
    }
    return this.pi.desktop.invoke({ operation, args, confirm });
  }

  async _invokeMcpDesktopOp(operation, args, confirm) {
    const res = await fetch(this._mcpState.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this._mcpState.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `op-${Date.now()}`,
        method: "tools/call",
        params: {
          name: "pi_desktop_invoke",
          arguments: { operation, args, confirm },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Local MCP control HTTP ${res.status}`);
    }
    const text = await res.text();
    const jsonLine = text.startsWith("{")
      ? text
      : text
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .pop() || "{}";
    const parsed = JSON.parse(jsonLine);
    if (parsed.error) {
      throw new Error(parsed.error.message || "MCP invocation failed");
    }
    const contentText = parsed?.result?.content?.[0]?.text;
    if (contentText) {
      try {
        const inner = JSON.parse(contentText);
        return inner && typeof inner === "object" && "result" in inner && inner.operation === operation
          ? inner.result
          : inner;
      } catch {
        return { text: contentText };
      }
    }
    return parsed.result;
  }

  async listProjects(allowedProjects = []) {
    let raw = [];
    try {
      const res = await this._desktopInvoke("project/list", []);
      raw = Array.isArray(res) ? res : res?.projects || [];
    } catch {
      if (this.pi?.projects?.list) {
        raw = (await this.pi.projects.list()) || [];
      }
    }
    const normalized = raw
      .map((p) => {
        if (typeof p === "string") {
          return { path: p, name: path.basename(p) || p };
        }
        return {
          path: p.path || p.rootPath || p.id || "",
          name: p.name || path.basename(p.path || p.rootPath || "") || "Project",
          active: Boolean(p.active),
        };
      })
      .filter((p) => p.path);

    if (allowedProjects && allowedProjects.length > 0) {
      const allowSet = new Set(allowedProjects.map((p) => path.resolve(p).toLowerCase()));
      return normalized.filter((p) => allowSet.has(path.resolve(p.path).toLowerCase()));
    }
    return normalized;
  }

  async listSessions({ projectPath = null } = {}) {
    const res = await this._desktopInvoke("session/list", []);
    const list = Array.isArray(res) ? res : res?.sessions || [];
    const normalizedTarget = projectPath ? path.resolve(projectPath).toLowerCase() : null;
    return list
      .map((s) => normalizeSessionSummary(s))
      .filter((s) => {
        if (!s.id) return false;
        if (!normalizedTarget) return true;
        return s.projectPath && path.resolve(s.projectPath).toLowerCase() === normalizedTarget;
      });
  }

  async getSession({ sessionId, messageLimit = 120 }) {
    const res = await this._desktopInvoke("session/get", [{ id: sessionId, messageLimit }]);
    const sess = res?.session || res || {};
    const rawMessages = sess?.messages || res?.messages || res?.items || [];
    const workState = extractWorkStateFromRawMessages(rawMessages, sessionId);
    const messages = [];
    for (let idx = 0; idx < rawMessages.length; idx++) {
      const m = rawMessages[idx];
      if (!m || m.role === "system") continue;
      if (m.parentToolCallId || m.nestedParentToolCallId || m.meta?.parentToolCallId) continue;

      const role = m.role || "assistant";
      if (role === "tool") {
        const toolBlock = Array.isArray(m.blocks) ? m.blocks.find((b) => b?.type === "tool_call") : null;
        const toolName = m.toolName || toolBlock?.name || "Tool";
        const toolStatus = m.toolStatus || toolBlock?.status || (toolBlock?.isError ? "error" : "success");
        const rawArgs = m.toolArgs ?? toolBlock?.args;
        const rawResult = m.toolResult ?? toolBlock?.result;
        messages.push({
          id: m.id || `${sessionId}-t-${idx}`,
          role: "tool",
          content: "",
          createdAt: m.createdAt || new Date().toISOString(),
          toolName,
          toolStatus,
          toolArgsPreview: rawArgs ? String(JSON.stringify(rawArgs)).slice(0, 300) : undefined,
          toolResultPreview: rawResult ? String(typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult)).slice(0, 400) : undefined,
          isProcessStep: true,
        });
        continue;
      }

      const parsed = extractMessageParts(m);
      const text = parsed.text.trim();
      const thinking = parsed.thinking.trim();
      if (role === "user" && !text) continue;
      if (role === "assistant" && !text && !thinking) continue;

      messages.push({
        id: m.id || `${sessionId}-m-${idx}`,
        role,
        content: text,
        thinking: thinking || undefined,
        createdAt: m.createdAt || new Date().toISOString(),
        toolName: m.toolName || parsed.toolName || undefined,
        isProcessStep: false,
      });
    }

    // Group intermediate assistant narration & thinking-only steps before tools/final reply as collapsible process steps
    let turnEnd = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") {
        turnEnd = i;
        continue;
      }
      if (m.role === "assistant") {
        let hasLaterAssistantAnswerOrTool = false;
        for (let j = i + 1; j < turnEnd; j++) {
          const later = messages[j];
          if (later.role === "tool" || (later.role === "assistant" && later.content)) {
            hasLaterAssistantAnswerOrTool = true;
            break;
          }
        }
        if (!m.content || hasLaterAssistantAnswerOrTool) {
          m.isProcessStep = true;
        }
      }
    }

    const sessionSummary = normalizeSessionSummary(
      {
        ...res,
        ...sess,
        id: sess?.id || res?.id || sessionId,
      },
      sessionId
    );

    return {
      session: sessionSummary,
      messages,
      todos: Array.isArray(sess?.todos) ? normalizeTodoList(sess.todos) : workState.todos,
      backgroundTasks: workState.backgroundTasks,
    };
  }

  async createSession({ projectPath, title, mode = "agent", providerId, modelId, thinkingLevel }) {
    const payload = {
      projectPath,
      title,
      mode: VALID_SESSION_MODES.has(mode) ? mode : "agent",
    };
    if (providerId) payload.providerId = String(providerId);
    if (modelId) payload.modelId = String(modelId);
    if (thinkingLevel && VALID_THINKING_LEVELS.has(thinkingLevel)) payload.thinkingLevel = thinkingLevel;
    const res = await this._desktopInvoke("session/create", [payload]);
    const raw = res?.session || res || {};
    return normalizeSessionSummary({
      ...payload,
      ...raw,
      id: raw.id || raw.sessionId || res?.id || res?.sessionId,
      title: raw.title || title || "New Remote Session",
      projectPath: raw.projectPath || projectPath || "",
      status: "idle",
      updatedAt: raw.updatedAt || new Date().toISOString(),
    });
  }

  async configureSession({ sessionId, mode, permissionMode, providerId, modelId, thinkingLevel, fastMode }) {
    const config = {};
    if (mode !== undefined) {
      if (!VALID_SESSION_MODES.has(mode)) throw new Error(`Invalid session mode: ${mode}`);
      config.mode = mode;
    }
    if (permissionMode !== undefined) {
      if (!VALID_PERMISSION_MODES.has(permissionMode)) throw new Error(`Invalid permissionMode: ${permissionMode}`);
      config.permissionMode = permissionMode;
    }
    if (providerId !== undefined && typeof providerId === "string" && providerId.trim()) {
      config.providerId = providerId.trim();
    }
    if (modelId !== undefined && typeof modelId === "string" && modelId.trim()) {
      config.modelId = modelId.trim();
    }
    if (thinkingLevel !== undefined) {
      if (!VALID_THINKING_LEVELS.has(thinkingLevel)) throw new Error(`Invalid thinkingLevel: ${thinkingLevel}`);
      config.thinkingLevel = thinkingLevel;
    }
    if (typeof fastMode === "boolean") {
      config.fastMode = fastMode;
    }

    const capMode = await this.detectCapabilityMode();
    try {
      const res = await this._desktopInvoke("session/configure", [sessionId, config], {
        confirm: true,
        preferMcp: true,
      });
      const updated = res?.session ? normalizeSessionSummary(res.session, sessionId) : null;
      return {
        applied: true,
        requiresDesktopConfirm: false,
        capabilityMode: capMode,
        session: updated,
      };
    } catch (err) {
      const msg = String(err?.message || err || "");
      const code = String(err?.code || err?.errorCode || "");
      if (
        capMode !== "mcp-full" &&
        (code === "PERMISSION_DENIED" ||
          code === "CONFIRMATION_REQUIRED" ||
          /confirm|declined|permission/i.test(msg))
      ) {
        return {
          applied: false,
          requiresDesktopConfirm: true,
          capabilityMode: capMode,
          message:
            "桌面端未确认本次会话配置变更。可在 PI-Desktop 弹窗点击「允许」，或以 PI_DESKTOP_MCP_CONTROL=1 启动 PI-Desktop 开启免弹窗远程切换。",
        };
      }
      throw err;
    }
  }

  async listProviders() {
    let rawProviders = [];
    try {
      const res = await this._desktopInvoke("providers/list", []);
      rawProviders = Array.isArray(res) ? res : res?.providers || [];
    } catch {
      rawProviders = [];
    }

    // Never leak secrets; whitelist safe metadata only
    const providers = [];
    for (const p of rawProviders) {
      if (!p || !p.id) continue;
      let models = Array.isArray(p.models) ? p.models : [];
      if (models.length === 0 && p.enabled !== false) {
        try {
          const mRes = await this._desktopInvoke("providers/listModels", [{ providerId: p.id, source: "cache" }]);
          const fetched = Array.isArray(mRes) ? mRes : mRes?.models || [];
          if (fetched.length > 0) models = fetched;
        } catch {
          // ignore cache miss
        }
      }
      const normModels = models
        .filter((m) => m && (m.id || typeof m === "string"))
        .map((m) =>
          typeof m === "string"
            ? { id: m, name: m, enabled: true }
            : {
                id: String(m.id),
                name: String(m.name || m.displayName || m.id),
                contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
                maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
                reasoning: Boolean(m.reasoning || m.capabilities?.reasoning),
                vision: Boolean(m.vision || m.capabilities?.vision || m.capabilities?.imageInput),
                enabled: m.enabled !== false,
              }
        );

      const defaultModelId = p.modelId || p.defaultModelId || normModels[0]?.id || "";
      if (defaultModelId && !normModels.some((m) => m.id === defaultModelId)) {
        normModels.unshift({ id: String(defaultModelId), name: String(defaultModelId), enabled: true });
      }

      providers.push({
        id: String(p.id),
        name: String(p.name || p.label || p.vendorKey || p.id),
        vendorKey: p.vendorKey ? String(p.vendorKey) : undefined,
        baseUrl: p.baseUrl ? String(p.baseUrl) : undefined,
        apiStyle: p.apiStyle ? String(p.apiStyle) : undefined,
        enabled: p.enabled !== false,
        hasApiKey: Boolean(p.hasApiKey ?? p.hasSecret ?? p.configured ?? p.apiKeyConfigured ?? p.authType === "oauth"),
        defaultModelId: defaultModelId || undefined,
        models: normModels,
      });
    }

    // Fallback to pi.models.list() if desktop providers/list returned empty
    if (providers.length === 0 && typeof this.pi?.models?.list === "function") {
      try {
        const list = (await this.pi.models.list()) || [];
        const byProv = new Map();
        for (const m of list) {
          const pid = String(m.providerId || m.provider || "default");
          if (!byProv.has(pid)) {
            byProv.set(pid, {
              id: pid,
              name: String(m.providerName || pid),
              enabled: true,
              hasApiKey: true,
              models: [],
            });
          }
          byProv.get(pid).models.push({
            id: String(m.id || m.modelId),
            name: String(m.name || m.id || m.modelId),
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
            reasoning: Boolean(m.reasoning),
            vision: Boolean(m.vision),
            enabled: true,
          });
        }
        providers.push(...byProv.values());
      } catch {
        // ignore
      }
    }

    return { providers };
  }

  async refreshModelCatalog() {
    try {
      await this._desktopInvoke("providers/refreshModelCatalog", []);
    } catch {
      // catalog refresh is best-effort
    }
    return this.listProviders();
  }

  async getHostSettings() {
    try {
      const raw = (await this._desktopInvoke("settings/get", [])) || {};
      return {
        defaultMode: VALID_SESSION_MODES.has(raw.defaultMode) ? raw.defaultMode : "agent",
        defaultPermissionMode: VALID_PERMISSION_MODES.has(raw.defaultPermissionMode)
          ? raw.defaultPermissionMode
          : "ask",
        defaultProviderId: raw.defaultProviderId || "",
        defaultModelId: raw.defaultModelId || "",
        defaultThinkingLevel: VALID_THINKING_LEVELS.has(raw.defaultThinkingLevel)
          ? raw.defaultThinkingLevel
          : "high",
        scheduledTasksEnabled: raw.scheduledTasksEnabled !== false,
        locale: raw.locale || "zh-CN",
      };
    } catch {
      return {
        defaultMode: "agent",
        defaultPermissionMode: "ask",
        defaultProviderId: "",
        defaultModelId: "",
        defaultThinkingLevel: "high",
        scheduledTasksEnabled: true,
        locale: "zh-CN",
      };
    }
  }

  async listScheduledTasks() {
    try {
      const res = await this._desktopInvoke("scheduled/list", []);
      const raw = Array.isArray(res) ? res : res?.tasks || res?.items || [];
      return raw
        .filter((t) => t && t.id)
        .map((t) => ({
          id: String(t.id),
          title: String(t.title || t.name || "Scheduled Task"),
          prompt: t.prompt ? String(t.prompt).slice(0, 200) : undefined,
          cadence: t.cadence ? String(t.cadence) : undefined,
          enabled: t.enabled !== false,
          projectPath: t.projectPath || t.workspacePath || "",
          nextRunAt: t.nextRunAt || null,
          lastRunAt: t.lastRunAt || null,
          lastStatus: t.lastStatus || t.status || null,
        }));
    } catch {
      return [];
    }
  }

  async openSession({ sessionId }) {
    return this._desktopInvoke("session/open", [sessionId]);
  }

  async startTurn({ sessionId, content, attachments = [] }) {
    const payload = { sessionId, content };
    if (attachments.length > 0) payload.attachments = attachments;
    return this._desktopInvoke("agent/prompt", [payload]);
  }

  async abortTurn({ sessionId, turnId = null }) {
    const arg = turnId ? { sessionId, turnId } : { sessionId };
    return this._desktopInvoke("agent/abort", [arg]);
  }

  async getPendingItems(sessionIds = []) {
    const mode = await this.detectCapabilityMode();
    const requiresDesktopConfirm = mode !== "mcp-full";
    const items = [];

    let targetSessions = sessionIds;
    if (!targetSessions || targetSessions.length === 0) {
      const sessions = await this.listSessions();
      targetSessions = sessions.slice(0, 20).map((s) => s.id);
    }

    for (const sessionId of targetSessions) {
      try {
        const pending = await this._desktopInvoke("agent/pendingInteractive", [{ sessionId }]);
        for (const perm of pending?.permissions || []) {
          items.push({
            id: perm.id || perm.requestId || perm.toolCallId,
            kind: "permission",
            sessionId,
            turnId: perm.turnId || undefined,
            toolCallId: perm.toolCallId || undefined,
            risk: perm.risk || "high",
            title: perm.toolName || perm.title || "Tool Permission Request",
            summary: perm.summary || perm.description || "Agent requests permission to run a tool.",
            argsPreview: perm.args ? JSON.stringify(perm.args, null, 2).slice(0, 1200) : undefined,
            requiresDesktopConfirm,
            createdAt: perm.createdAt || new Date().toISOString(),
          });
        }
        for (const ask of pending?.asks || []) {
          items.push({
            id: ask.id || ask.requestId,
            kind: "ask",
            sessionId,
            turnId: ask.turnId || undefined,
            risk: "low",
            title: ask.title || "Agent Question",
            summary: ask.question || ask.summary || "",
            options: Array.isArray(ask.options) ? ask.options : [],
            requiresDesktopConfirm,
            createdAt: ask.createdAt || new Date().toISOString(),
          });
        }
      } catch {
        // session may not have pending interactive state
      }
    }

    try {
      const plans = await this._desktopInvoke("plans/pending", [{}]);
      const planList = Array.isArray(plans) ? plans : plans?.proposals || plans?.plans || [];
      for (const plan of planList) {
        items.push({
          id: plan.proposalId || plan.id,
          kind: "plan",
          sessionId: plan.sessionId || "",
          turnId: plan.turnId || undefined,
          toolCallId: plan.toolCallId || undefined,
          risk: "medium",
          title: plan.title || "Plan Approval Checkpoint",
          summary: plan.summary || plan.planMarkdown || "",
          requiresDesktopConfirm,
          createdAt: plan.createdAt || new Date().toISOString(),
        });
      }
    } catch {
      // no pending plans
    }

    return { capabilityMode: mode, items };
  }

  async resolvePermission({ approvalId, sessionId, decision, scope = "once" }) {
    const mode = await this.detectCapabilityMode();
    if (mode !== "mcp-full") {
      return {
        resolved: false,
        requiresDesktopConfirm: true,
        message: "Standard mode: please confirm this dangerous operation on the PI-Desktop window (or launch PI-Desktop with PI_DESKTOP_MCP_CONTROL=1).",
      };
    }
    const res = await this._desktopInvoke(
      "tool/resolvePermission",
      [{ id: approvalId, requestId: approvalId, sessionId, decision, scope }],
      { confirm: true, preferMcp: true }
    );
    return { resolved: true, requiresDesktopConfirm: false, result: res };
  }

  async resolveAsk({ askId, sessionId, answers }) {
    const mode = await this.detectCapabilityMode();
    if (mode !== "mcp-full") {
      return {
        resolved: false,
        requiresDesktopConfirm: true,
        message: "Standard mode: please submit this card on PI-Desktop (or launch with PI_DESKTOP_MCP_CONTROL=1).",
      };
    }
    const res = await this._desktopInvoke(
      "agent/askTool/resolve",
      [{ id: askId, requestId: askId, sessionId, answers }],
      { confirm: true, preferMcp: true }
    );
    return { resolved: true, requiresDesktopConfirm: false, result: res };
  }

  async resolvePlan({ proposalId, sessionId, turnId, toolCallId, action, targetPermissionMode }) {
    const mode = await this.detectCapabilityMode();
    if (mode !== "mcp-full") {
      return {
        resolved: false,
        requiresDesktopConfirm: true,
        message: "Standard mode: please confirm this plan on PI-Desktop (or launch with PI_DESKTOP_MCP_CONTROL=1).",
      };
    }
    const res = await this._desktopInvoke(
      "plans/resolve",
      [{ proposalId, sessionId, turnId, toolCallId, action, targetPermissionMode }],
      { confirm: true, preferMcp: true }
    );
    return { resolved: true, requiresDesktopConfirm: false, result: res };
  }
}
