import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Haptics from "expo-haptics";
import type {
  BackgroundTaskItem,
  ChatMessage,
  DiffFilePatch,
  DiffFileSummary,
  HostInfo,
  PairingInvite,
  PendingApprovalItem,
  PermissionMode,
  ProjectEntry,
  ProviderSummary,
  RemoteEvent,
  ScheduledTaskItem,
  SessionMode,
  SessionSummary,
  ThinkingLevel,
  TodoItem,
} from "@pi-remote/protocol";
import {
  PiRemoteClient,
  type ConnectionState,
  type HostSettingsSummary,
  type PairedHostRecord,
} from "./src/lib/remoteClient";
import {
  loadPairedHosts,
  loadThemePreference,
  removePairedHost,
  savePairedHost,
  saveThemePreference,
} from "./src/lib/secureVault";
import {
  getPalette,
  MODE_LABELS,
  PERM_LABELS,
  PERMISSION_MODES,
  SESSION_MODES,
  THINKING_LEVELS,
  type ThemeMode,
} from "./src/theme";
import { ChatScreen } from "./src/screens/ChatScreen";
import { TasksScreen } from "./src/screens/TasksScreen";
import { DiffScreen } from "./src/screens/DiffScreen";
import { InboxScreen } from "./src/screens/InboxScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { BottomSheet } from "./src/components/BottomSheet";
import { ApprovalReviewModal } from "./src/components/ApprovalReviewModal";
import { QrScannerModal } from "./src/components/QrScannerModal";

type TabName = "chat" | "tasks" | "diff" | "inbox" | "settings";
const TAB_ORDER: TabName[] = ["chat", "tasks", "diff", "inbox", "settings"];

const DEFAULT_SETTINGS: HostSettingsSummary = {
  defaultMode: "agent",
  defaultPermissionMode: "ask",
  defaultProviderId: "",
  defaultModelId: "",
  defaultThinkingLevel: "high",
};

const DEMO_PATCH: DiffFilePatch = {
  path: "apps/pi-plugin/src/host-adapter.mjs",
  status: "M",
  truncated: false,
  binary: false,
  hunks: [
    {
      header: "@@ -628,6 +628,10 @@ export class PiHostAdapter",
      lines: [
        { type: "context", oldLine: 628, newLine: 628, text: "  async configureSession({ sessionId, mode, permissionMode, providerId, modelId }) {" },
        { type: "add", oldLine: null, newLine: 629, text: "    const res = await this._desktopInvoke(\"session/configure\", [sessionId, config], {" },
        { type: "add", oldLine: null, newLine: 630, text: "      confirm: true, preferMcp: true," },
        { type: "add", oldLine: null, newLine: 631, text: "    });" },
        { type: "context", oldLine: 632, newLine: 632, text: "    return { applied: true, session: res?.session };" },
      ],
    },
  ],
};

