import {
  generateX25519KeyPair,
  computeSharedSecret,
  computeInviteProof,
  derivePairingMaterial,
  encryptEnvelope,
  decryptEnvelope,
  ReplayWindow,
  base64ToBytes,
  randomId,
  validatePairingInvite,
} from "/protocol/index.mjs";
import { renderMarkdownToDom } from "/markdown.mjs";

const STORAGE_HOSTS = "pi_remote_hosts_v1";
const STORAGE_THEME = "pi_remote_theme_v1";

const SESSION_MODES = [
  { id: "agent", label: "智能体", desc: "直接协作编码、调用工具与执行命令，适合绝大多数开发任务" },
  { id: "goal", label: "目标", desc: "围绕最终验收标准自主拆解并持续推进直到目标达成" },
  { id: "plan", label: "规划", desc: "先只读调研并输出完整方案检查点，获批后再动手改代码" },
];

const PERMISSION_MODES = [
  { id: "ask", label: "每次询问", desc: "写文件与执行命令前逐次请求确认，最稳妥安全" },
  { id: "accept-edits", label: "允许编辑", desc: "自动允许工作区文件编辑，高风险命令仍需确认" },
  { id: "auto", label: "全自动", desc: "自动批准工具与命令执行，适合可信沙箱与无人值守任务" },
];

const THINKING_LEVELS = [
  { id: "off", label: "关闭" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "极高" },
];

const MODE_LABELS = { agent: "智能体", goal: "目标", plan: "规划" };
const PERM_LABELS = { inherit: "跟随默认", ask: "每次询问", "accept-edits": "允许编辑", auto: "全自动" };
const THINK_LABELS = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", omit: "默认" };

const state = {
  tab: "chat",
  dockOpen: false,
  dockTab: "todos",
  theme: localStorage.getItem(STORAGE_THEME) || "light",
  hosts: safeLoadHosts(),
  ws: null,
  transportKind: null,
  activeHost: null,
  hostInfo: null,
  hostSettings: {
    defaultMode: "agent",
    defaultPermissionMode: "ask",
    defaultProviderId: "",
    defaultModelId: "",
    defaultThinkingLevel: "high",
  },
  providers: [],
  expandedProviders: new Set(),
  activeProject: null,
  sessions: [],
  activeSession: null,
  messages: [],
  todos: [],
  backgroundTasks: [],
  scheduledTasks: [],
  pendingItems: [],
  diffBranch: "",
  diffFiles: [],
  selectedDiffPath: null,
  activePatch: null,
  diffWrap: false,
  isRunning: false,
  txSeq: 0,
  replayWindow: new ReplayWindow(),
  pendingRpc: new Map(),
  reviewItem: null,
  reviewStepConfirmed: false,
  streamText: "",
  streamNode: null,
};

function safeLoadHosts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_HOSTS) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveHosts() {
  localStorage.setItem(STORAGE_HOSTS, JSON.stringify(state.hosts));
}

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function applyTheme(next) {
  state.theme = next === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem(STORAGE_THEME, state.theme);
  document.getElementById("icon-theme-sun").classList.toggle("hidden", state.theme !== "dark");
  document.getElementById("icon-theme-moon").classList.toggle("hidden", state.theme === "dark");
  document.getElementById("btn-set-light").classList.toggle("active", state.theme === "light");
  document.getElementById("btn-set-dark").classList.toggle("active", state.theme === "dark");
}

function switchThemeAnimated(next, originEvent = null) {
  const target = next === "dark" ? "dark" : "light";
  if (target === state.theme) return;
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && typeof document.startViewTransition === "function") {
    const rect = originEvent?.currentTarget?.getBoundingClientRect?.();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 36;
    const y = rect ? rect.top + rect.height / 2 : 36;
    const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const vt = document.startViewTransition(() => applyTheme(target));
    vt.ready
      .then(() => {
        document.documentElement.animate(
          {
            clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxR}px at ${x}px ${y}px)`],
          },
          {
            duration: 380,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            pseudoElement: "::view-transition-new(root)",
          }
        );
      })
      .catch(() => {});
    return;
  }
  document.documentElement.classList.add("theme-switching");
  applyTheme(target);
  setTimeout(() => document.documentElement.classList.remove("theme-switching"), 300);
}

const TAB_ORDER = ["chat", "tasks", "diff", "inbox", "settings"];
function setTab(tabName) {
  state.tab = tabName;
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  }
  const idx = Math.max(0, TAB_ORDER.indexOf(tabName));
  const ind = document.getElementById("tab-indicator");
  if (ind) ind.style.transform = `translateX(${idx * 100}%)`;

  for (const name of TAB_ORDER) {
    document.getElementById(`panel-${name}`).classList.toggle("active", name === tabName);
  }
  updateComposerVisibility();

  if (state.activeHost) {
    if (tabName === "diff" && state.activeProject) refreshDiff().catch(() => {});
    if (tabName === "inbox") refreshPending().catch(() => {});
    if (tabName === "tasks") refreshTasks().catch(() => {});
    if (tabName === "settings" && state.providers.length === 0) refreshProvidersAndSettings().catch(() => {});
  }
}

const TASK_SUB_ORDER = ["todos", "bg", "scheduled"];
function setTasksSubTab(sub) {
  for (const btn of document.querySelectorAll("[data-task-sub]")) {
    btn.classList.toggle("active", btn.dataset.taskSub === sub);
  }
  const idx = Math.max(0, TASK_SUB_ORDER.indexOf(sub));
  const thumb = document.getElementById("seg-tasks-thumb");
  if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
  for (const k of TASK_SUB_ORDER) {
    document.getElementById(`tasks-view-${k}`).classList.toggle("hidden", k !== sub);
  }
}

const SETTINGS_SUB_ORDER = ["providers", "hosts", "general"];
function setSettingsSubTab(sub) {
  for (const btn of document.querySelectorAll("[data-settings-sub]")) {
    btn.classList.toggle("active", btn.dataset.settingsSub === sub);
  }
  const idx = Math.max(0, SETTINGS_SUB_ORDER.indexOf(sub));
  const thumb = document.getElementById("seg-settings-thumb");
  if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
  for (const k of SETTINGS_SUB_ORDER) {
    document.getElementById(`settings-view-${k}`).classList.toggle("hidden", k !== sub);
  }
}
function getEffectivePermissionMode(sess = state.activeSession) {
  const pm = sess?.permissionMode;
  if (!pm || pm === "inherit") return state.hostSettings?.defaultPermissionMode || "ask";
  return pm;
}

function updateComposerVisibility() {
  const showComposer = state.tab === "chat" && Boolean(state.activeSession);
  document.getElementById("floating-composer").classList.toggle("hidden", !showComposer);
}

function updateComposerControls() {
  const sess = state.activeSession;
  if (!sess) return;
  const mode = sess.mode || "agent";
  const effectivePerm = getEffectivePermissionMode(sess);
  const modelName = sess.modelId || sess.model || state.hostSettings?.defaultModelId || "默认模型";
  const think = sess.thinkingLevel || state.hostSettings?.defaultThinkingLevel || "";

  document.getElementById("ctrl-mode-label").textContent = MODE_LABELS[mode] || mode;
  const permBtn = document.getElementById("btn-pick-perm");
  const permLabel = document.getElementById("ctrl-perm-label");
  permLabel.textContent = PERM_LABELS[effectivePerm] || effectivePerm;
  permBtn.classList.toggle("warn-tint", effectivePerm === "auto");
  permBtn.classList.toggle("disabled", mode === "goal");

  document.getElementById("ctrl-model-label").textContent = modelName.includes("/")
    ? modelName.split("/").pop()
    : modelName;
  const thinkEl = document.getElementById("ctrl-think-label");
  if (think && think !== "omit" && THINK_LABELS[think]) {
    thinkEl.textContent = THINK_LABELS[think];
    thinkEl.classList.remove("hidden");
  } else {
    thinkEl.classList.add("hidden");
  }
}

function updateHeader() {
  const dot = document.getElementById("header-dot");
  const title = document.getElementById("header-title");
  const sub = document.getElementById("header-sub");
  const abortBtn = document.getElementById("btn-abort");

  dot.className = "status-dot";
  if (state.isRunning) dot.classList.add("running");
  else if (state.ws && state.ws.readyState === WebSocket.OPEN && state.activeHost) dot.classList.add("online");
  else if (state.pendingItems.length > 0) dot.classList.add("warn");

  if (state.activeSession) {
    title.textContent = state.activeSession.title || "未命名会话";
    const hostLabel = state.hostInfo?.hostName || state.activeHost?.hostName || "主机";
    const connLabel = state.transportKind === "relay" ? "盲中继 E2EE" : "直连 E2EE";
    sub.textContent = `${hostLabel} · ${state.activeProject?.name || "工作区"} · ${connLabel}`;
  } else if (state.hostInfo) {
    title.textContent = state.hostInfo.hostName;
    sub.textContent = `${state.activeProject?.name || "选择工作区"} · 点击切换会话`;
  } else {
    title.textContent = "PI Remote";
    sub.textContent = state.hosts.length > 0 ? `已保存 ${state.hosts.length} 台主机 · 前往「设置」连接` : "未连接 · 前往「设置」配对";
  }

  abortBtn.classList.toggle("hidden", !state.isRunning);
  document.querySelector(".composer-card")?.classList.toggle("is-running", Boolean(state.isRunning));
  updateComposerVisibility();
  updateComposerControls();
}

function updateBadges() {
  const bInbox = document.getElementById("badge-inbox");
  bInbox.textContent = String(state.pendingItems.length);
  bInbox.classList.toggle("hidden", state.pendingItems.length === 0);

  const bDiff = document.getElementById("badge-diff");
  bDiff.textContent = String(state.diffFiles.length);
  bDiff.classList.toggle("hidden", state.diffFiles.length === 0);

  const activeTodos = state.todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const runningBg = state.backgroundTasks.filter((t) => t.state === "running").length;
  const taskBadgeCount = activeTodos + runningBg;
  const bTasks = document.getElementById("badge-tasks");
  bTasks.textContent = String(taskBadgeCount);
  bTasks.classList.toggle("hidden", taskBadgeCount === 0);

  document.getElementById("count-todos").textContent = String(state.todos.length);
  document.getElementById("count-bg").textContent = String(state.backgroundTasks.length);
  document.getElementById("count-sched").textContent = String(state.scheduledTasks.length);

  const chatBanner = document.getElementById("chat-pending-banner");
  const sessPending = state.activeSession
    ? state.pendingItems.filter((p) => p.sessionId === state.activeSession.id)
    : [];
  if (sessPending.length > 0) {
    document.getElementById("chat-pending-text").textContent = `当前会话有 ${sessPending.length} 项待审批 / 提问`;
    chatBanner.classList.remove("hidden");
    chatBanner.onclick = () => openApprovalSheet(sessPending[0]);
  } else {
    chatBanner.classList.add("hidden");
  }
}

/* ==========================================================================
   Transport & E2EE RPC
   ========================================================================== */
function openWsWithTimeout(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      reject(new Error(`Timeout: ${url}`));
    }, timeoutMs);
    sock.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    };
    sock.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed: ${url}`));
    };
  });
}

