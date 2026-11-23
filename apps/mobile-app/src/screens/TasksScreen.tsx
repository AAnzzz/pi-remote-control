import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { BackgroundTaskItem, ScheduledTaskItem, TodoItem } from "@pi-remote/protocol";
import type { CodexPalette } from "../theme";

interface Props {
  palette: CodexPalette;
  todos: TodoItem[];
  backgroundTasks: BackgroundTaskItem[];
  scheduledTasks: ScheduledTaskItem[];
  onRefresh: () => void;
}

type SubTab = "todos" | "bg" | "scheduled";

export function TasksScreen({ palette, todos, backgroundTasks, scheduledTasks, onRefresh }: Props) {
  const [sub, setSub] = useState<SubTab>("todos");

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const activeTotal = Math.max(1, todos.filter((t) => t.status !== "cancelled").length);
  const pct = todos.length > 0 ? Math.round((completedCount / activeTotal) * 100) : 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.sectionRow}>
        <Text style={[styles.sectionLabel, { color: palette.textTertiary }]}>工作任务中心</Text>
        <TouchableOpacity
          style={[styles.smBtn, { backgroundColor: palette.surface, borderColor: palette.borderStrong }]}
          onPress={onRefresh}
        >
          <Text style={{ color: palette.text, fontSize: 12, fontWeight: "600" }}>刷新</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.segmented, { backgroundColor: palette.surface2, borderColor: palette.border }]}>
        {(
          [
            { id: "todos" as const, label: "待办", count: todos.length },
            { id: "bg" as const, label: "后台任务", count: backgroundTasks.length },
            { id: "scheduled" as const, label: "定时任务", count: scheduledTasks.length },
          ]
        ).map((tab) => {
          const active = sub === tab.id;
          return (
            <TouchableOpacity
              key={tab.id}
              style={[styles.segBtn, active ? { backgroundColor: palette.surface } : undefined]}
              onPress={() => setSub(tab.id)}
            >
              <Text style={[styles.segText, { color: active ? palette.text : palette.textSecondary }]}>
                {tab.label}
              </Text>
              <View style={[styles.countBadge, { backgroundColor: palette.accentSoft }]}>
                <Text style={[styles.countText, { color: palette.textSecondary, fontFamily: palette.mono }]}>
                  {tab.count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {sub === "todos" ? (
        todos.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Text style={[styles.emptyTitle, { color: palette.text }]}>当前会话暂无待办</Text>
            <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
              当 Agent 在 PI-Desktop 中使用 TodoWrite 拆解多步任务时，进度会实时同步到这里。
            </Text>
          </View>
        ) : (
          <View style={styles.stack}>
            <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <View style={styles.between}>
                <Text style={[styles.cardTitle, { color: palette.text }]}>
                  会话待办进度 · {completedCount} / {activeTotal}
                </Text>
                <View style={[styles.chip, { backgroundColor: pct === 100 ? palette.okSoft : palette.surface2 }]}>
                  <Text style={{ color: pct === 100 ? palette.ok : palette.textSecondary, fontSize: 11, fontWeight: "700" }}>
                    {pct}%
                  </Text>
                </View>
              </View>
              <View style={[styles.track, { backgroundColor: palette.surface3 }]}>
                <View style={[styles.fill, { backgroundColor: palette.accent, width: `${pct}%` }]} />
              </View>
            </View>

            {todos.map((todo, idx) => {
              const isDone = todo.status === "completed";
              const isCur = todo.status === "in_progress";
              const isCancel = todo.status === "cancelled";
              return (
                <View
                  key={`${idx}-${todo.content.slice(0, 18)}`}
                  style={[
                    styles.todoRow,
                    {
                      backgroundColor: isCur ? palette.surface2 : palette.surface,
                      borderColor: isCur ? palette.borderStrong : palette.border,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.todoMark,
                      {
                        borderColor: isDone ? palette.ok : isCur ? palette.text : palette.borderStrong,
                        backgroundColor: isDone ? palette.okSoft : "transparent",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color: isDone ? palette.ok : isCur ? palette.text : palette.textTertiary,
                        fontSize: 10,
                        fontWeight: "800",
                      }}
                    >
                      {isDone ? "✓" : isCur ? "•" : isCancel ? "−" : ""}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.todoText,
                      {
                        color: isDone || isCancel ? palette.textTertiary : palette.text,
                        textDecorationLine: isDone || isCancel ? "line-through" : "none",
                      },
                    ]}
                  >
                    {todo.content}
                  </Text>
                  {isCur ? (
                    <View style={[styles.chip, { backgroundColor: palette.accent }]}>
                      <Text style={{ color: palette.accentFg, fontSize: 10.5, fontWeight: "700" }}>进行中</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )
      ) : null}

      {sub === "bg" ? (
        backgroundTasks.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Text style={[styles.emptyTitle, { color: palette.text }]}>暂无后台命令或子代理</Text>
            <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
              Agent 启动后台服务（runInBackground）或子代理任务时，会实时同步运行状态与输出尾巴。
            </Text>
          </View>
        ) : (
          <View style={styles.stack}>
            {backgroundTasks.map((task) => {
              const stateStyle =
                task.state === "running"
                  ? { label: "运行中", bg: palette.okSoft, fg: palette.ok }
                  : task.state === "failed"
                  ? { label: "失败", bg: palette.dangerSoft, fg: palette.danger }
                  : task.state === "stopped"
                  ? { label: "已停止", bg: palette.warnSoft, fg: palette.warn }
                  : { label: task.state === "exited" ? "已退出" : "已完成", bg: palette.surface2, fg: palette.textSecondary };
              return (
                <View key={task.id} style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                  <View style={styles.between}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.cardTitle, { color: palette.text }]}>{task.title}</Text>
                      <Text style={[styles.monoMeta, { color: palette.textTertiary, fontFamily: palette.mono }]}>
                        {task.kind === "subagent" ? `子代理 · ${task.agent || "task"}` : "后台命令"} · {task.id.slice(0, 14)}
                        {typeof task.exitCode === "number" ? ` · exit ${task.exitCode}` : ""}
                      </Text>
                    </View>
                    <View style={[styles.chip, { backgroundColor: stateStyle.bg }]}>
                      <Text style={{ color: stateStyle.fg, fontSize: 11, fontWeight: "700" }}>{stateStyle.label}</Text>
                    </View>
                  </View>
                  {task.command ? (
                    <View style={[styles.cmdBox, { backgroundColor: palette.surface2, borderColor: palette.border }]}>
                      <Text style={[styles.cmdText, { color: palette.textSecondary, fontFamily: palette.mono }]}>
                        $ {task.command}
                      </Text>
                    </View>
                  ) : null}
                  {task.outputPreview ? (
                    <View style={[styles.cmdBox, { backgroundColor: palette.surface2, borderColor: palette.border }]}>
                      <Text style={[styles.cmdText, { color: palette.textSecondary, fontFamily: palette.mono }]}>
                        {task.outputPreview}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )
      ) : null}

      {sub === "scheduled" ? (
        scheduledTasks.length === 0 ? (
          <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <Text style={[styles.emptyTitle, { color: palette.text }]}>暂无定时自动化任务</Text>
            <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
              PI-Desktop 中配置的定时任务会自动同步显示在这里。
            </Text>
          </View>
        ) : (
          <View style={styles.stack}>
            {scheduledTasks.map((st) => (
              <View key={st.id} style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                <View style={styles.between}>
                  <Text style={[styles.cardTitle, { color: palette.text, flex: 1 }]}>{st.title}</Text>
                  <View style={[styles.chip, { backgroundColor: st.enabled ? palette.okSoft : palette.surface2 }]}>
                    <Text style={{ color: st.enabled ? palette.ok : palette.textSecondary, fontSize: 11, fontWeight: "700" }}>
                      {st.enabled ? st.cadence || "已启用" : "已暂停"}
                    </Text>
                  </View>
                </View>
                {st.prompt ? (
                  <Text style={{ color: palette.textSecondary, fontSize: 12.5, marginTop: 6, lineHeight: 18 }}>
                    {st.prompt}
                  </Text>
                ) : null}
                <Text style={[styles.monoMeta, { color: palette.textTertiary, fontFamily: palette.mono, marginTop: 6 }]}>
                  下次运行: {st.nextRunAt || "手动"} · 最近状态: {st.lastStatus || "-"}
                </Text>
              </View>
            ))}
          </View>
        )
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, paddingBottom: 28, gap: 12 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionLabel: { fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4 },
  smBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  segmented: { flexDirection: "row", padding: 3, borderRadius: 10, borderWidth: 1, gap: 3 },
  segBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 7,
    borderRadius: 7,
  },
  segText: { fontSize: 12, fontWeight: "600" },
  countBadge: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 999 },
  countText: { fontSize: 10.5 },
  stack: { gap: 9 },
  card: { borderRadius: 13, borderWidth: 1, padding: 13 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { fontSize: 13.5, fontWeight: "600" },
  monoMeta: { fontSize: 11, marginTop: 3 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  track: { width: "100%", height: 5, borderRadius: 999, overflow: "hidden", marginTop: 10 },
  fill: { height: "100%", borderRadius: 999 },
  todoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 11, borderRadius: 10, borderWidth: 1 },
  todoMark: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  todoText: { flex: 1, fontSize: 13, lineHeight: 19 },
  cmdBox: { marginTop: 8, padding: 8, borderRadius: 8, borderWidth: 1 },
  cmdText: { fontSize: 11, lineHeight: 16 },
  emptyCard: { borderRadius: 14, borderWidth: 1, padding: 28, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700" },
  emptyDesc: { fontSize: 12.5, textAlign: "center", lineHeight: 19 },
});
