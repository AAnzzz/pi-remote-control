import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type {
  BackgroundTaskItem,
  ChatMessage,
  PendingApprovalItem,
  SessionSummary,
  TodoItem,
} from "@pi-remote/protocol";
import { MarkdownView } from "../components/MarkdownView";
import { MODE_LABELS, PERM_LABELS, THINK_LABELS, type CodexPalette } from "../theme";
interface Props {
  palette: CodexPalette;
  hasHosts: boolean;
  session: SessionSummary | null;
  defaultPermissionMode: string;
  defaultModelId: string;
  defaultThinkingLevel: string;
  messages: ChatMessage[];
  streamingText: string;
  streamingThinking: string;
  todos: TodoItem[];
  backgroundTasks: BackgroundTaskItem[];
  sessionPending: PendingApprovalItem[];
  isRunning: boolean;
  configuringLabel?: string | null;
  onGoPair: () => void;
  onSendPrompt: (text: string) => void;
  onOpenModePicker: () => void;
  onOpenPermPicker: () => void;
  onOpenModelPicker: () => void;
  onOpenTasksTab: () => void;
  onInspectPending: (item: PendingApprovalItem) => void;
  onPressFilePath?: (filePath: string) => void;
}

type TimelineGroup =
  | { kind: "process"; id: string; steps: ChatMessage[] }
  | { kind: "message"; id: string; msg: ChatMessage };