async function connectBestTransport(directUrls = [], relayUrl = null) {
  const candidates = [...(directUrls || [])];
  if (candidates.length === 0 && relayUrl) {
    const sock = await openWsWithTimeout(relayUrl, 5000);
    return { sock, kind: "relay" };
  }
  return new Promise((resolve, reject) => {
    let done = false;
    let pending = 0;
    let fallbackTimer = null;
    const opened = [];

    const win = (sock, kind) => {
      if (done) {
        try { sock.close(); } catch {}
        return;
      }
      done = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      for (const s of opened) if (s !== sock) try { s.close(); } catch {}
      resolve({ sock, kind });
    };
    const maybeFail = () => {
      if (!done && pending === 0 && !fallbackTimer) {
        done = true;
        reject(new Error("无法连接到桌面端（局域网与盲中继均不可达）"));
      }
    };
    const launch = (url, kind) => {
      pending += 1;
      openWsWithTimeout(url, kind === "direct" ? 2200 : 5000)
        .then((sock) => {
          opened.push(sock);
          win(sock, kind);
        })
        .catch(() => {
          pending -= 1;
          maybeFail();
        });
    };
    for (const u of candidates) launch(u, "direct");
    if (relayUrl) {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (!done) launch(relayUrl, "relay");
      }, 750);
    }
  });
}

async function rpcCall(method, params = {}, idempotencyKey) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.activeHost) {
    throw new Error("主机未连接");
  }
  state.txSeq += 1;
  const id = `w_${state.txSeq}_${randomId(4)}`;
  const envelope = await encryptEnvelope({
    keyBytes: state.activeHost.sessionKeyB64,
    keyId: state.activeHost.keyId,
    hostId: state.activeHost.hostId,
    deviceId: state.activeHost.deviceId,
    direction: "c2h",
    seq: state.txSeq,
    payload: { type: "req", id, idempotencyKey, method, params },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRpc.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, 20000);
    state.pendingRpc.set(id, { resolve, reject, timer });
    state.ws.send(
      JSON.stringify({
        t: "cipher",
        routeId: state.activeHost.routeId || "direct",
        deviceId: state.activeHost.deviceId,
        frameId: id,
        envelope,
      })
    );
  });
}

function attachAuthenticatedSocket(sock) {
  sock.onmessage = async (ev) => {
    if (state.ws !== sock || !state.activeHost) return;
    let frame;
    try { frame = JSON.parse(String(ev.data)); } catch { return; }

    if (frame.t === "error" && frame.code === "REVOKED") {
      showToast("此设备已被桌面端吊销");
      sock.close();
      state.ws = null;
      updateHeader();
      setTab("settings");
      setSettingsSubTab("hosts");
      return;
    }
    if (frame.t !== "cipher") return;

    let dec;
    try {
      dec = await decryptEnvelope({
        keyBytes: state.activeHost.sessionKeyB64,
        keyId: state.activeHost.keyId,
        hostId: state.activeHost.hostId,
        deviceId: state.activeHost.deviceId,
        expectedDirection: "h2c",
        envelope: frame.envelope,
        replayWindow: state.replayWindow,
      });
    } catch {
      return;
    }

    if (dec.type === "res" && dec.id) {
      const p = state.pendingRpc.get(dec.id);
      if (p) {
        clearTimeout(p.timer);
        state.pendingRpc.delete(dec.id);
        if (dec.ok) p.resolve(dec.result);
        else p.reject(new Error(dec.error?.message || "RPC 调用失败"));
      }
      return;
    }

    if (dec.type === "evt") {
      handleRemoteEvent(dec);
    }
  };

  sock.onclose = () => {
    if (state.ws !== sock) return;
    state.ws = null;
    updateHeader();
    renderHosts();
  };
}

function handleRemoteEvent(evt) {
  if (evt.event === "pending.updated") {
    state.pendingItems = Array.isArray(evt.payload?.items) ? evt.payload.items : [];
    renderInbox();
    updateBadges();
    return;
  }

  const curId = state.activeSession?.id;
  if (!curId || evt.payload?.sessionId !== curId) return;

  if (evt.event === "session.configured" && evt.payload?.session) {
    state.activeSession = { ...state.activeSession, ...evt.payload.session };
    state.sessions = state.sessions.map((s) => (s.id === curId ? { ...s, ...evt.payload.session } : s));
    updateHeader();
    return;
  }

  if (evt.event === "todos.updated" && Array.isArray(evt.payload?.todos)) {
    state.todos = evt.payload.todos;
    renderChatTaskDock();
    renderTasksTab();
    updateBadges();
    return;
  }

  if (evt.event === "tasks.updated" && Array.isArray(evt.payload?.backgroundTasks)) {
    state.backgroundTasks = evt.payload.backgroundTasks;
    renderChatTaskDock();
    renderTasksTab();
    updateBadges();
    return;
  }

  if (evt.event === "stream.delta") {
    state.isRunning = true;
    updateHeader();
    if (evt.payload.channel !== "thinking") {
      state.streamText += evt.payload.delta || "";
      updateStreamingBubble(state.streamText);
    }
    return;
  }

  if (evt.event === "message.final") {
    const msg = evt.payload?.message;
    clearStreamingBubble();
    if (msg && msg.content) {
      if (!state.messages.some((m) => m.id === msg.id)) {
        state.messages.push(msg);
        renderChatTimeline();
      }
    }
    return;
  }

  if (evt.event === "turn.state") {
    state.isRunning = evt.payload?.status === "running";
    if (!state.isRunning) clearStreamingBubble();
    updateHeader();
  }
}

/* ==========================================================================
   Session Configuration (Mode / Permission / Model / Thinking)
   ========================================================================== */
async function configureActiveSession(patch) {
  if (!state.activeSession) return false;
  const sess = state.activeSession;
  const payload = {
    sessionId: sess.id,
    mode: patch.mode ?? sess.mode ?? "agent",
    ...patch,
  };


  try {
    const res = await rpcCall("session.configure", payload);
    if (res?.applied) {
      state.activeSession = {
        ...sess,
        ...patch,
        ...(res.session || {}),
        model: res.session?.modelId || patch.modelId || sess.model,
      };
      state.sessions = state.sessions.map((s) => (s.id === sess.id ? state.activeSession : s));
      updateHeader();
      renderProvidersSettings();
      showToast("会话配置已同步至 PI-Desktop");
      return true;
    }
    showToast(res?.message || "请在 PI-Desktop 弹窗中确认本次配置变更");
    return false;
  } catch (err) {
    showToast(err.message || "切换配置失败");
    return false;
  }
}