function MainConsole() {
  const [tab, setTab] = useState<TabName>("chat");
  const [settingsSubKey, setSettingsSubKey] = useState<{ sub: "providers" | "hosts" | "general"; nonce: number }>({
    sub: "providers",
    nonce: 0,
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [demoMode, setDemoMode] = useState(false);
  const [hosts, setHosts] = useState<PairedHostRecord[]>([]);
  const [activeHostId, setActiveHostId] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnectionState>("offline");
  const [connDetail, setConnDetail] = useState("");
  const [sasPrompt, setSasPrompt] = useState<{ code: string; hostName: string } | null>(null);

  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [hostSettings, setHostSettings] = useState<HostSettingsSummary>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectEntry | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [streamingThinking, setStreamingThinking] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskItem[]>([]);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskItem[]>([]);

  const [pendingItems, setPendingItems] = useState<PendingApprovalItem[]>([]);
  const [reviewItem, setReviewItem] = useState<PendingApprovalItem | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalFeedback, setApprovalFeedback] = useState<string | null>(null);

  const [diffBranch, setDiffBranch] = useState("");
  const [diffFiles, setDiffFiles] = useState<DiffFileSummary[]>([]);
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const [activePatch, setActivePatch] = useState<DiffFilePatch | null>(null);
  const [loadingDiffFile, setLoadingDiffFile] = useState<string | null>(null);

  // Bottom sheets & modals
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const [permSheetOpen, setPermSheetOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [qrOpen, setQrOpen] = useState(false);

  const tabIndicatorX = useRef(new Animated.Value(0)).current;
  const activeSessionRef = useRef<SessionSummary | null>(null);
  activeSessionRef.current = activeSession;

  const palette = getPalette(themeMode);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 2600);
  };

  const switchTab = (next: TabName, openSettingsSub?: "providers" | "hosts" | "general") => {
    Haptics.selectionAsync().catch(() => {});
    setTab(next);
    if (next === "settings" && openSettingsSub) {
      setSettingsSubKey((prev) => ({ sub: openSettingsSub, nonce: prev.nonce + 1 }));
    }
    const idx = TAB_ORDER.indexOf(next);
    const tabWidth = Dimensions.get("window").width / TAB_ORDER.length;
    Animated.spring(tabIndicatorX, {
      toValue: idx * tabWidth,
      damping: 20,
      stiffness: 260,
      useNativeDriver: true,
    }).start();

    if (!demoMode && (connState === "online_direct" || connState === "online_relay")) {
      if (next === "diff" && activeProject) refreshDiff(activeProject.path).catch(() => {});
      if (next === "inbox") refreshPending().catch(() => {});
      if (next === "tasks") refreshTasks(activeSession?.id).catch(() => {});
      if (next === "settings" && providers.length === 0) refreshProviders(false).catch(() => {});
    }
  };

  const clientRef = useRef<PiRemoteClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new PiRemoteClient({
      onStateChange: (st, detail) => {
        setConnState(st);
        setConnDetail(detail || "");
        if (st.startsWith("online")) setSasPrompt(null);
      },
      onSasReady: (code, hostName) => setSasPrompt({ code, hostName }),
      onPaired: (record) => {
        setActiveHostId(record.hostId);
        savePairedHost(record)
          .then((list) => setHosts(list))
          .catch(() => setHosts((prev) => [record, ...prev.filter((h) => h.hostId !== record.hostId)]));
      },
      onEvent: (evt: RemoteEvent) => {
        const curSess = activeSessionRef.current;
        if (evt.event === "pending.updated") {
          const items = (evt.payload as { items?: PendingApprovalItem[] })?.items;
          if (Array.isArray(items)) setPendingItems(items);
          return;
        }
        if (!curSess || evt.payload?.sessionId !== curSess.id) return;

        if (evt.event === "session.configured" && evt.payload?.session) {
          const patch = evt.payload.session as SessionSummary;
          setActiveSession((prev) => (prev ? { ...prev, ...patch } : prev));
          setSessions((prev) => prev.map((s) => (s.id === curSess.id ? { ...s, ...patch } : s)));
          return;
        }
        if (evt.event === "todos.updated" && Array.isArray(evt.payload?.todos)) {
          setTodos(evt.payload.todos as TodoItem[]);
          return;
        }
        if (evt.event === "tasks.updated" && Array.isArray(evt.payload?.backgroundTasks)) {
          setBackgroundTasks(evt.payload.backgroundTasks as BackgroundTaskItem[]);
          return;
        }
        if (evt.event === "stream.delta") {
          const delta = String(evt.payload.delta || "");
          if (evt.payload.channel === "thinking") setStreamingThinking((p) => p + delta);
          else setStreamingText((p) => p + delta);
          setIsRunning(true);
          return;
        }
        if (evt.event === "message.final") {
          const msg = evt.payload.message as ChatMessage;
          setStreamingText("");
          setStreamingThinking("");
          if (msg && msg.content) {
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          }
          return;
        }
        if (evt.event === "turn.state") {
          const running = evt.payload.status === "running";
          setIsRunning(running);
          if (!running) {
            setStreamingText("");
            setStreamingThinking("");
          }
        }
      },
    });
  }

  useEffect(() => {
    Promise.all([loadPairedHosts(), loadThemePreference()]).then(([savedHosts, savedTheme]) => {
      setHosts(savedHosts);
      setThemeMode(savedTheme);
    });
    return () => {
      clientRef.current?.disconnect();
    };
  }, []);

  const handleChangeTheme = (next: ThemeMode) => {
    setThemeMode(next);
    saveThemePreference(next).catch(() => {});
  };

  const refreshProviders = async (refreshCatalog = false) => {
    if (demoMode) return;
    const client = clientRef.current!;
    const [provRes, setRes] = await Promise.all([
      (refreshCatalog ? client.refreshModelCatalog() : client.listProviders()).catch(() => ({ providers: [] })),
      client.getHostSettings().catch(() => null),
    ]);
    setProviders(provRes.providers || []);
    if (setRes) setHostSettings(setRes);
  };

  const refreshPending = async () => {
    if (demoMode) return;
    const res = await clientRef.current!.listPending().catch(() => ({ items: [] as PendingApprovalItem[] }));
    setPendingItems(res.items || []);
  };

  const refreshTasks = async (sessionId?: string) => {
    if (demoMode) return;
    const res = await clientRef.current!.listTasks(sessionId).catch(() => null);
    if (!res) return;
    setTodos(res.todos || []);
    setBackgroundTasks(res.backgroundTasks || []);
    setScheduledTasks(res.scheduledTasks || []);
  };

  const refreshDiff = async (projectPath: string) => {
    if (demoMode) return;
    const res = await clientRef.current!
      .getDiffSummary(projectPath)
      .catch(() => ({ isRepo: false, branch: "", files: [] as DiffFileSummary[] }));
    setDiffBranch(res.branch || "");
    setDiffFiles(res.files || []);
    if (res.files.length > 0 && !selectedDiffPath) {
      await handleSelectDiffFile(res.files[0].path, projectPath);
    }
  };

  const handleSelectDiffFile = async (filePath: string, overrideProjPath?: string) => {
    setSelectedDiffPath(filePath);
    if (demoMode) {
      setActivePatch(DEMO_PATCH);
      return;
    }
    const pPath = overrideProjPath || activeProject?.path;
    if (!pPath) return;
    setLoadingDiffFile(filePath);
    try {
      const patch = await clientRef.current!.getDiffFile(pPath, filePath);
      setActivePatch(patch);
    } finally {
      setLoadingDiffFile(null);
    }
  };

  const selectSession = async (s: SessionSummary) => {
    if (demoMode) {
      setActiveSession(s);
      return;
    }
    const detail = await clientRef.current!.getSession(s.id);
    setActiveSession(detail.session);
    setMessages(detail.messages || []);
    setTodos(detail.todos || []);
    setBackgroundTasks(detail.backgroundTasks || []);
    setStreamingText("");
    setStreamingThinking("");
    setIsRunning(detail.session.status === "running");
    refreshTasks(s.id).catch(() => {});
  };

  const hydrateHost = async () => {
    setDemoMode(false);
    const client = clientRef.current!;
    const info = await client.getHostInfo();
    setHostInfo(info);
    const proj = info.projects.find((p) => p.active) || info.projects[0] || null;
    setActiveProject(proj);

    const [sessRes] = await Promise.all([
      client.listSessions(proj?.path),
      refreshProviders(false),
      refreshPending(),
      proj ? refreshDiff(proj.path) : Promise.resolve(),
    ]);
    const list = sessRes.sessions || [];
    setSessions(list);
    if (list.length > 0) {
      await selectSession(list[0]);
    } else {
      setActiveSession(null);
      setMessages([]);
      await refreshTasks();
    }
    switchTab("chat");
  };

  const handlePairInvite = async (invite: PairingInvite) => {
    try {
      await clientRef.current!.pairWithInvite(invite, "PI Remote Android");
      await hydrateHost();
      showToast("E2EE 配对成功");
    } catch (e: unknown) {
      setSasPrompt(null);
      const msg = e instanceof Error ? e.message : "配对失败";
      setConnDetail(msg);
      showToast(msg);
    }
  };

  const handleConnectHost = async (record: PairedHostRecord) => {
    try {
      showToast(`正在连接 ${record.hostName}...`);
      setActiveHostId(record.hostId);
      await clientRef.current!.connectPairedHost(record);
      await hydrateHost();
      showToast("已建立 E2EE 加密连接");
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : "连接失败");
    }
  };

  const handleRemoveHost = async (hostId: string) => {
    if (activeHostId === hostId) {
      clientRef.current?.disconnect();
      setActiveHostId(null);
    }
    const next = await removePairedHost(hostId);
    setHosts(next);
    showToast("已移除该主机");
  };

  const configureActiveSession = async (patch: {
    mode?: SessionMode;
    permissionMode?: PermissionMode;
    providerId?: string;
    modelId?: string;
    thinkingLevel?: ThinkingLevel;
  }) => {
    if (!activeSession) {
      showToast("请先选择一个会话");
      return;
    }
    Haptics.selectionAsync().catch(() => {});
    if (demoMode) {
      const updated: SessionSummary = {
        ...activeSession,
        ...patch,
        model: patch.modelId || activeSession.model,
      };
      setActiveSession(updated);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      showToast("已切换演示会话配置");
      return;
    }
    try {
      const res = await clientRef.current!.configureSession({
        sessionId: activeSession.id,
        mode: patch.mode ?? activeSession.mode ?? "agent",
        ...patch,
      });
      if (res.applied) {
        const updated: SessionSummary = {
          ...activeSession,
          ...patch,
          ...(res.session || {}),
          model: res.session?.modelId || patch.modelId || activeSession.model,
        };
        setActiveSession(updated);
        setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        showToast("已同步至 PI-Desktop");
      } else {
        showToast(res.message || "请在桌面端弹窗中确认配置变更");
      }
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : "切换失败");
    }
  };

  const handleCreateSession = async () => {
    const mode = activeSession?.mode || hostSettings.defaultMode || "agent";
    const providerId = activeSession?.providerId || hostSettings.defaultProviderId || undefined;
    const modelId = activeSession?.modelId || hostSettings.defaultModelId || undefined;
    if (demoMode && activeProject) {
      const created: SessionSummary = {
        id: `demo_${Date.now()}`,
        title: "新建演示会话",
        projectPath: activeProject.path,
        status: "idle",
        updatedAt: new Date().toISOString(),
        mode,
        permissionMode: hostSettings.defaultPermissionMode,
        providerId,
        modelId,
        model: modelId || "gpt-5.4",
      };
      setSessions((prev) => [created, ...prev]);
      setActiveSession(created);
      setMessages([]);
      setTodos([]);
      setSwitcherOpen(false);
      return;
    }
    if (!activeProject) return;
    const created = await clientRef.current!.createSession(activeProject.path, "Remote Session", {
      mode,
      providerId,
      modelId,
    });
    setSessions((prev) => [created, ...prev]);
    setSwitcherOpen(false);
    await selectSession(created);
  };

  const handleSendPrompt = async (text: string) => {
    if (!activeSession) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setMessages((prev) => [
      ...prev,
      { id: `local_${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() },
    ]);

    if (demoMode) {
      setIsRunning(true);
      const reply = `收到指令：「${text}」\n\n当前配置：**${MODE_LABELS[activeSession.mode || "agent"]}模式** · **${
        PERM_LABELS[
          !activeSession.permissionMode || activeSession.permissionMode === "inherit"
            ? hostSettings.defaultPermissionMode
            : activeSession.permissionMode
        ]
      }** · ${activeSession.modelId || "gpt-5.4"}。`;
      let i = 0;
      const tm = setInterval(() => {
        i += 8;
        setStreamingText(reply.slice(0, i));
        if (i >= reply.length) {
          clearInterval(tm);
          setStreamingText("");
          setMessages((prev) => [
            ...prev,
            { id: `demo_a_${Date.now()}`, role: "assistant", content: reply, createdAt: new Date().toISOString() },
          ]);
          setIsRunning(false);
        }
      }, 35);
      return;
    }

    setIsRunning(true);
    try {
      await clientRef.current!.startTurn(activeSession.id, text);
    } catch (e: unknown) {
      setIsRunning(false);
      showToast(e instanceof Error ? e.message : "发送失败");
    }
  };

  const handleAbort = async () => {
    if (!activeSession) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    if (demoMode) {
      setIsRunning(false);
      setStreamingText("");
      showToast("已停止演示回合");
      return;
    }
    await clientRef.current!.abortTurn(activeSession.id, activeSession.activeTurnId);
    setIsRunning(false);
    showToast("已发送停止指令");
  };

  const handleApprovalDecision = async (
    item: PendingApprovalItem,
    decision: "allow" | "deny",
    scope: "once" | "session"
  ) => {
    if (demoMode) {
      setPendingItems((prev) => prev.filter((p) => p.id !== item.id));
      setReviewItem(null);
      showToast(decision === "allow" ? "已单次放行" : "已拒绝操作");
      return;
    }
    setApprovalSubmitting(true);
    setApprovalFeedback(null);
    try {
      const res = await clientRef.current!.resolveApproval(item, decision, scope);
      if (res.resolved) {
        setPendingItems((prev) => prev.filter((p) => p.id !== item.id));
        setReviewItem(null);
        showToast("主机已确认执行结果");
      } else {
        setApprovalFeedback(res.message || "请在桌面端 PI-Desktop 窗口完成确认");
      }
    } catch (e: unknown) {
      setApprovalFeedback(e instanceof Error ? e.message : "操作失败");
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const enterDemoMode = () => {
    setDemoMode(true);
    const demoProjects: ProjectEntry[] = [
      { path: "D:/work/pi app", name: "pi-remote-app", active: true },
      { path: "D:/work/edge-relay", name: "edge-relay", active: false },
    ];
    setHostInfo({
      hostId: "host_codex_demo",
      hostName: "Workstation-Win11",
      pluginVersion: "0.1.5",
      capabilityMode: "mcp-full",
      epoch: "demo",
      currentSeq: 1,
      projects: demoProjects,
    });
    setHostSettings({
      defaultMode: "agent",
      defaultPermissionMode: "accept-edits",
      defaultProviderId: "openai",
      defaultModelId: "gpt-5.4",
      defaultThinkingLevel: "high",
    });
    setProviders([
      {
        id: "openai",
        name: "OpenAI Codex",
        apiStyle: "responses",
        baseUrl: "https://api.openai.com/v1",
        enabled: true,
        hasApiKey: true,
        defaultModelId: "gpt-5.4",
        models: [
          { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, reasoning: true, vision: true },
          { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 272000, reasoning: true, vision: true },
        ],
      },
      {
        id: "anthropic",
        name: "Anthropic",
        apiStyle: "messages",
        baseUrl: "https://api.anthropic.com",
        enabled: true,
        hasApiKey: true,
        defaultModelId: "claude-sonnet-4",
        models: [
          { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200000, reasoning: true, vision: true },
          { id: "claude-opus-4", name: "Claude Opus 4", contextWindow: 200000, reasoning: true, vision: true },
        ],
      },
    ]);
    setActiveProject(demoProjects[0]);
    const demoSessions: SessionSummary[] = [
      {
        id: "demo_s1",
        title: "重构远程控端与原生 APK",
        projectPath: demoProjects[0].path,
        status: "idle",
        updatedAt: new Date().toISOString(),
        mode: "agent",
        permissionMode: "accept-edits",
        providerId: "openai",
        modelId: "gpt-5.4",
        model: "gpt-5.4",
        thinkingLevel: "high",
      },
      {
        id: "demo_s2",
        title: "规划盲中继灰度方案",
        projectPath: demoProjects[0].path,
        status: "idle",
        updatedAt: new Date().toISOString(),
        mode: "plan",
        permissionMode: "ask",
        providerId: "anthropic",
        modelId: "claude-sonnet-4",
        model: "claude-sonnet-4",
        thinkingLevel: "medium",
      },
    ];
    setSessions(demoSessions);
    setActiveSession(demoSessions[0]);
    setMessages([
      {
        id: "dm_1",
        role: "user",
        content: "接入智能体/目标/规划三模式、权限切换、供应商模型与真实待办后台任务。",
        createdAt: new Date().toISOString(),
      },
      {
        id: "dm_t1",
        role: "tool",
        content: "",
        toolName: "Bash",
        toolStatus: "success",
        toolArgsPreview: "{\"command\":\"npm test\"}",
        isProcessStep: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: "dm_2",
        role: "assistant",
        thinking: "所有端到端加密与单元测试通过，整理简洁结论。",
        content:
          "已同步为 Codex 极简单色原生应用，底部可直接切换模式（智能体 / 目标 / 规划）、权限（每次询问 / 允许编辑 / 全自动）和按供应商分组的模型。\n\n```ts\nawait client.configureSession({\n  sessionId,\n  mode: \"plan\",\n  permissionMode: \"accept-edits\",\n  modelId: \"gpt-5.4\",\n});\n```",
        createdAt: new Date().toISOString(),
      },
    ]);
    setTodos([
      { content: "同步 Hermes 纯 JS 密码学适配层与 SecureStore 持久化", status: "completed", priority: "high" },
      { content: "重写 Codex 极简单色原生 UI 五大页签", status: "in_progress", priority: "high" },
      { content: "通过云端工作流打包签名 Android Release APK", status: "pending", priority: "high" },
    ]);
    setBackgroundTasks([
      {
        id: "cf_relay_live",
        kind: "bash",
        title: "Cloudflare Workers 公益盲中继",
        command: "wss://relay.example.com/ws",
        state: "running",
        outputPreview: "pi-relay.v1 online (zero-knowledge DO hibernation)",
      },
    ]);
    setScheduledTasks([
      {
        id: "sched_1",
        title: "每日协议与插件体检",
        cadence: "每天 02:00",
        enabled: true,
        nextRunAt: "明天 02:00",
        lastStatus: "success",
      },
    ]);
    setPendingItems([
      {
        id: "demo_p1",
        kind: "permission",
        sessionId: "demo_s1",
        sessionTitle: "重构远程控端与原生 APK",
        risk: "high",
        title: "Bash · 构建盲中继镜像",
        summary: "Agent 请求运行工作区构建命令。",
        argsPreview: "{\"command\":\"docker build -t pi-relay apps/relay/go\"}",
        requiresDesktopConfirm: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    setDiffBranch("main");
    setDiffFiles([{ path: "apps/pi-plugin/src/host-adapter.mjs", status: "M", additions: 3, deletions: 0, staged: false }]);
    setSelectedDiffPath("apps/pi-plugin/src/host-adapter.mjs");
    setActivePatch(DEMO_PATCH);
    switchTab("chat");
    showToast("已进入 Codex 交互演示");
  };

  const exitDemoMode = () => {
    setDemoMode(false);
    setHostInfo(null);
    setActiveProject(null);
    setActiveSession(null);
    setSessions([]);
    setMessages([]);
    setTodos([]);
    setBackgroundTasks([]);
    setScheduledTasks([]);
    setProviders([]);
    setPendingItems([]);
    setDiffFiles([]);
    setActivePatch(null);
    switchTab("settings", "hosts");
  };

  const isOnline = demoMode || connState === "online_direct" || connState === "online_relay";
  const activeTaskCount =
    todos.filter((t) => t.status === "pending" || t.status === "in_progress").length +
    backgroundTasks.filter((t) => t.state === "running").length;

  const tabWidth = Dimensions.get("window").width / TAB_ORDER.length;

  const filteredProviders = providers
    .filter((p) => p.enabled)
    .map((p) => {
      const q = modelQuery.trim().toLowerCase();
      const models = (p.models || []).filter(
        (m) => !q || m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      );
      return { ...p, models };
    })
    .filter((p) => p.models.length > 0);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: palette.bg }]} edges={["top", "bottom"]}>
      <StatusBar style={themeMode === "dark" ? "light" : "dark"} backgroundColor={palette.bg} />

      {/* Top Codex Header */}
      <View style={[styles.topHeader, { backgroundColor: palette.surface, borderBottomColor: palette.border }]}>
        <TouchableOpacity style={styles.sessionTrigger} onPress={() => setSwitcherOpen(true)}>
          <View
            style={[
              styles.statusDot,
              {
                backgroundColor: isRunning
                  ? palette.text
                  : isOnline
                  ? palette.ok
                  : pendingItems.length > 0
                  ? palette.warn
                  : palette.textTertiary,
              },
            ]}
          />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[styles.headerTitle, { color: palette.text }]}>
              {activeSession?.title || hostInfo?.hostName || "PI Remote"}
            </Text>
            <Text numberOfLines={1} style={[styles.headerSub, { color: palette.textTertiary }]}>
              {activeSession
                ? `${hostInfo?.hostName || "主机"} · ${activeProject?.name || "工作区"} · ${
                    demoMode ? "演示" : connState === "online_relay" ? "盲中继 E2EE" : "直连 E2EE"
                  }`
                : hosts.length > 0
                ? `已保存 ${hosts.length} 台主机 · 前往设置连接`
                : "未连接 · 前往设置扫码配对"}
            </Text>
          </View>
          <Text style={{ color: palette.textTertiary, fontSize: 12 }}>▾</Text>
        </TouchableOpacity>

        <View style={styles.headerActions}>
          {isRunning ? (
            <TouchableOpacity style={[styles.abortPill, { backgroundColor: palette.accent }]} onPress={handleAbort}>
              <Text style={{ color: palette.accentFg, fontSize: 11.5, fontWeight: "700" }}>■ 停止</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[styles.iconBtn, { backgroundColor: palette.surface, borderColor: palette.border }]}
            onPress={() => handleChangeTheme(themeMode === "dark" ? "light" : "dark")}
          >
            <Text style={{ color: palette.text, fontSize: 14 }}>{themeMode === "dark" ? "☀" : "☾"}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main Content */}
      <View style={styles.main}>
        {tab === "chat" ? (
          <ChatScreen
            palette={palette}
            demoMode={demoMode}
            hasHosts={hosts.length > 0}
            session={activeSession}
            defaultPermissionMode={hostSettings.defaultPermissionMode}
            defaultModelId={hostSettings.defaultModelId}
            defaultThinkingLevel={hostSettings.defaultThinkingLevel}
            messages={messages}
            streamingText={streamingText}
            streamingThinking={streamingThinking}
            todos={todos}
            backgroundTasks={backgroundTasks}
            sessionPending={activeSession ? pendingItems.filter((p) => p.sessionId === activeSession.id) : []}
            isRunning={isRunning}
            onExitDemo={exitDemoMode}
            onEnterDemo={enterDemoMode}
            onGoPair={() => switchTab("settings", "hosts")}
            onSendPrompt={handleSendPrompt}
            onOpenModePicker={() => setModeSheetOpen(true)}
            onOpenPermPicker={() => {
              if (activeSession?.mode === "goal") {
                showToast("目标模式由合约控制权限，请先切至智能体或规划模式");
                return;
              }
              setPermSheetOpen(true);
            }}
            onOpenModelPicker={() => {
              setModelQuery("");
              setModelSheetOpen(true);
            }}
            onOpenTasksTab={() => switchTab("tasks")}
            onInspectPending={(item) => {
              setApprovalFeedback(null);
              setReviewItem(item);
            }}
          />
        ) : null}

        {tab === "tasks" ? (
          <TasksScreen
            palette={palette}
            todos={todos}
            backgroundTasks={backgroundTasks}
            scheduledTasks={scheduledTasks}
            onRefresh={() => refreshTasks(activeSession?.id).then(() => showToast("已刷新任务"))}
          />
        ) : null}

        {tab === "diff" ? (
          <DiffScreen
            palette={palette}
            branch={diffBranch}
            files={diffFiles}
            selectedPath={selectedDiffPath}
            activePatch={activePatch}
            loadingFile={loadingDiffFile}
            onSelectFile={(p) => handleSelectDiffFile(p)}
            onRefresh={() =>
              activeProject
                ? refreshDiff(activeProject.path).then(() => showToast("已刷新 Git 变更"))
                : showToast("尚未选择工作区")
            }
          />
        ) : null}

        {tab === "inbox" ? (
          <InboxScreen
            palette={palette}
            items={pendingItems}
            onInspect={(item) => {
              setApprovalFeedback(null);
              setReviewItem(item);
            }}
            onRefresh={() => refreshPending().then(() => showToast("已刷新待审批"))}
          />
        ) : null}

        {tab === "settings" ? (
          <SettingsScreen
            key={settingsSubKey.nonce}
            palette={palette}
            themeMode={themeMode}
            initialSub={settingsSubKey.sub}
            hostSettings={hostSettings}
            providers={providers}
            activeSession={activeSession}
            hosts={hosts}
            activeHostId={activeHostId}
            connState={connState}
            connDetail={connDetail}
            sasPrompt={sasPrompt}
            onChangeTheme={handleChangeTheme}
            onRefreshProviders={() => refreshProviders(true).then(() => showToast("已刷新供应商目录"))}
            onSelectModel={(pid, mid) => configureActiveSession({ providerId: pid, modelId: mid })}
            onPairInvite={handlePairInvite}
            onOpenQrScanner={() => setQrOpen(true)}
            onEnterDemo={enterDemoMode}
            onConnectHost={handleConnectHost}
            onRemoveHost={handleRemoveHost}
            onGoChat={() => switchTab("chat")}
          />
        ) : null}

        {toastMsg ? (
          <View pointerEvents="none" style={[styles.toast, { backgroundColor: palette.accent }]}>
            <Text style={{ color: palette.accentFg, fontSize: 12, fontWeight: "700" }}>{toastMsg}</Text>
          </View>
        ) : null}
      </View>

      {/* Bottom 5-Tab Bar with Spring Indicator */}
      <View style={[styles.tabBar, { backgroundColor: palette.surface, borderTopColor: palette.border }]}>
        <Animated.View
          style={[
            styles.tabIndicatorWrap,
            { width: tabWidth, transform: [{ translateX: tabIndicatorX }] },
          ]}
        >
          <View style={[styles.tabIndicatorBar, { backgroundColor: palette.accent }]} />
        </Animated.View>

        {(
          [
            { id: "chat" as const, icon: "◫", label: "会话", badge: 0, danger: false },
            { id: "tasks" as const, icon: "☑", label: "任务", badge: activeTaskCount, danger: false },
            { id: "diff" as const, icon: "⎇", label: "变更", badge: diffFiles.length, danger: false },
            { id: "inbox" as const, icon: "⚑", label: "审批", badge: pendingItems.length, danger: true },
            { id: "settings" as const, icon: "⚙", label: "设置", badge: 0, danger: false },
          ]
        ).map((item) => {
          const active = tab === item.id;
          return (
            <TouchableOpacity key={item.id} style={styles.tabBtn} onPress={() => switchTab(item.id)}>
              <Text style={{ color: active ? palette.text : palette.textTertiary, fontSize: 16 }}>
                {item.icon}
              </Text>
              <Text
                style={{
                  color: active ? palette.text : palette.textTertiary,
                  fontSize: 10.5,
                  fontWeight: active ? "700" : "500",
                }}
              >
                {item.label}
              </Text>
              {item.badge > 0 ? (
                <View
                  style={[
                    styles.tabBadge,
                    { backgroundColor: item.danger ? palette.danger : palette.accent },
                  ]}
                >
                  <Text
                    style={{
                      color: item.danger ? "#FFFFFF" : palette.accentFg,
                      fontSize: 9.5,
                      fontWeight: "800",
                    }}
                  >
                    {item.badge}
                  </Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Sheet 1: Project & Session Switcher */}
      <BottomSheet
        visible={switcherOpen}
        palette={palette}
        title="工作区与会话"
        headerRight={
          activeProject ? (
            <TouchableOpacity
              style={[styles.sheetActionBtn, { backgroundColor: palette.accent }]}
              onPress={handleCreateSession}
            >
              <Text style={{ color: palette.accentFg, fontSize: 12, fontWeight: "700" }}>+ 新建</Text>
            </TouchableOpacity>
          ) : null
        }
        onClose={() => setSwitcherOpen(false)}
      >
        {(hostInfo?.projects || []).length === 0 ? (
          <Text style={{ color: palette.textSecondary, fontSize: 13 }}>
            尚未连接主机，请先前往「设置 → 主机与配对」扫码或连接电脑。
          </Text>
        ) : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7 }}>
              {(hostInfo?.projects || []).map((p) => {
                const active = activeProject?.path === p.path;
                return (
                  <TouchableOpacity
                    key={p.path}
                    style={[
                      styles.projPill,
                      {
                        backgroundColor: active ? palette.accent : palette.surface2,
                        borderColor: active ? palette.accent : palette.border,
                      },
                    ]}
                    onPress={async () => {
                      setActiveProject(p);
                      if (!demoMode) {
                        const res = await clientRef.current!.listSessions(p.path);
                        setSessions(res.sessions || []);
                        refreshDiff(p.path).catch(() => {});
                      }
                    }}
                  >
                    <Text style={{ color: active ? palette.accentFg : palette.textSecondary, fontSize: 12, fontWeight: "600" }}>
                      {p.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={{ gap: 8 }}>
              {sessions.map((s) => {
                const isCur = activeSession?.id === s.id;
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[
                      styles.sheetRow,
                      {
                        backgroundColor: isCur ? palette.surface2 : palette.surface,
                        borderColor: isCur ? palette.text : palette.border,
                      },
                    ]}
                    onPress={async () => {
                      setSwitcherOpen(false);
                      await selectSession(s);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ color: palette.text, fontSize: 13.5, fontWeight: "600" }}>
                        {s.title}
                      </Text>
                      <Text style={{ color: palette.textSecondary, fontSize: 11, marginTop: 2 }}>
                        {MODE_LABELS[s.mode || "agent"]} · {s.modelId || s.model || "默认模型"}
                      </Text>
                    </View>
                    <View style={[styles.chip, { backgroundColor: isCur ? palette.accent : palette.surface2 }]}>
                      <Text style={{ color: isCur ? palette.accentFg : palette.textSecondary, fontSize: 11, fontWeight: "700" }}>
                        {isCur ? "当前" : s.status === "running" ? "运行中" : "打开"}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}
      </BottomSheet>

      {/* Sheet 2: Mode Picker */}
      <BottomSheet
        visible={modeSheetOpen}
        palette={palette}
        title="切换会话模式"
        subtitle="决定 Agent 本回合的协作与规划方式"
        onClose={() => setModeSheetOpen(false)}
      >
        {SESSION_MODES.map((m) => {
          const cur = (activeSession?.mode || "agent") === m.id;
          return (
            <TouchableOpacity
              key={m.id}
              style={[
                styles.sheetRow,
                { backgroundColor: cur ? palette.surface2 : palette.surface, borderColor: cur ? palette.text : palette.border },
              ]}
              onPress={() => {
                setModeSheetOpen(false);
                if (!cur) configureActiveSession({ mode: m.id });
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: palette.text, fontSize: 14, fontWeight: "700" }}>{m.label}</Text>
                <Text style={{ color: palette.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 }}>{m.desc}</Text>
              </View>
              <View style={[styles.chip, { backgroundColor: cur ? palette.accent : palette.surface2 }]}>
                <Text style={{ color: cur ? palette.accentFg : palette.textSecondary, fontSize: 11, fontWeight: "700" }}>
                  {cur ? "已选" : "切换"}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </BottomSheet>

      {/* Sheet 3: Permission Picker */}
      <BottomSheet
        visible={permSheetOpen}
        palette={palette}
        title="切换权限模式"
        subtitle="控制文件编辑与命令执行的确认级别"
        onClose={() => setPermSheetOpen(false)}
      >
        {PERMISSION_MODES.map((p) => {
          const effective =
            !activeSession?.permissionMode || activeSession.permissionMode === "inherit"
              ? hostSettings.defaultPermissionMode
              : activeSession.permissionMode;
          const cur = effective === p.id;
          return (
            <TouchableOpacity
              key={p.id}
              style={[
                styles.sheetRow,
                { backgroundColor: cur ? palette.surface2 : palette.surface, borderColor: cur ? palette.text : palette.border },
              ]}
              onPress={() => {
                setPermSheetOpen(false);
                configureActiveSession({ permissionMode: p.id });
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: palette.text, fontSize: 14, fontWeight: "700" }}>{p.label}</Text>
                <Text style={{ color: palette.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 }}>{p.desc}</Text>
              </View>
              <View
                style={[
                  styles.chip,
                  { backgroundColor: cur ? (p.id === "auto" ? palette.warnSoft : palette.accent) : palette.surface2 },
                ]}
              >
                <Text
                  style={{
                    color: cur ? (p.id === "auto" ? palette.warn : palette.accentFg) : palette.textSecondary,
                    fontSize: 11,
                    fontWeight: "700",
                  }}
                >
                  {cur ? "当前" : "选择"}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </BottomSheet>

      {/* Sheet 4: Model & Thinking Level Picker */}
      <BottomSheet
        visible={modelSheetOpen}
        palette={palette}
        title="选择模型与推理等级"
        subtitle="按 PI-Desktop 已配置的供应商分组"
        tall
        headerRight={
          <TouchableOpacity
            style={[styles.sheetActionBtn, { backgroundColor: palette.surface2, borderColor: palette.border, borderWidth: 1 }]}
            onPress={() => {
              setModelSheetOpen(false);
              switchTab("settings", "providers");
            }}
          >
            <Text style={{ color: palette.text, fontSize: 11.5, fontWeight: "600" }}>管理供应商</Text>
          </TouchableOpacity>
        }
        onClose={() => setModelSheetOpen(false)}
      >
        <TextInput
          style={[
            styles.searchInput,
            { backgroundColor: palette.surface2, borderColor: palette.borderStrong, color: palette.text },
          ]}
          placeholder="搜索模型名称或供应商..."
          placeholderTextColor={palette.textTertiary}
          value={modelQuery}
          onChangeText={setModelQuery}
        />

        <View style={styles.thinkBar}>
          <Text style={{ color: palette.textTertiary, fontSize: 11.5, fontWeight: "700" }}>推理等级</Text>
          <View style={styles.thinkRow}>
            {THINKING_LEVELS.map((lv) => {
              const cur = (activeSession?.thinkingLevel || hostSettings.defaultThinkingLevel || "high") === lv.id;
              return (
                <TouchableOpacity
                  key={lv.id}
                  style={[
                    styles.thinkPill,
                    {
                      backgroundColor: cur ? palette.accent : palette.surface2,
                      borderColor: cur ? palette.accent : palette.border,
                    },
                  ]}
                  onPress={() => configureActiveSession({ thinkingLevel: lv.id })}
                >
                  <Text style={{ color: cur ? palette.accentFg : palette.textSecondary, fontSize: 11.5, fontWeight: "600" }}>
                    {lv.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {filteredProviders.length === 0 ? (
          <Text style={{ color: palette.textSecondary, fontSize: 13, textAlign: "center", paddingVertical: 16 }}>
            {modelQuery ? "没有匹配的模型" : "暂无可用模型，请前往「设置 → 供应商与模型」刷新目录。"}
          </Text>
        ) : (
          filteredProviders.map((p) => (
            <View key={p.id} style={{ gap: 7 }}>
              <View style={styles.groupHead}>
                <Text style={{ color: palette.textTertiary, fontSize: 11.5, fontWeight: "700" }}>
                  {p.name.toUpperCase()}
                </Text>
                <View style={[styles.chip, { backgroundColor: p.hasApiKey ? palette.okSoft : palette.warnSoft }]}>
                  <Text style={{ color: p.hasApiKey ? palette.ok : palette.warn, fontSize: 10.5, fontWeight: "700" }}>
                    {p.hasApiKey ? "已认证" : "未配密钥"}
                  </Text>
                </View>
              </View>
              {p.models.map((m) => {
                const cur =
                  activeSession?.modelId === m.id &&
                  (!activeSession.providerId || activeSession.providerId === p.id);
                const meta = [m.id];
                if (m.contextWindow) meta.push(`${Math.round(m.contextWindow / 1000)}K`);
                if (m.reasoning) meta.push("推理");
                if (m.vision) meta.push("视觉");
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[
                      styles.sheetRow,
                      { backgroundColor: palette.surface, borderColor: cur ? palette.text : palette.border },
                    ]}
                    onPress={() => {
                      setModelSheetOpen(false);
                      configureActiveSession({ providerId: p.id, modelId: m.id });
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: palette.text, fontSize: 13, fontWeight: "700" }}>
                        {m.name || m.id}
                      </Text>
                      <Text style={{ color: palette.textSecondary, fontSize: 11, fontFamily: palette.mono, marginTop: 2 }}>
                        {meta.join(" · ")}
                      </Text>
                    </View>
                    <View style={[styles.chip, { backgroundColor: cur ? palette.accent : palette.surface2 }]}>
                      <Text style={{ color: cur ? palette.accentFg : palette.textSecondary, fontSize: 11, fontWeight: "700" }}>
                        {cur ? "当前" : "选择"}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))
        )}
      </BottomSheet>

      <ApprovalReviewModal
        item={reviewItem}
        palette={palette}
        submitting={approvalSubmitting}
        feedback={approvalFeedback}
        onDecision={handleApprovalDecision}
        onClose={() => setReviewItem(null)}
      />

      <QrScannerModal
        visible={qrOpen}
        palette={palette}
        onClose={() => setQrOpen(false)}
        onScanned={(raw) => {
          setQrOpen(false);
          try {
            const parsed = JSON.parse(raw) as PairingInvite;
            handlePairInvite(parsed);
          } catch {
            showToast("二维码不是有效的 PI-Desktop 配对码");
          }
        }}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainConsole />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: 1,
    gap: 8,
  },
  sessionTrigger: { flex: 1, flexDirection: "row", alignItems: "center", gap: 9 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  headerTitle: { fontSize: 14, fontWeight: "700" },
  headerSub: { fontSize: 11, marginTop: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 7 },
  abortPill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  iconBtn: { width: 32, height: 32, borderRadius: 9, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  main: { flex: 1, position: "relative" },
  toast: {
    position: "absolute",
    top: 12,
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
  },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    paddingTop: 6,
    paddingBottom: 6,
    position: "relative",
  },
  tabIndicatorWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    alignItems: "center",
  },
  tabIndicatorBar: { width: 26, height: 2, borderRadius: 999 },
  tabBtn: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2, position: "relative" },
  tabBadge: {
    position: "absolute",
    top: -1,
    right: "18%",
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetActionBtn: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8 },
  projPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: 12,
    borderRadius: 11,
    borderWidth: 1,
  },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  searchInput: { borderRadius: 9, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8, fontSize: 13 },
  thinkBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" },
  thinkRow: { flexDirection: "row", gap: 5 },
  thinkPill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  groupHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
});