export function ChatScreen({
  palette,
  hasHosts,
  session,
  defaultPermissionMode,
  defaultModelId,
  defaultThinkingLevel,
  messages,
  streamingText,
  streamingThinking,
  todos,
  backgroundTasks,
  sessionPending,
  isRunning,
  configuringLabel,
  onGoPair,
  onSendPrompt,
  onOpenModePicker,
  onOpenPermPicker,
  onOpenModelPicker,
  onOpenTasksTab,
  onInspectPending,
  onPressFilePath,
}: Props) {
  const [draft, setDraft] = useState("");
  const [dockOpen, setDockOpen] = useState(false);
  const [dockTab, setDockTab] = useState<"todos" | "bg">("todos");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const nearBottomRef = useRef(true);
  const forceScrollBottomRef = useRef(true);
  const lastSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    const sid = session?.id || null;
    if (sid !== lastSessionIdRef.current) {
      lastSessionIdRef.current = sid;
      nearBottomRef.current = true;
      forceScrollBottomRef.current = true;
      setShowScrollDown(false);
    }
  }, [session?.id]);

  useEffect(() => {
    if (forceScrollBottomRef.current || nearBottomRef.current) {
      const timer = setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      }, 40);
      return () => clearTimeout(timer);
    }
  }, [messages.length, session?.id]);

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const dist = contentSize.height - (layoutMeasurement.height + contentOffset.y);
    const near = dist <= 96;
    nearBottomRef.current = near;
    if (!near) forceScrollBottomRef.current = false;
    setShowScrollDown(!near && contentSize.height > layoutMeasurement.height + 140);
  };

  const scrollToLatest = (animated = true) => {
    nearBottomRef.current = true;
    forceScrollBottomRef.current = false;
    setShowScrollDown(false);
    scrollRef.current?.scrollToEnd({ animated });
  };
  const grouped = useMemo<TimelineGroup[]>(() => {
    const out: TimelineGroup[] = [];
    let procBuf: ChatMessage[] = [];
    const flush = () => {
      if (procBuf.length > 0) {
        out.push({ kind: "process", id: `proc_${procBuf[0].id}`, steps: procBuf });
        procBuf = [];
      }
    };
    for (const m of messages) {
      if (m.role === "tool" || m.isProcessStep) {
        procBuf.push(m);
      } else {
        flush();
        out.push({ kind: "message", id: m.id, msg: m });
      }
    }
    flush();
    return out;
  }, [messages]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSend = () => {
    const text = draft.trim();
    if (!text || !session) return;
    setDraft("");
    nearBottomRef.current = true;
    onSendPrompt(text);
    setTimeout(() => scrollToLatest(true), 80);
  };

  const mode = session?.mode || "agent";
  const effectivePerm =
    !session?.permissionMode || session.permissionMode === "inherit"
      ? defaultPermissionMode || "ask"
      : session.permissionMode;
  const rawModel = session?.modelId || session?.model || defaultModelId || "默认模型";
  const shortModel = rawModel.includes("/") ? rawModel.split("/").pop() || rawModel : rawModel;
  const think = session?.thinkingLevel || defaultThinkingLevel || "";

  const doneCount = todos.filter((t) => t.status === "completed").length;
  const activeCount = todos.filter((t) => t.status !== "cancelled").length;
  const curTodo = todos.find((t) => t.status === "in_progress");
  const runningBg = backgroundTasks.filter((t) => t.state === "running").length;
  const showDock = Boolean(session && (todos.length > 0 || backgroundTasks.length > 0));

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      {showDock ? (
        <View
          style={[
            styles.dockWrap,
            { backgroundColor: palette.surface2, borderBottomColor: palette.border },
          ]}
        >
          <TouchableOpacity style={styles.dockHead} onPress={() => setDockOpen((v) => !v)}>
            <Text numberOfLines={1} style={[styles.dockSummary, { color: palette.text }]}>
              {todos.length > 0
                ? curTodo
                  ? `◐ ${curTodo.content}`
                  : `✓ 待办 ${doneCount}/${activeCount}`
                : `后台任务 ${backgroundTasks.length}`}
              {todos.length > 0 && backgroundTasks.length > 0 ? ` · 后台 ${backgroundTasks.length}` : ""}
            </Text>
            <View style={styles.dockRight}>
              {runningBg > 0 ? (
                <View style={[styles.chip, { backgroundColor: palette.okSoft }]}>
                  <Text style={{ color: palette.ok, fontSize: 10.5, fontWeight: "700" }}>{runningBg} 运行中</Text>
                </View>
              ) : todos.length > 0 ? (
                <View style={[styles.chip, { backgroundColor: palette.surface3 }]}>
                  <Text style={{ color: palette.textSecondary, fontSize: 10.5, fontWeight: "700" }}>
                    {doneCount}/{activeCount}
                  </Text>
                </View>
              ) : null}
              <Text style={{ color: palette.textSecondary, fontSize: 12 }}>{dockOpen ? "▴" : "▾"}</Text>
            </View>
          </TouchableOpacity>

          {dockOpen ? (
            <View style={[styles.dockBody, { borderTopColor: palette.border }]}>
              <View style={styles.dockSubRow}>
                <View style={[styles.miniSeg, { backgroundColor: palette.surface3 }]}>
                  <TouchableOpacity
                    style={[styles.miniSegBtn, dockTab === "todos" ? { backgroundColor: palette.surface } : undefined]}
                    onPress={() => setDockTab("todos")}
                  >
                    <Text style={{ color: dockTab === "todos" ? palette.text : palette.textSecondary, fontSize: 11, fontWeight: "600" }}>
                      待办 ({todos.length})
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.miniSegBtn, dockTab === "bg" ? { backgroundColor: palette.surface } : undefined]}
                    onPress={() => setDockTab("bg")}
                  >
                    <Text style={{ color: dockTab === "bg" ? palette.text : palette.textSecondary, fontSize: 11, fontWeight: "600" }}>
                      后台 ({backgroundTasks.length})
                    </Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity onPress={onOpenTasksTab}>
                  <Text style={{ color: palette.textSecondary, fontSize: 11.5, fontWeight: "600" }}>查看全部 ›</Text>
                </TouchableOpacity>
              </View>

              {dockTab === "todos" ? (
                <View style={{ gap: 5 }}>
                  {todos.slice(0, 4).map((t, i) => (
                    <Text
                      key={i}
                      numberOfLines={1}
                      style={{
                        fontSize: 12,
                        color: t.status === "completed" ? palette.textTertiary : palette.text,
                        textDecorationLine: t.status === "completed" ? "line-through" : "none",
                      }}
                    >
                      {t.status === "completed" ? "✓ " : t.status === "in_progress" ? "◐ " : "○ "}
                      {t.content}
                    </Text>
                  ))}
                </View>
              ) : (
                <View style={{ gap: 5 }}>
                  {backgroundTasks.slice(0, 3).map((bt) => (
                    <View key={bt.id} style={styles.between}>
                      <Text numberOfLines={1} style={{ color: palette.text, fontSize: 12, flex: 1 }}>
                        {bt.title}
                      </Text>
                      <Text
                        style={{
                          color: bt.state === "running" ? palette.ok : palette.textTertiary,
                          fontSize: 11,
                          fontWeight: "600",
                        }}
                      >
                        {bt.state === "running" ? "运行中" : bt.state}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ) : null}
        </View>
      ) : null}

      {configuringLabel ? (
        <View
          style={[
            styles.configBanner,
            { backgroundColor: palette.surface2, borderBottomColor: palette.border },
          ]}
        >
          <ActivityIndicator size="small" color={palette.text} />
          <Text numberOfLines={2} style={{ color: palette.text, fontSize: 12, fontWeight: "600", flex: 1 }}>
            {configuringLabel}
          </Text>
        </View>
      ) : null}

      <View style={styles.timelineWrap}>
        <ScrollView
          ref={scrollRef}
          style={styles.timeline}
          contentContainerStyle={styles.timelineContent}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={64}
          onScroll={handleScroll}
          onContentSizeChange={() => {
            if (forceScrollBottomRef.current || (nearBottomRef.current && (isRunning || Boolean(streamingText) || Boolean(streamingThinking)))) {
              scrollRef.current?.scrollToEnd({ animated: false });
              if (forceScrollBottomRef.current && messages.length > 0) {
                setTimeout(() => {
                  scrollRef.current?.scrollToEnd({ animated: false });
                  forceScrollBottomRef.current = false;
                }, 60);
              }
            }
          }}
        >
          {sessionPending.length > 0 ? (
            <TouchableOpacity
              style={[styles.noticeBar, { backgroundColor: palette.warnSoft, borderColor: palette.warn }]}
              onPress={() => onInspectPending(sessionPending[0])}
            >
              <Text style={{ color: palette.warn, fontSize: 12.5, fontWeight: "600", flex: 1 }}>
                当前会话有 {sessionPending.length} 项待审批 / 提问
              </Text>
              <Text style={{ color: palette.warn, fontSize: 12.5, fontWeight: "700" }}>立即审阅 ›</Text>
            </TouchableOpacity>
          ) : null}

        {!session ? (
          <View style={styles.emptyWrap}>
            <View style={[styles.emptyMark, { backgroundColor: palette.surface2, borderColor: palette.border }]}>
              <Text style={{ color: palette.text, fontSize: 20 }}>⌘</Text>
            </View>
            <Text style={[styles.emptyTitle, { color: palette.text }]}>
              {hasHosts ? "连接桌面主机开始工作" : "PI Remote Console"}
            </Text>
            <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
              端到端加密远程控制 PI-Desktop：切换智能体/目标/规划模式、权限策略、模型供应商与实时待办后台任务。
            </Text>
            <View style={styles.emptyActions}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: palette.accent }]}
                onPress={onGoPair}
              >
                <Text style={{ color: palette.accentFg, fontWeight: "700", fontSize: 13 }}>
                  {hasHosts ? "连接已配对主机" : "扫码配对桌面主机"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            {grouped.map((g) => {
              if (g.kind === "process") {
                const open = Boolean(openGroups[g.id]);
                const tools = g.steps.filter((s) => s.role === "tool").length;
                const thinks = g.steps.filter((s) => s.role !== "tool").length;
                const parts: string[] = [];
                if (tools > 0) parts.push(`${tools} 次工具`);
                if (thinks > 0) parts.push(`${thinks} 步思考`);
                return (
                  <View
                    key={g.id}
                    style={[styles.procBox, { backgroundColor: palette.surface2, borderColor: palette.border }]}
                  >
                    <TouchableOpacity style={styles.between} onPress={() => toggleGroup(g.id)}>
                      <Text style={{ color: palette.textSecondary, fontSize: 12, fontWeight: "500" }}>
                        思考与工具执行 · {parts.join(" · ") || `${g.steps.length} 步`}
                      </Text>
                      <Text style={{ color: palette.textTertiary, fontSize: 12 }}>{open ? "▴" : "▾"}</Text>
                    </TouchableOpacity>
                    {open ? (
                      <View style={[styles.procTimeline, { borderLeftColor: palette.borderStrong }]}>
                        {g.steps.map((st) => (
                          <View key={st.id} style={{ gap: 3 }}>
                            {st.role === "tool" ? (
                              <>
                                <Text style={{ color: palette.text, fontFamily: palette.mono, fontSize: 11.5, fontWeight: "600" }}>
                                  {st.toolName || "Tool"} · {st.toolStatus || "done"}
                                </Text>
                                {st.toolArgsPreview ? (
                                  <Text
                                    style={[
                                      styles.procArgs,
                                      { backgroundColor: palette.surface, borderColor: palette.border, color: palette.textSecondary, fontFamily: palette.mono },
                                    ]}
                                  >
                                    {st.toolArgsPreview}
                                  </Text>
                                ) : null}
                              </>
                            ) : (
                              <>
                                {st.content ? (
                                  <Text style={{ color: palette.textSecondary, fontSize: 12 }}>{st.content}</Text>
                                ) : null}
                                {st.thinking ? (
                                  <Text style={{ color: palette.textTertiary, fontSize: 11.5 }}>{st.thinking}</Text>
                                ) : null}
                              </>
                            )}
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                );
              }

              const m = g.msg;
              if (m.role === "user") {
                return (
                  <View key={g.id} style={styles.userRow}>
                    <View style={[styles.userBubble, { backgroundColor: palette.userBubbleBg }]}>
                      <Text selectable style={[styles.userText, { color: palette.userBubbleText }]}>
                        {m.content}
                      </Text>
                    </View>
                  </View>
                );
              }

              const thinkOpen = Boolean(openGroups[`tk_${m.id}`]);
              return (
                <View key={g.id} style={styles.assistantRow}>
                  {m.thinking ? (
                    <View
                      style={[
                        styles.procBox,
                        { backgroundColor: palette.surface2, borderColor: palette.border, marginBottom: 8 },
                      ]}
                    >
                      <TouchableOpacity style={styles.between} onPress={() => toggleGroup(`tk_${m.id}`)}>
                        <Text style={{ color: palette.textSecondary, fontSize: 12 }}>
                          思考过程 · {m.thinking.length} 字
                        </Text>
                        <Text style={{ color: palette.textTertiary, fontSize: 12 }}>{thinkOpen ? "▴" : "▾"}</Text>
                      </TouchableOpacity>
                      {thinkOpen ? (
                        <Text selectable style={{ color: palette.textTertiary, fontSize: 12, marginTop: 6, lineHeight: 18 }}>
                          {m.thinking}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  <MarkdownView
                    content={m.content || ""}
                    palette={palette}
                    onPressFilePath={onPressFilePath}
                  />
                </View>
              );
            })}

            {streamingThinking || streamingText ? (
              <View style={[styles.streamingWrap, { borderLeftColor: palette.text }]}>
                {streamingThinking ? (
                  <Text selectable style={{ color: palette.textTertiary, fontSize: 12, marginBottom: 6, lineHeight: 18 }}>
                    {streamingThinking}
                  </Text>
                ) : null}
                <MarkdownView
                  content={streamingText}
                  palette={palette}
                  streaming
                  onPressFilePath={onPressFilePath}
                />
              </View>
            ) : null}
          </>
        )}
        </ScrollView>

        {showScrollDown && session ? (
          <TouchableOpacity
            style={[
              styles.scrollDownFab,
              {
                backgroundColor: palette.surface,
                borderColor: palette.borderStrong,
              },
            ]}
            activeOpacity={0.85}
            onPress={() => scrollToLatest(true)}
          >
            <Text style={{ color: palette.text, fontSize: 12, fontWeight: "700" }}>↓ 最新</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {session ? (
        <View style={[styles.composerOuter, { backgroundColor: palette.bg }]}>
          <View
            style={[
              styles.composerCard,
              {
                backgroundColor: palette.surface,
                borderColor: isRunning ? palette.text : palette.borderStrong,
              },
            ]}
          >
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.input, { color: palette.text }]}
                placeholder="给 PI-Desktop 下发任务或追问..."
                placeholderTextColor={palette.textTertiary}
                multiline
                value={draft}
                onChangeText={setDraft}
              />
              <TouchableOpacity
                style={[
                  styles.sendBtn,
                  { backgroundColor: palette.accent, opacity: draft.trim() ? 1 : 0.35 },
                ]}
                disabled={!draft.trim()}
                onPress={handleSend}
              >
                <Text style={{ color: palette.accentFg, fontSize: 15, fontWeight: "800" }}>↑</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={[styles.ctrlScroll, { borderTopColor: palette.border }]}
              contentContainerStyle={styles.ctrlRow}
            >
              <TouchableOpacity
                style={[styles.ctrlChip, { backgroundColor: palette.surface2, borderColor: palette.border }]}
                onPress={onOpenModePicker}
              >
                <View style={[styles.ctrlDot, { backgroundColor: palette.text }]} />
                <Text style={[styles.ctrlText, { color: palette.text }]}>{MODE_LABELS[mode] || mode}</Text>
                <Text style={{ color: palette.textTertiary, fontSize: 10 }}>▾</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.ctrlChip,
                  {
                    backgroundColor: effectivePerm === "auto" ? palette.warnSoft : palette.surface2,
                    borderColor: effectivePerm === "auto" ? palette.warn : palette.border,
                    opacity: mode === "goal" ? 0.55 : 1,
                  },
                ]}
                onPress={onOpenPermPicker}
              >
                <Text
                  style={[
                    styles.ctrlText,
                    { color: effectivePerm === "auto" ? palette.warn : palette.text },
                  ]}
                >
                  🛡 {PERM_LABELS[effectivePerm] || effectivePerm}
                </Text>
                <Text style={{ color: palette.textTertiary, fontSize: 10 }}>▾</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.ctrlChip, { backgroundColor: palette.surface2, borderColor: palette.border }]}
                onPress={onOpenModelPicker}
              >
                <Text numberOfLines={1} style={[styles.ctrlText, { color: palette.text, maxWidth: 140 }]}>
                  {shortModel}
                </Text>
                {think && think !== "omit" && THINK_LABELS[think] ? (
                  <View style={[styles.thinkBadge, { backgroundColor: palette.accentSoft }]}>
                    <Text style={{ color: palette.textSecondary, fontSize: 10, fontWeight: "600" }}>
                      {THINK_LABELS[think]}
                    </Text>
                  </View>
                ) : null}
                <Text style={{ color: palette.textTertiary, fontSize: 10 }}>▾</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dockWrap: { borderBottomWidth: 1 },
  dockHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 8,
  },
  dockSummary: { fontSize: 12, fontWeight: "600", flex: 1 },
  dockRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  dockBody: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, gap: 8 },
  dockSubRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  miniSeg: { flexDirection: "row", borderRadius: 7, padding: 2, gap: 2 },
  miniSegBtn: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 5 },
  chip: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6 },
  configBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  timelineWrap: { flex: 1, position: "relative" },
  timeline: { flex: 1 },
  timelineContent: { padding: 14, paddingBottom: 22, gap: 14 },
  scrollDownFab: {
    position: "absolute",
    right: 14,
    bottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    elevation: 3,
  },
  noticeBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
  },
  smBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7, borderWidth: 1 },
  emptyWrap: { paddingVertical: 42, paddingHorizontal: 16, alignItems: "center", gap: 12 },
  emptyMark: {
    width: 48,
    height: 48,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { fontSize: 16, fontWeight: "700" },
  emptyDesc: { fontSize: 13, textAlign: "center", lineHeight: 20, maxWidth: 300 },
  emptyActions: { flexDirection: "row", gap: 10, marginTop: 6 },
  primaryBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
  outlineBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  procBox: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  procTimeline: { marginTop: 8, paddingLeft: 10, borderLeftWidth: 1.5, gap: 8 },
  procArgs: { fontSize: 11, padding: 6, borderRadius: 6, borderWidth: 1 },
  userRow: { alignItems: "flex-end" },
  userBubble: {
    maxWidth: "86%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderBottomRightRadius: 5,
  },
  userText: { fontSize: 14, lineHeight: 21 },
  assistantRow: { gap: 6 },
  assistantText: { fontSize: 14.5, lineHeight: 23 },
  streamingWrap: { borderLeftWidth: 2, paddingLeft: 11 },
  codeBlock: { borderRadius: 10, borderWidth: 1, overflow: "hidden", marginVertical: 4 },
  codeHead: { paddingHorizontal: 10, paddingVertical: 5, borderBottomWidth: 1 },
  codePre: { padding: 10, fontSize: 12, lineHeight: 18 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  composerOuter: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10 },
  composerCard: { borderRadius: 18, borderWidth: 1, padding: 10, gap: 8 },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: { flex: 1, fontSize: 14.5, maxHeight: 110, minHeight: 28, paddingVertical: 4, paddingHorizontal: 4 },
  sendBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  ctrlScroll: { borderTopWidth: 1, paddingTop: 8 },
  ctrlRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  ctrlChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 28,
    paddingHorizontal: 9,
    borderRadius: 7,
    borderWidth: 1,
  },
  ctrlDot: { width: 6, height: 6, borderRadius: 3 },
  ctrlText: { fontSize: 11.5, fontWeight: "600" },
  thinkBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
});