/* ==========================================================================
   Rendering: Chat Task Dock & Tasks Tab (Real Todos + Background + Scheduled)
   ========================================================================== */
function createTodoItemNode(todo) {
  const row = document.createElement("div");
  row.className = `todo-item ${todo.status}`;
  const mark = document.createElement("span");
  mark.className = "todo-mark";
  mark.textContent =
    todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "•" : todo.status === "cancelled" ? "−" : "";
  const body = document.createElement("div");
  body.style.flex = "1";
  const txt = document.createElement("div");
  txt.className = "todo-text";
  txt.textContent = todo.content;
  body.appendChild(txt);
  row.append(mark, body);

  if (todo.status === "in_progress") {
    const chip = document.createElement("span");
    chip.className = "chip sm solid";
    chip.textContent = "进行中";
    row.appendChild(chip);
  } else if (todo.priority === "high" && todo.status === "pending") {
    const chip = document.createElement("span");
    chip.className = "chip sm";
    chip.textContent = "高优";
    row.appendChild(chip);
  }
  return row;
}

function createBgTaskCard(task, compact = false) {
  const card = document.createElement("div");
  card.className = "card";
  if (compact) card.style.padding = "10px 11px";

  const top = document.createElement("div");
  top.className = "between";
  const left = document.createElement("div");
  left.style.minWidth = "0";
  const title = document.createElement("div");
  title.style.cssText = "font-size:13px;font-weight:600;word-break:break-word;";
  title.textContent = task.title || task.command || task.id;
  const sub = document.createElement("div");
  sub.className = "card-sub";
  sub.style.fontFamily = "var(--font-mono)";
  sub.style.fontSize = "11px";
  sub.textContent = `${task.kind === "subagent" ? `子代理 · ${task.agent || "task"}` : "后台命令"} · ${task.id.slice(0, 14)}${
    task.exitCode !== null && task.exitCode !== undefined ? ` · exit ${task.exitCode}` : ""
  }`;
  left.append(title, sub);

  const badge = document.createElement("span");
  const stateMap = {
    running: { label: "运行中", cls: "ok" },
    completed: { label: "已完成", cls: "" },
    exited: { label: "已退出", cls: "" },
    stopped: { label: "已停止", cls: "warn" },
    failed: { label: "失败", cls: "danger" },
  };
  const info = stateMap[task.state] || { label: task.state, cls: "" };
  badge.className = `chip sm ${info.cls}`;
  badge.textContent = info.label;

  top.append(left, badge);
  card.appendChild(top);

  if (!compact && task.command) {
    const cmd = document.createElement("div");
    cmd.className = "task-cmd";
    cmd.textContent = `$ ${task.command}`;
    card.appendChild(cmd);
  }

  if (task.outputPreview) {
    const out = document.createElement("div");
    out.className = "task-cmd";
    out.textContent = task.outputPreview;
    card.appendChild(out);
  }
  return card;
}

function renderChatTaskDock() {
  const dock = document.getElementById("chat-task-dock");
  const hasAny = state.todos.length > 0 || state.backgroundTasks.length > 0;
  dock.classList.toggle("hidden", !state.activeSession || !hasAny);
  if (!hasAny) return;

  const doneCount = state.todos.filter((t) => t.status === "completed").length;
  const activeCount = state.todos.filter((t) => t.status !== "cancelled").length;
  const currentTodo = state.todos.find((t) => t.status === "in_progress");
  const runningBg = state.backgroundTasks.filter((t) => t.state === "running").length;

  const summaryParts = [];
  if (state.todos.length > 0) {
    summaryParts.push(currentTodo ? `◐ ${currentTodo.content}` : `✓ 待办 ${doneCount}/${activeCount}`);
  }
  if (state.backgroundTasks.length > 0) {
    summaryParts.push(`后台 ${state.backgroundTasks.length}`);
  }
  document.getElementById("dock-summary-text").textContent = summaryParts.join(" · ");

  const chip = document.getElementById("dock-running-chip");
  if (runningBg > 0) {
    chip.textContent = `${runningBg} 运行中`;
    chip.className = "chip sm ok";
  } else if (state.todos.length > 0) {
    chip.textContent = `${doneCount}/${activeCount}`;
    chip.className = "chip sm";
  } else {
    chip.className = "chip sm hidden";
  }

  document.getElementById("dock-tab-todos").classList.toggle("active", state.dockTab === "todos");
  document.getElementById("dock-tab-bg").classList.toggle("active", state.dockTab === "bg");
  document.getElementById("dock-tab-todos").textContent = `待办 (${state.todos.length})`;
  document.getElementById("dock-tab-bg").textContent = `后台任务 (${state.backgroundTasks.length})`;
  dock.classList.toggle("open", state.dockOpen);
  document.getElementById("dock-chevron").classList.toggle("open", state.dockOpen);

  const body = document.getElementById("dock-content");
  clearEl(body);
  const stack = document.createElement("div");
  stack.className = "stack";
  stack.style.gap = "6px";

  if (state.dockTab === "todos") {
    if (state.todos.length === 0) {
      const p = document.createElement("div");
      p.className = "card-sub";
      p.textContent = "当前会话暂无待办清单。";
      stack.appendChild(p);
    } else {
      for (const t of state.todos.slice(0, 6)) stack.appendChild(createTodoItemNode(t));
    }
  } else {
    if (state.backgroundTasks.length === 0) {
      const p = document.createElement("div");
      p.className = "card-sub";
      p.textContent = "当前会话暂无后台任务。";
      stack.appendChild(p);
    } else {
      for (const bt of state.backgroundTasks.slice(0, 4)) stack.appendChild(createBgTaskCard(bt, true));
    }
  }
  body.appendChild(stack);
}

function renderTasksTab() {
  // 1. Todos
  const todosEl = document.getElementById("tasks-view-todos");
  clearEl(todosEl);
  if (state.todos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = "当前会话暂无待办";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "当 Agent 在 PI-Desktop 中使用 TodoWrite 拆解多步任务时，进度会实时同步到这里。";
    empty.append(t, d);
    todosEl.appendChild(empty);
  } else {
    const completed = state.todos.filter((x) => x.status === "completed").length;
    const active = Math.max(1, state.todos.filter((x) => x.status !== "cancelled").length);
    const pct = Math.round((completed / active) * 100);

    const summaryCard = document.createElement("div");
    summaryCard.className = "card";
    const head = document.createElement("div");
    head.className = "between";
    const label = document.createElement("div");
    label.className = "card-title";
    label.textContent = `会话待办进度 · ${completed} / ${active}`;
    const pctChip = document.createElement("span");
    pctChip.className = `chip ${pct === 100 ? "ok" : ""}`;
    pctChip.textContent = `${pct}%`;
    head.append(label, pctChip);
    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    summaryCard.append(head, track);
    todosEl.appendChild(summaryCard);

    for (const todo of state.todos) {
      todosEl.appendChild(createTodoItemNode(todo));
    }
  }

  // 2. Background tasks
  const bgEl = document.getElementById("tasks-view-bg");
  clearEl(bgEl);
  if (state.backgroundTasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = "暂无后台命令或子代理";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "Agent 启动后台开发服务、长时构建（runInBackground）或子代理（Task）时，会实时追踪状态与日志输出。";
    empty.append(t, d);
    bgEl.appendChild(empty);
  } else {
    for (const bt of state.backgroundTasks) {
      bgEl.appendChild(createBgTaskCard(bt, false));
    }
  }

  // 3. Scheduled tasks
  const schedEl = document.getElementById("tasks-view-scheduled");
  clearEl(schedEl);
  if (state.scheduledTasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = "暂无定时自动化任务";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "PI-Desktop 中配置的定时自动化任务（scheduled/list）会同步显示在这里。";
    empty.append(t, d);
    schedEl.appendChild(empty);
  } else {
    for (const st of state.scheduledTasks) {
      const card = document.createElement("div");
      card.className = "card stack";
      card.style.gap = "6px";
      const top = document.createElement("div");
      top.className = "between";
      const title = document.createElement("div");
      title.className = "row-title";
      title.textContent = st.title;
      const chip = document.createElement("span");
      chip.className = `chip sm ${st.enabled ? "ok" : ""}`;
      chip.textContent = st.enabled ? st.cadence || "已启用" : "已暂停";
      top.append(title, chip);
      card.appendChild(top);
      if (st.prompt) {
        const desc = document.createElement("div");
        desc.className = "card-sub";
        desc.textContent = st.prompt;
        card.appendChild(desc);
      }
      const foot = document.createElement("div");
      foot.className = "card-sub";
      foot.style.fontFamily = "var(--font-mono)";
      foot.style.fontSize = "11px";
      foot.textContent = `下次运行: ${st.nextRunAt || "手动触发"} · 最近状态: ${st.lastStatus || "-"}`;
      card.appendChild(foot);
      schedEl.appendChild(card);
    }
  }
}

