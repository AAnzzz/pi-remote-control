import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { PendingApprovalItem } from "@pi-remote/protocol";
import type { CodexPalette } from "../theme";

interface Props {
  palette: CodexPalette;
  items: PendingApprovalItem[];
  onInspect: (item: PendingApprovalItem) => void;
  onRefresh: () => void;
}

export function InboxScreen({ palette, items, onInspect, onRefresh }: Props) {
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.sectionRow}>
        <Text style={[styles.sectionLabel, { color: palette.textTertiary }]}>跨会话待审批与检查点</Text>
        <TouchableOpacity
          style={[styles.smBtn, { backgroundColor: palette.surface, borderColor: palette.borderStrong }]}
          onPress={onRefresh}
        >
          <Text style={{ color: palette.text, fontSize: 12, fontWeight: "600" }}>刷新</Text>
        </TouchableOpacity>
      </View>

      {items.length === 0 ? (
        <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[styles.emptyTitle, { color: palette.text }]}>暂无待审批项</Text>
          <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
            所有会话当前均无阻塞的工具权限请求、Plan 检查点或提问卡片。
          </Text>
        </View>
      ) : (
        <View style={styles.stack}>
          {items.map((item) => {
            const isHigh = item.risk === "high";
            return (
              <TouchableOpacity
                key={item.id}
                style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}
                onPress={() => onInspect(item)}
              >
                <View style={styles.between}>
                  <Text style={[styles.cardTitle, { color: palette.text, flex: 1 }]}>{item.title}</Text>
                  <View style={[styles.chip, { backgroundColor: isHigh ? palette.dangerSoft : palette.warnSoft }]}>
                    <Text style={{ color: isHigh ? palette.danger : palette.warn, fontSize: 11, fontWeight: "700" }}>
                      {item.requiresDesktopConfirm ? "需桌面确认" : isHigh ? "高风险" : "待审阅"}
                    </Text>
                  </View>
                </View>
                <Text style={[styles.summary, { color: palette.textSecondary }]} numberOfLines={3}>
                  {item.summary}
                </Text>
                <View style={[styles.between, { marginTop: 10 }]}>
                  <Text style={[styles.meta, { color: palette.textTertiary, fontFamily: palette.mono }]} numberOfLines={1}>
                    {item.sessionTitle || item.sessionId}
                  </Text>
                  <Text style={{ color: palette.text, fontSize: 12, fontWeight: "700" }}>审阅 ›</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, paddingBottom: 28, gap: 12 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionLabel: { fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4 },
  smBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  stack: { gap: 10 },
  card: { borderRadius: 13, borderWidth: 1, padding: 14 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { fontSize: 14, fontWeight: "700" },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  summary: { fontSize: 12.5, lineHeight: 19, marginTop: 6 },
  meta: { fontSize: 11, flex: 1 },
  emptyCard: { borderRadius: 14, borderWidth: 1, padding: 28, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700" },
  emptyDesc: { fontSize: 12.5, textAlign: "center", lineHeight: 19 },
});