/* ==========================================================================
   Rendering: Chat Timeline
   ========================================================================== */
function createChevronSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", "chevron");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  svg.appendChild(path);
  return svg;
}

function createProcessCapsule(steps) {
  const toolCount = steps.filter((s) => s.role === "tool").length;
  const thinkCount = steps.filter((s) => s.role !== "tool").length;
  const parts = [];
  if (toolCount > 0) parts.push(`${toolCount} 次工具`);
  if (thinkCount > 0) parts.push(`${thinkCount} 步思考`);

  const det = document.createElement("details");
  det.className = "process-capsule";
  const sum = document.createElement("summary");
  const left = document.createElement("span");
  left.className = "summary-left";
  left.textContent = `思考与工具执行 · ${parts.join(" · ") || `${steps.length} 步`}`;
  sum.append(left, createChevronSvg());
  det.appendChild(sum);

  const tl = document.createElement("div");
  tl.className = "process-timeline";
  for (const st of steps) {
    const row = document.createElement("div");
    row.className = "proc-step";
    if (st.role === "tool") {
      const head = document.createElement("div");
      head.className = "proc-tool-head";
      head.textContent = `${st.toolName || "Tool"} · ${st.toolStatus || "done"}`;
      row.appendChild(head);
      if (st.toolArgsPreview) {
        const args = document.createElement("div");
        args.className = "proc-args";
        args.textContent = st.toolArgsPreview;
        row.appendChild(args);
      }
    } else {
      if (st.content) {
        const note = document.createElement("div");
        note.textContent = st.content;
        row.appendChild(note);
      }
      if (st.thinking) {
        const tk = document.createElement("div");
        tk.className = "proc-think-text";
        tk.textContent = st.thinking;
        row.appendChild(tk);
      }
    }
    tl.appendChild(row);
  }
  det.appendChild(tl);
  return det;
}

function createMessageNode(m) {
  const row = document.createElement("div");
  row.className = `msg-row ${m.role === "user" ? "user" : "assistant"}`;
  if (m.id) row.dataset.msgId = m.id;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${m.role === "user" ? "user" : "assistant"}`;

  if (m.role === "user") {
    bubble.textContent = m.content || "";
  } else {
    if (m.thinking) {
      const det = document.createElement("details");
      det.className = "process-capsule nested-think";
      const sum = document.createElement("summary");
      const left = document.createElement("span");
      left.className = "summary-left";
      left.textContent = `思考过程 · ${m.thinking.length} 字`;
      sum.append(left, createChevronSvg());
      const body = document.createElement("div");
      body.className = "proc-think-text";
      body.style.marginTop = "7px";
      body.textContent = m.thinking;
      det.append(sum, body);
      bubble.appendChild(det);
    }
    const md = document.createElement("div");
    md.className = "md-body";
    renderMarkdownToDom(md, m.content || "");
    bubble.appendChild(md);
  }

  row.appendChild(bubble);
  return row;
}

function renderChatTimeline() {
  const container = document.getElementById("chat-timeline");
  clearEl(container);
  renderChatTaskDock();

  if (!state.activeSession) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const mark = document.createElement("div");
    mark.className = "empty-mark";
    mark.textContent = "⌘";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = state.hosts.length > 0 ? "连接桌面主机开始工作" : "PI Remote Console";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "端到端加密远程控制 PI-Desktop：切换智能体/目标/规划模式、权限策略、模型供应商与实时待办后台任务。";
    const actions = document.createElement("div");
    actions.className = "row";
    actions.style.marginTop = "6px";

    const goHosts = document.createElement("button");
    goHosts.className = "btn primary";
    goHosts.textContent = state.hosts.length > 0 ? "连接已配对主机" : "配对桌面主机";
    goHosts.onclick = () => {
      setTab("settings");
      setSettingsSubTab("hosts");
    };

    actions.append(goHosts);
    empty.append(mark, t, d, actions);
    container.appendChild(empty);
    return;
  }

  let procBuf = [];
  const flushProc = () => {
    if (procBuf.length > 0) {
      container.appendChild(createProcessCapsule(procBuf));
      procBuf = [];
    }
  };

  for (const m of state.messages) {
    if (m.role === "tool" || m.isProcessStep) {
      procBuf.push(m);
      continue;
    }
    flushProc();
    container.appendChild(createMessageNode(m));
  }
  flushProc();

  if (state.streamNode) container.appendChild(state.streamNode);

  const panel = document.getElementById("panel-chat");
  panel.scrollTop = panel.scrollHeight;
}

function updateStreamingBubble(text) {
  const container = document.getElementById("chat-timeline");
  if (!state.streamNode) {
    const row = document.createElement("div");
    row.className = "msg-row assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble assistant streaming";
    const md = document.createElement("div");
    md.className = "md-body";
    bubble.appendChild(md);
    row.appendChild(bubble);
    state.streamNode = row;
    container.appendChild(row);
  }
  const md = state.streamNode.querySelector(".md-body");
  renderMarkdownToDom(md, text);
  const panel = document.getElementById("panel-chat");
  panel.scrollTop = panel.scrollHeight;
}

function clearStreamingBubble() {
  if (state.streamNode) {
    state.streamNode.remove();
    state.streamNode = null;
  }
  state.streamText = "";
}

/* ==========================================================================
   Rendering: Settings (Providers & Models + Hosts)
   ========================================================================== */
function renderProvidersSettings() {
  const kv = document.getElementById("host-defaults-kv");
  clearEl(kv);
  const s = state.hostSettings || {};
  const entries = [
    ["默认模式", MODE_LABELS[s.defaultMode] || s.defaultMode || "智能体"],
    ["默认权限", PERM_LABELS[s.defaultPermissionMode] || s.defaultPermissionMode || "每次询问"],
    ["默认模型", s.defaultModelId || "未指定"],
    ["默认推理", THINK_LABELS[s.defaultThinkingLevel] || s.defaultThinkingLevel || "高"],
  ];
  for (const [k, v] of entries) {
    const cell = document.createElement("div");
    cell.className = "kv-cell";
    const kEl = document.createElement("div");
    kEl.className = "kv-k";
    kEl.textContent = k;
    const vEl = document.createElement("div");
    vEl.className = "kv-v";
    vEl.textContent = v;
    cell.append(kEl, vEl);
    kv.appendChild(cell);
  }

  document.getElementById("providers-count-chip").textContent = `${state.providers.length} 个`;
  const list = document.getElementById("providers-list");
  clearEl(list);

  if (state.providers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = "尚未同步模型供应商";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "连接已配对的 PI-Desktop 主机后，会自动拉取所有已配置供应商与可用模型（不含任何明文密钥）。";
    empty.append(t, d);
    list.appendChild(empty);
    return;
  }

  for (const p of state.providers) {
    const card = document.createElement("div");
    card.className = "provider-card";
    const isOpen = state.expandedProviders.has(p.id);

    const head = document.createElement("div");
    head.className = "provider-head";
    head.onclick = () => {
      if (state.expandedProviders.has(p.id)) state.expandedProviders.delete(p.id);
      else state.expandedProviders.add(p.id);
      renderProvidersSettings();
    };

    const left = document.createElement("div");
    left.style.minWidth = "0";
    const nameRow = document.createElement("div");
    nameRow.className = "row";
    nameRow.style.gap = "6px";
    const name = document.createElement("span");
    name.className = "row-title";
    name.textContent = p.name;
    const keyChip = document.createElement("span");
    keyChip.className = `chip sm ${p.hasApiKey ? "ok" : "warn"}`;
    keyChip.textContent = p.hasApiKey ? "已认证" : "未配密钥";
    if (!p.enabled) {
      const disChip = document.createElement("span");
      disChip.className = "chip sm";
      disChip.textContent = "已停用";
      nameRow.append(name, disChip);
    } else {
      nameRow.append(name, keyChip);
    }

    const meta = document.createElement("div");
    meta.className = "card-sub";
    meta.style.fontFamily = "var(--font-mono)";
    meta.style.fontSize = "11px";
    meta.textContent = `${p.apiStyle || "standard"}${p.baseUrl ? ` · ${p.baseUrl}` : ""}`;
    left.append(nameRow, meta);

    const right = document.createElement("div");
    right.className = "row";
    const mCount = document.createElement("span");
    mCount.className = "chip sm";
    mCount.textContent = `${(p.models || []).length} 模型`;
    const chev = createChevronSvg();
    if (isOpen) chev.classList.add("open");
    right.append(mCount, chev);

    head.append(left, right);
    card.appendChild(head);

    if (isOpen) {
      const mWrap = document.createElement("div");
      mWrap.className = "provider-models";
      const models = p.models || [];
      if (models.length === 0) {
        const none = document.createElement("div");
        none.className = "card-sub";
        none.textContent = "此供应商暂无缓存模型，可点击上方「刷新目录」。";
        mWrap.appendChild(none);
      } else {
        for (const m of models) {
          const isCur =
            state.activeSession &&
            state.activeSession.modelId === m.id &&
            (!state.activeSession.providerId || state.activeSession.providerId === p.id);
          const row = document.createElement("div");
          row.className = `model-row ${isCur ? "active" : ""}`;
          row.onclick = async () => {
            if (!state.activeSession) {
              showToast("请先选择一个会话再应用模型");
              return;
            }
            await configureActiveSession({ providerId: p.id, modelId: m.id });
          };

          const ml = document.createElement("div");
          ml.style.minWidth = "0";
          const mid = document.createElement("div");
          mid.className = "model-id";
          mid.textContent = m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id;
          const tags = [];
          if (m.contextWindow) tags.push(`${Math.round(m.contextWindow / 1000)}K ctx`);
          if (m.reasoning) tags.push("推理");
          if (m.vision) tags.push("视觉");
          ml.appendChild(mid);
          if (tags.length > 0) {
            const msub = document.createElement("div");
            msub.className = "card-sub";
            msub.style.fontSize = "11px";
            msub.textContent = tags.join(" · ");
            ml.appendChild(msub);
          }

          const action = document.createElement("span");
          action.className = `chip sm ${isCur ? "solid" : ""}`;
          action.textContent = isCur ? "当前使用" : "选用";
          row.append(ml, action);
          mWrap.appendChild(row);
        }
      }
      card.appendChild(mWrap);
    }

    list.appendChild(card);
  }
}

function renderHosts() {
  document.getElementById("hosts-count-chip").textContent = `${state.hosts.length} 台`;
  const list = document.getElementById("hosts-list");
  clearEl(list);

  if (state.hosts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = "尚未绑定桌面主机";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "在 PI-Desktop「远程控制」面板点「生成配对码」，粘贴到上方发起 E2EE 绑定。";
    empty.append(t, d);
    list.appendChild(empty);
    return;
  }

  for (const h of state.hosts) {
    const isConnected =
      state.activeHost?.hostId === h.hostId &&
      state.ws &&
      state.ws.readyState === WebSocket.OPEN;

    const card = document.createElement("div");
    card.className = "card stack";

    const head = document.createElement("div");
    head.className = "between";
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "card-title";
    name.textContent = h.hostName;
    const id = document.createElement("div");
    id.className = "card-sub";
    id.style.fontFamily = "var(--font-mono)";
    id.style.fontSize = "11px";
    id.textContent = h.hostId;
    left.append(name, id);

    const status = document.createElement("span");
    status.className = `chip sm ${isConnected ? "ok" : ""}`;
    status.textContent = isConnected
      ? state.transportKind === "relay"
        ? "● 盲中继"
        : "● 直连"
      : "○ 离线";
    head.append(left, status);

    const ep = document.createElement("div");
    ep.className = "card-sub";
    ep.textContent = `直连端点 ${(h.directUrls || []).length} 个 · ${h.relayUrl ? `中继 ${h.relayUrl}` : "仅局域网直连"}`;

    const actions = document.createElement("div");
    actions.className = "row";
    const btnConn = document.createElement("button");
    btnConn.className = `btn ${isConnected ? "" : "primary"}`;
    btnConn.style.flex = "1";
    btnConn.textContent = isConnected ? "进入工作台" : "加密连接";
    btnConn.onclick = () => (isConnected ? setTab("chat") : connectPairedHost(h));

    const btnDel = document.createElement("button");
    btnDel.className = "btn danger";
    btnDel.textContent = "移除";
    btnDel.onclick = () => {
      if (state.activeHost?.hostId === h.hostId && state.ws) state.ws.close();
      state.hosts = state.hosts.filter((x) => x.hostId !== h.hostId);
      saveHosts();
      renderHosts();
      showToast("已移除该主机记录");
    };

    actions.append(btnConn, btnDel);
    card.append(head, ep, actions);
    list.appendChild(card);
  }
}

/* ==========================================================================
   Rendering: Inbox & Diff
   ========================================================================== */
function renderInbox() {
  const list = document.getElementById("inbox-list");
  clearEl(list);
  if (state.pendingItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const title = document.createElement("div");
    title.className = "empty-title";
    title.textContent = "暂无待审批项";
    const desc = document.createElement("div");
    desc.className = "empty-desc";
    desc.textContent = "所有会话当前均无阻塞的工具权限请求、Plan 检查点或提问卡片。";
    empty.append(title, desc);
    list.appendChild(empty);
    return;
  }

  for (const item of state.pendingItems) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.cursor = "pointer";
    card.onclick = () => openApprovalSheet(item);

    const top = document.createElement("div");
    top.className = "between";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.title;
    const badge = document.createElement("span");
    badge.className = `chip sm ${item.risk === "high" ? "danger" : "warn"}`;
    badge.textContent = item.requiresDesktopConfirm ? "需桌面确认" : item.risk === "high" ? "高风险" : "待审阅";
    top.append(title, badge);

    const sum = document.createElement("div");
    sum.className = "card-sub";
    sum.style.marginTop = "6px";
    sum.textContent = item.summary;

    const foot = document.createElement("div");
    foot.className = "between";
    foot.style.marginTop = "10px";
    const meta = document.createElement("span");
    meta.style.cssText = "font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);";
    meta.textContent = item.sessionTitle || item.sessionId;
    const cta = document.createElement("span");
    cta.style.cssText = "font-size:12px;font-weight:600;color:var(--text);";
    cta.textContent = "审阅 ›";
    foot.append(meta, cta);

    card.append(top, sum, foot);
    list.appendChild(card);
  }
}

function renderDiff() {
  const branchEl = document.getElementById("diff-branch-label");
  branchEl.textContent = state.diffBranch
    ? `分支 ${state.diffBranch} · ${state.diffFiles.length} 文件`
    : `工作区变更 · ${state.diffFiles.length} 文件`;

  const filesWrap = document.getElementById("diff-files-wrap");
  const patchWrap = document.getElementById("diff-patch-wrap");
  clearEl(filesWrap);
  clearEl(patchWrap);

  if (state.diffFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card empty-state";
    const t = document.createElement("div");
    t.className = "empty-title";
    t.textContent = "工作区干净";
    const d = document.createElement("div");
    d.className = "empty-desc";
    d.textContent = "当前无未提交代码改动；敏感凭据路径（.env* / .ssh / *.pem）已由插件自动屏蔽。";
    empty.append(t, d);
    filesWrap.appendChild(empty);
    return;
  }

  for (const f of state.diffFiles) {
    const row = document.createElement("div");
    row.className = `diff-file-row ${state.selectedDiffPath === f.path ? "selected" : ""}`;
    row.onclick = () => selectDiffFile(f.path);

    const left = document.createElement("div");
    left.className = "row";
    left.style.minWidth = "0";
    left.style.flex = "1";
    const st = document.createElement("span");
    st.className = `chip sm ${f.status === "A" || f.status === "?" ? "ok" : f.status === "D" ? "danger" : "warn"}`;
    st.textContent = f.status;
    const p = document.createElement("span");
    p.className = "diff-path";
    p.textContent = f.path;
    left.append(st, p);

    const right = document.createElement("div");
    right.className = "row";
    right.style.flexShrink = "0";
    const add = document.createElement("span");
    add.style.cssText = "font-family:var(--font-mono);font-size:11.5px;font-weight:600;color:var(--ok);";
    add.textContent = `+${f.additions}`;
    const del = document.createElement("span");
    del.style.cssText = "font-family:var(--font-mono);font-size:11.5px;font-weight:600;color:var(--danger);";
    del.textContent = `-${f.deletions}`;
    right.append(add, del);

    row.append(left, right);
    filesWrap.appendChild(row);
  }

  if (state.activePatch) {
    if (state.activePatch.binary) {
      const card = document.createElement("div");
      card.className = "card";
      card.textContent = "二进制文件不支持文本差异预览。";
      patchWrap.appendChild(card);
    } else {
      for (const hunk of state.activePatch.hunks || []) {
        const box = document.createElement("div");
        box.className = "diff-hunk";
        const head = document.createElement("div");
        head.className = "diff-hunk-head";
        head.textContent = `${state.activePatch.path}  ${hunk.header}`;
        const scroller = document.createElement("div");
        scroller.className = `diff-scroll ${state.diffWrap ? "wrap" : ""}`;
        for (const l of hunk.lines || []) {
          const line = document.createElement("div");
          line.className = `diff-line ${l.type === "add" ? "add" : l.type === "del" ? "del" : ""}`;
          const oldN = document.createElement("span");
          oldN.className = "diff-ln";
          oldN.textContent = l.oldLine ?? "";
          const newN = document.createElement("span");
          newN.className = "diff-ln";
          newN.textContent = l.newLine ?? "";
          const sign = document.createElement("span");
          sign.className = "diff-sign";
          sign.textContent = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
          const txt = document.createElement("span");
          txt.className = "diff-text";
          txt.textContent = l.text;
          line.append(oldN, newN, sign, txt);
          scroller.appendChild(line);
        }
        box.append(head, scroller);
        patchWrap.appendChild(box);
      }
    }
  }
}

/* ==========================================================================
   Bottom Sheets: Switcher, Mode/Permission Picker, Model Picker, Approval
   ========================================================================== */
function openSwitcherSheet() {
  const projWrap = document.getElementById("sheet-projects");
  const sessWrap = document.getElementById("sheet-sessions");
  clearEl(projWrap);
  clearEl(sessWrap);

  const projects = state.hostInfo?.projects || [];
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "card-sub";
    empty.textContent = "尚未连接主机。请先前往「设置 → 主机与配对」连接电脑。";
    sessWrap.appendChild(empty);
  } else {
    for (const p of projects) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `proj-pill ${state.activeProject?.path === p.path ? "active" : ""}`;
      pill.textContent = p.name;
      pill.onclick = async () => {
        state.activeProject = p;
        const res = await rpcCall("session.list", { projectPath: p.path });
        state.sessions = res.sessions || [];
        await refreshDiff().catch(() => {});
        openSwitcherSheet();
      };
      projWrap.appendChild(pill);
    }

    for (const s of state.sessions) {
      const item = document.createElement("div");
      item.className = `sheet-item ${state.activeSession?.id === s.id ? "active" : ""}`;
      const left = document.createElement("div");
      left.style.minWidth = "0";
      const t = document.createElement("div");
      t.style.cssText = "font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      t.textContent = s.title;
      const meta = document.createElement("div");
      meta.className = "card-sub";
      meta.style.fontSize = "11px";
      const mLabel = MODE_LABELS[s.mode] || "智能体";
      const pLabel = PERM_LABELS[s.permissionMode === "inherit" ? state.hostSettings.defaultPermissionMode : s.permissionMode] || "每次询问";
      meta.textContent = `${mLabel} · ${pLabel} · ${s.modelId || s.model || "默认模型"}`;
      left.append(t, meta);

      const chip = document.createElement("span");
      chip.className = `chip sm ${state.activeSession?.id === s.id ? "solid" : ""}`;
      chip.textContent = state.activeSession?.id === s.id ? "当前" : s.status === "running" ? "运行中" : "打开";
      item.append(left, chip);

      item.onclick = async () => {
        closeSwitcherSheet();
        await selectSession(s);
      };
      sessWrap.appendChild(item);
    }
  }
  document.getElementById("switcher-backdrop").classList.add("open");
}

function closeSwitcherSheet() {
  document.getElementById("switcher-backdrop").classList.remove("open");
}

function openModePicker() {
  if (!state.activeSession) return;
  const cur = state.activeSession.mode || "agent";
  document.getElementById("picker-title").textContent = "切换会话模式";
  document.getElementById("picker-sub").textContent = "决定 Agent 本回合的执行与规划方式";
  const wrap = document.getElementById("picker-options");
  clearEl(wrap);

  for (const m of SESSION_MODES) {
    const row = document.createElement("div");
    row.className = `sheet-item ${cur === m.id ? "active" : ""}`;
    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "row-title";
    t.textContent = m.label;
    const d = document.createElement("div");
    d.className = "card-sub";
    d.textContent = m.desc;
    left.append(t, d);

    const mark = document.createElement("span");
    mark.className = `chip sm ${cur === m.id ? "solid" : ""}`;
    mark.textContent = cur === m.id ? "已选" : "切换";
    row.append(left, mark);

    row.onclick = async () => {
      closePickerSheet();
      if (cur !== m.id) await configureActiveSession({ mode: m.id });
    };
    wrap.appendChild(row);
  }
  document.getElementById("picker-backdrop").classList.add("open");
}

function openPermissionPicker() {
  if (!state.activeSession) return;
  if (state.activeSession.mode === "goal") {
    showToast("「目标」模式由目标合约控制权限，请先切换到智能体或规划模式");
    return;
  }
  const cur = getEffectivePermissionMode(state.activeSession);
  document.getElementById("picker-title").textContent = "切换权限模式";
  document.getElementById("picker-sub").textContent = "控制文件编辑与命令执行的确认级别";
  const wrap = document.getElementById("picker-options");
  clearEl(wrap);

  for (const p of PERMISSION_MODES) {
    const row = document.createElement("div");
    row.className = `sheet-item ${cur === p.id ? "active" : ""}`;
    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "row-title";
    t.textContent = p.label;
    const d = document.createElement("div");
    d.className = "card-sub";
    d.textContent = p.desc;
    left.append(t, d);

    const mark = document.createElement("span");
    mark.className = `chip sm ${cur === p.id ? (p.id === "auto" ? "warn" : "solid") : ""}`;
    mark.textContent = cur === p.id ? "当前" : "选择";
    row.append(left, mark);

    row.onclick = async () => {
      closePickerSheet();
      await configureActiveSession({ permissionMode: p.id });
    };
    wrap.appendChild(row);
  }
  document.getElementById("picker-backdrop").classList.add("open");
}

function closePickerSheet() {
  document.getElementById("picker-backdrop").classList.remove("open");
}

function renderModelPickerBody(query = "") {
  const thinkWrap = document.getElementById("think-pills");
  clearEl(thinkWrap);
  const curThink = state.activeSession?.thinkingLevel || state.hostSettings?.defaultThinkingLevel || "high";
  for (const lv of THINKING_LEVELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `think-pill ${curThink === lv.id ? "active" : ""}`;
    btn.textContent = lv.label;
    btn.onclick = async () => {
      await configureActiveSession({ thinkingLevel: lv.id });
      renderModelPickerBody(document.getElementById("model-search-input").value);
    };
    thinkWrap.appendChild(btn);
  }

  const groupsEl = document.getElementById("model-groups");
  clearEl(groupsEl);
  const q = query.trim().toLowerCase();

  let matchedCount = 0;
  for (const p of state.providers) {
    if (!p.enabled) continue;
    const models = (p.models || []).filter((m) => {
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        (m.name || "").toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q)
      );
    });
    if (models.length === 0) continue;
    matchedCount += models.length;

    const head = document.createElement("div");
    head.className = "section-row";
    const lbl = document.createElement("span");
    lbl.className = "section-label";
    lbl.textContent = p.name;
    const keyTag = document.createElement("span");
    keyTag.className = `chip sm ${p.hasApiKey ? "ok" : "warn"}`;
    keyTag.textContent = p.hasApiKey ? "已认证" : "未配密钥";
    head.append(lbl, keyTag);
    groupsEl.appendChild(head);

    for (const m of models) {
      const isCur =
        state.activeSession &&
        state.activeSession.modelId === m.id &&
        (!state.activeSession.providerId || state.activeSession.providerId === p.id);
      const row = document.createElement("div");
      row.className = `model-row ${isCur ? "active" : ""}`;
      row.onclick = async () => {
        closeModelSheet();
        await configureActiveSession({ providerId: p.id, modelId: m.id });
      };

      const left = document.createElement("div");
      left.style.minWidth = "0";
      const mid = document.createElement("div");
      mid.className = "model-id";
      mid.textContent = m.name && m.name !== m.id ? `${m.name}` : m.id;
      const sub = document.createElement("div");
      sub.className = "card-sub";
      sub.style.fontSize = "11px";
      const metaParts = [m.id];
      if (m.contextWindow) metaParts.push(`${Math.round(m.contextWindow / 1000)}K`);
      if (m.reasoning) metaParts.push("推理");
      if (m.vision) metaParts.push("视觉");
      sub.textContent = metaParts.join(" · ");
      left.append(mid, sub);

      const badge = document.createElement("span");
      badge.className = `chip sm ${isCur ? "solid" : ""}`;
      badge.textContent = isCur ? "当前" : "选择";
      row.append(left, badge);
      groupsEl.appendChild(row);
    }
  }

  if (matchedCount === 0) {
    const empty = document.createElement("div");
    empty.className = "card-sub";
    empty.style.textAlign = "center";
    empty.style.padding = "18px 0";
    empty.textContent = q ? "没有匹配的模型" : "暂无可用模型，请前往「设置 → 供应商与模型」刷新目录。";
    groupsEl.appendChild(empty);
  }
}

async function openModelSheet() {
  if (!state.activeSession) return;
  if (state.activeHost && state.providers.length === 0) {
    await refreshProvidersAndSettings().catch(() => {});
  }
  const input = document.getElementById("model-search-input");
  input.value = "";
  renderModelPickerBody("");
  document.getElementById("model-backdrop").classList.add("open");
}

function closeModelSheet() {
  document.getElementById("model-backdrop").classList.remove("open");
}

function openApprovalSheet(item) {
  state.reviewItem = item;
  state.reviewStepConfirmed = false;

  document.getElementById("apr-meta").textContent = `${
    item.kind === "permission" ? "工具权限审批" : item.kind === "plan" ? "Plan 检查点" : "Agent 提问"
  } · ${item.risk === "high" ? "高风险（仅允许单次）" : item.risk.toUpperCase()}`;
  document.getElementById("apr-title").textContent = item.title;
  document.getElementById("apr-summary").textContent = item.summary;
  document.getElementById("apr-feedback").textContent = "";

  const argsWrap = document.getElementById("apr-args-wrap");
  if (item.argsPreview) {
    argsWrap.classList.remove("hidden");
    document.getElementById("apr-args").textContent = item.argsPreview;
  } else {
    argsWrap.classList.add("hidden");
  }

  document.getElementById("apr-desktop-warn").classList.toggle("hidden", !item.requiresDesktopConfirm);
  const btnDeny = document.getElementById("btn-apr-deny");
  const btnAllow = document.getElementById("btn-apr-allow");
  btnDeny.disabled = Boolean(item.requiresDesktopConfirm);
  btnAllow.disabled = Boolean(item.requiresDesktopConfirm);
  btnAllow.textContent = item.risk === "high" ? "核对参数并继续" : "确认：仅此一次允许";

  document.getElementById("approval-backdrop").classList.add("open");
}

function closeApprovalSheet() {
  document.getElementById("approval-backdrop").classList.remove("open");
  state.reviewItem = null;
  state.reviewStepConfirmed = false;
}

/* ==========================================================================
   Host Hydration & Data Refresh
   ========================================================================== */
async function refreshProvidersAndSettings(forceRefreshCatalog = false) {
  if (!state.activeHost) return;
  const [provRes, setRes] = await Promise.all([
    rpcCall(forceRefreshCatalog ? "providers.refreshCatalog" : "providers.list").catch(() => ({ providers: [] })),
    rpcCall("settings.get").catch(() => null),
  ]);
  state.providers = provRes?.providers || [];
  if (state.providers.length > 0 && state.expandedProviders.size === 0) {
    state.expandedProviders.add(state.providers[0].id);
  }
  if (setRes) state.hostSettings = { ...state.hostSettings, ...setRes };
  renderProvidersSettings();
  updateComposerControls();
}

async function refreshTasks() {
  if (!state.activeHost) return;
  const res = await rpcCall("tasks.list", {
    sessionId: state.activeSession?.id || undefined,
  }).catch(() => null);
  if (!res) return;
  state.todos = Array.isArray(res.todos) ? res.todos : [];
  state.backgroundTasks = Array.isArray(res.backgroundTasks) ? res.backgroundTasks : [];
  state.scheduledTasks = Array.isArray(res.scheduledTasks) ? res.scheduledTasks : [];
  renderChatTaskDock();
  renderTasksTab();
  updateBadges();
}

async function hydrateHost() {
  state.hostInfo = await rpcCall("host.info");
  state.activeProject =
    state.hostInfo.projects.find((p) => p.active) || state.hostInfo.projects[0] || null;

  const [sessRes] = await Promise.all([
    rpcCall("session.list", state.activeProject ? { projectPath: state.activeProject.path } : {}),
    refreshProvidersAndSettings(false),
    refreshPending(),
    refreshDiff(),
  ]);
  state.sessions = sessRes.sessions || [];
  if (state.sessions.length > 0) {
    await selectSession(state.sessions[0]);
  } else {
    state.activeSession = null;
    state.messages = [];
    state.todos = [];
    state.backgroundTasks = [];
    await refreshTasks();
    renderChatTimeline();
  }
  updateHeader();
  updateBadges();
  renderHosts();
  setTab("chat");
}

async function selectSession(s) {
  const detail = await rpcCall("session.get", { sessionId: s.id });
  state.activeSession = detail.session;
  state.messages = detail.messages || [];
  state.todos = Array.isArray(detail.todos) ? detail.todos : [];
  state.backgroundTasks = Array.isArray(detail.backgroundTasks) ? detail.backgroundTasks : [];
  state.isRunning = detail.session.status === "running";
  clearStreamingBubble();
  renderChatTimeline();
  renderTasksTab();
  updateHeader();
  updateBadges();
  refreshTasks().catch(() => {});
}

async function refreshPending() {
  const res = await rpcCall("pending.list").catch(() => ({ items: [] }));
  state.pendingItems = res.items || [];
  renderInbox();
  updateBadges();
}

async function refreshDiff() {
  if (!state.activeProject) return;
  const res = await rpcCall("diff.summary", { projectPath: state.activeProject.path }).catch(() => ({
    branch: "",
    files: [],
  }));
  state.diffBranch = res.branch || "";
  state.diffFiles = res.files || [];
  if (state.diffFiles.length > 0 && !state.selectedDiffPath) {
    await selectDiffFile(state.diffFiles[0].path);
  } else {
    renderDiff();
  }
  updateBadges();
}

async function selectDiffFile(filePath) {
  state.selectedDiffPath = filePath;
  state.activePatch = await rpcCall("diff.file", {
    projectPath: state.activeProject.path,
    filePath,
  });
  renderDiff();
}

async function connectPairedHost(record) {
  try {
    showToast(`正在加密连接 ${record.hostName}...`);
    if (state.ws) state.ws.close();
    const { sock, kind } = await connectBestTransport(record.directUrls, record.relayUrl);
    state.ws = sock;
    state.transportKind = kind;
    state.activeHost = record;
    state.txSeq = 0;
    state.replayWindow = new ReplayWindow();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("握手超时")), 5000);
      sock.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data));
        if (frame.t === "client.joined") {
          clearTimeout(timer);
          resolve();
        } else if (frame.t === "error") {
          clearTimeout(timer);
          reject(new Error(frame.message || frame.code));
        }
      };
      sock.send(JSON.stringify({ t: "client.join", routeId: record.routeId || "direct", deviceId: record.deviceId }));
    });

    attachAuthenticatedSocket(sock);
    await hydrateHost();
    showToast(`已通过 ${kind === "relay" ? "盲中继" : "LAN 直连"} 建立 E2EE 连接`);
  } catch (err) {
    showToast(err.message || "连接失败");
  }
}

async function startPairing() {
  const errEl = document.getElementById("pair-error");
  errEl.textContent = "";
  let invite;
  try {
    invite = JSON.parse(document.getElementById("invite-input").value.trim());
  } catch {
    errEl.textContent = "配对串 JSON 格式无效";
    return;
  }
  const check = validatePairingInvite(invite);
  if (!check.ok) {
    errEl.textContent = check.error;
    return;
  }

  try {
    if (state.ws) state.ws.close();
    const { sock, kind } = await connectBestTransport(invite.directUrls, invite.relayUrl);
    state.ws = sock;
    state.transportKind = kind;

    const deviceId = `web_${randomId(8)}`;
    const kp = generateX25519KeyPair();
    const proof = await computeInviteProof({
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      clientDhPubB64: kp.publicKeyB64,
    });
    const shared = computeSharedSecret(kp.privateKey, base64ToBytes(invite.hostDhPub));
    const derived = await derivePairingMaterial({
      sharedSecret: shared,
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      hostDhPubB64: invite.hostDhPub,
      clientDhPubB64: kp.publicKeyB64,
    });

    sock.onmessage = async (ev) => {
      const frame = JSON.parse(String(ev.data));
      if (frame.t === "client.joined") {
        sock.send(
          JSON.stringify({
            t: "pair",
            routeId: invite.routeId || "direct",
            deviceId,
            payload: {
              step: "pair.hello",
              inviteId: invite.inviteId,
              deviceName: "PI Remote Web",
              clientDhPub: kp.publicKeyB64,
              inviteProof: proof,
            },
          })
        );
      } else if (frame.t === "pair" && frame.payload?.step === "pair.pending_approval") {
        document.getElementById("sas-hero").classList.remove("hidden");
        document.getElementById("sas-digits").textContent = derived.sasCode;
        document.getElementById("sas-sub").textContent = `请在 ${invite.hostName} 桌面确认短码一致并同意配对`;
      } else if (frame.t === "pair" && frame.payload?.step === "pair.approved") {
        document.getElementById("sas-hero").classList.add("hidden");
        document.getElementById("invite-input").value = "";
        const record = {
          hostId: invite.hostId,
          hostName: frame.payload.hostName || invite.hostName,
          deviceId,
          keyId: derived.keyId,
          sessionKeyB64: derived.sessionKeyB64,
          directUrls: invite.directUrls || [],
          relayUrl: invite.relayUrl || null,
          routeId: invite.routeId || null,
        };
        state.activeHost = record;
        state.hosts = [record, ...state.hosts.filter((h) => h.hostId !== record.hostId)];
        saveHosts();
        state.txSeq = 0;
        state.replayWindow = new ReplayWindow();
        attachAuthenticatedSocket(sock);
        await hydrateHost();
        showToast("E2EE 配对成功");
      } else if (frame.t === "pair" && frame.payload?.step === "pair.rejected") {
        document.getElementById("sas-hero").classList.add("hidden");
        errEl.textContent = frame.payload.reason || "配对被拒绝";
      }
    };

    sock.send(JSON.stringify({ t: "client.join", routeId: invite.routeId || "direct", deviceId }));
  } catch (err) {
    errEl.textContent = err.message || "配对连接失败";
  }
}


/* ==========================================================================
   Wire Events & Boot
   ========================================================================== */
for (const btn of document.querySelectorAll(".tab-btn")) {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
}
for (const btn of document.querySelectorAll("[data-task-sub]")) {
  btn.addEventListener("click", () => setTasksSubTab(btn.dataset.taskSub));
}
for (const btn of document.querySelectorAll("[data-settings-sub]")) {
  btn.addEventListener("click", () => setSettingsSubTab(btn.dataset.settingsSub));
}

document.getElementById("btn-toggle-dock").onclick = () => {
  state.dockOpen = !state.dockOpen;
  renderChatTaskDock();
};
document.getElementById("dock-tab-todos").onclick = () => {
  state.dockTab = "todos";
  renderChatTaskDock();
};
document.getElementById("dock-tab-bg").onclick = () => {
  state.dockTab = "bg";
  renderChatTaskDock();
};
document.getElementById("btn-dock-open-tasks").onclick = () => {
  setTab("tasks");
  setTasksSubTab(state.dockTab === "bg" ? "bg" : "todos");
};

document.getElementById("btn-theme-toggle").onclick = (e) => {
  switchThemeAnimated(state.theme === "dark" ? "light" : "dark", e);
};
document.getElementById("btn-set-light").onclick = (e) => switchThemeAnimated("light", e);
document.getElementById("btn-set-dark").onclick = (e) => switchThemeAnimated("dark", e);

// Subtle monochrome pointer spotlight across interactive surfaces
if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
  document.addEventListener(
    "pointermove",
    (e) => {
      const target = e.target?.closest?.(".card, .provider-card, .sheet-item, .model-row, .diff-file-row, .todo-item");
      if (!target) return;
      const r = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${e.clientX - r.left}px`);
      target.style.setProperty("--my", `${e.clientY - r.top}px`);
    },
    { passive: true }
  );
}

const toggleWide = () => document.getElementById("device-shell").classList.toggle("wide");
document.getElementById("btn-width-toggle").onclick = toggleWide;
document.getElementById("btn-settings-width").onclick = toggleWide;

document.getElementById("btn-open-switcher").onclick = openSwitcherSheet;
document.getElementById("btn-close-switcher").onclick = closeSwitcherSheet;
document.getElementById("switcher-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "switcher-backdrop") closeSwitcherSheet();
});

document.getElementById("btn-pick-mode").onclick = openModePicker;
document.getElementById("btn-pick-perm").onclick = openPermissionPicker;
document.getElementById("btn-close-picker").onclick = closePickerSheet;
document.getElementById("picker-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "picker-backdrop") closePickerSheet();
});

document.getElementById("btn-pick-model").onclick = openModelSheet;
document.getElementById("btn-close-model").onclick = closeModelSheet;
document.getElementById("model-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "model-backdrop") closeModelSheet();
});
document.getElementById("model-search-input").addEventListener("input", (e) => {
  renderModelPickerBody(e.target.value);
});
document.getElementById("btn-model-manage").onclick = () => {
  closeModelSheet();
  setTab("settings");
  setSettingsSubTab("providers");
};

document.getElementById("btn-sheet-new-session").onclick = async () => {
  const mode = state.activeSession?.mode || state.hostSettings?.defaultMode || "agent";
  const providerId = state.activeSession?.providerId || state.hostSettings?.defaultProviderId || undefined;
  const modelId = state.activeSession?.modelId || state.hostSettings?.defaultModelId || undefined;
  if (!state.activeProject) return;
  const created = await rpcCall(
    "session.create",
    { projectPath: state.activeProject.path, title: "Remote Session", mode, providerId, modelId },
    `c_${randomId(8)}`
  );
  state.sessions.unshift(created);
  closeSwitcherSheet();
  await selectSession(created);
};

document.getElementById("btn-close-approval").onclick = closeApprovalSheet;
document.getElementById("approval-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "approval-backdrop") closeApprovalSheet();
});

document.getElementById("btn-apr-deny").onclick = async () => {
  const item = state.reviewItem;
  if (!item) return;
  const res = await rpcCall("approval.resolve", { approvalId: item.id, sessionId: item.sessionId, decision: "deny", risk: item.risk });
  if (res.resolved) {
    state.pendingItems = state.pendingItems.filter((p) => p.id !== item.id);
    closeApprovalSheet();
    renderInbox();
    updateBadges();
  } else {
    document.getElementById("apr-feedback").textContent = res.message || "需在桌面端确认";
  }
};

document.getElementById("btn-apr-allow").onclick = async () => {
  const item = state.reviewItem;
  if (!item) return;
  if (item.risk === "high" && !state.reviewStepConfirmed) {
    state.reviewStepConfirmed = true;
    document.getElementById("btn-apr-allow").textContent = "再次点击：确认单次允许";
    document.getElementById("apr-feedback").textContent = "高风险二次确认：已核对上方真实参数";
    return;
  }
  const res = await rpcCall("approval.resolve", { approvalId: item.id, sessionId: item.sessionId, decision: "allow", risk: item.risk, scope: "once" });
  if (res.resolved) {
    state.pendingItems = state.pendingItems.filter((p) => p.id !== item.id);
    closeApprovalSheet();
    renderInbox();
    updateBadges();
    showToast("主机已确认放行");
  } else {
    document.getElementById("apr-feedback").textContent = res.message || "需在桌面端确认";
  }
};

document.getElementById("btn-abort").onclick = async () => {
  if (!state.activeSession) return;
  await rpcCall("turn.abort", { sessionId: state.activeSession.id });
  state.isRunning = false;
  updateHeader();
  showToast("已发送停止指令");
};

const composerInput = document.getElementById("composer-input");
composerInput.addEventListener("input", () => {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(104, composerInput.scrollHeight)}px`;
});

const sendPrompt = async () => {
  const text = composerInput.value.trim();
  if (!text || !state.activeSession) return;
  composerInput.value = "";
  composerInput.style.height = "auto";
  state.messages.push({ id: `local_${Date.now()}`, role: "user", content: text });
  renderChatTimeline();


  state.isRunning = true;
  updateHeader();
  try {
    await rpcCall("turn.start", { sessionId: state.activeSession.id, content: text }, `t_${randomId(8)}`);
  } catch (err) {
    state.isRunning = false;
    updateHeader();
    showToast(err.message || "发送失败");
  }
};

document.getElementById("btn-send").onclick = sendPrompt;
composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

document.getElementById("btn-pair-submit").onclick = startPairing;

document.getElementById("btn-refresh-tasks").onclick = () =>
  refreshTasks().then(() => showToast("已刷新待办与后台任务"));
document.getElementById("btn-refresh-inbox").onclick = () =>
  refreshPending().then(() => showToast("已刷新待审批"));
document.getElementById("btn-refresh-diff").onclick = () =>
  refreshDiff().then(() => showToast("已刷新 Git 变更"));
document.getElementById("btn-refresh-providers").onclick = () =>
  refreshProvidersAndSettings(true).then(() => showToast("已刷新供应商与模型目录"));
document.getElementById("btn-diff-wrap").onclick = () => {
  state.diffWrap = !state.diffWrap;
  document.getElementById("btn-diff-wrap").textContent = state.diffWrap ? "横向滚动" : "自动换行";
  renderDiff();
};

// Boot
applyTheme(state.theme);
renderHosts();
renderProvidersSettings();
renderTasksTab();
renderInbox();
renderDiff();
renderChatTimeline();
updateHeader();
updateBadges();
if (state.hosts.length > 0) {
  setTab("settings");
  setSettingsSubTab("hosts");
}
