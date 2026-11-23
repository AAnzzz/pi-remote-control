import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { DiffFilePatch, DiffFileSummary } from "@pi-remote/protocol";
import { DiffPatchView } from "../components/DiffViewerModal";
import type { CodexPalette } from "../theme";

interface Props {
  palette: CodexPalette;
  branch: string;
  files: DiffFileSummary[];
  selectedPath: string | null;
  activePatch: DiffFilePatch | null;
  loadingFile: string | null;
  onSelectFile: (path: string) => void;
  onRefresh: () => void;
}

export function DiffScreen({
  palette,
  branch,
  files,
  selectedPath,
  activePatch,
  loadingFile,
  onSelectFile,
  onRefresh,
}: Props) {
  const [wrap, setWrap] = useState(false);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.sectionRow}>
        <Text style={[styles.sectionLabel, { color: palette.textTertiary }]}>
          {branch ? `分支 ${branch} · ${files.length} 文件` : `工作区变更 · ${files.length} 文件`}
        </Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.smBtn, { backgroundColor: palette.surface, borderColor: palette.borderStrong }]}
            onPress={() => setWrap((v) => !v)}
          >
            <Text style={{ color: palette.text, fontSize: 12, fontWeight: "600" }}>
              {wrap ? "横向滚动" : "自动换行"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.smBtn, { backgroundColor: palette.surface, borderColor: palette.borderStrong }]}
            onPress={onRefresh}
          >
            <Text style={{ color: palette.text, fontSize: 12, fontWeight: "600" }}>刷新</Text>
          </TouchableOpacity>
        </View>
      </View>

      {files.length === 0 ? (
        <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          <Text style={[styles.emptyTitle, { color: palette.text }]}>工作区干净</Text>
          <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
            当前无未提交代码改动；敏感凭据路径（.env* / .ssh / *.pem）已由桌面插件自动隔离过滤。
          </Text>
        </View>
      ) : (
        <View style={styles.stack}>
          {files.map((f) => {
            const selected = selectedPath === f.path;
            const stBg =
              f.status === "A" || f.status === "?"
                ? palette.okSoft
                : f.status === "D"
                ? palette.dangerSoft
                : palette.warnSoft;
            const stFg =
              f.status === "A" || f.status === "?"
                ? palette.ok
                : f.status === "D"
                ? palette.danger
                : palette.warn;
            return (
              <TouchableOpacity
                key={f.path}
                style={[
                  styles.fileRow,
                  {
                    backgroundColor: selected ? palette.surface2 : palette.surface,
                    borderColor: selected ? palette.text : palette.border,
                  },
                ]}
                onPress={() => onSelectFile(f.path)}
              >
                <View style={[styles.stBadge, { backgroundColor: stBg }]}>
                  <Text style={{ color: stFg, fontSize: 11, fontWeight: "700" }}>{f.status}</Text>
                </View>
                <Text
                  numberOfLines={1}
                  style={[styles.filePath, { color: palette.text, fontFamily: palette.mono }]}
                >
                  {f.path}
                </Text>
                <Text style={[styles.statText, { color: palette.ok, fontFamily: palette.mono }]}>+{f.additions}</Text>
                <Text style={[styles.statText, { color: palette.danger, fontFamily: palette.mono }]}>
                  -{f.deletions}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {loadingFile ? (
        <Text style={{ color: palette.textSecondary, fontSize: 12.5 }}>正在加载 {loadingFile} ...</Text>
      ) : activePatch ? (
        <DiffPatchView patch={activePatch} palette={palette} wrap={wrap} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, paddingBottom: 28, gap: 12 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  sectionLabel: { fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4 },
  row: { flexDirection: "row", gap: 8 },
  smBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  stack: { gap: 7 },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  stBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  filePath: { flex: 1, fontSize: 12, fontWeight: "600" },
  statText: { fontSize: 11.5, fontWeight: "700" },
  emptyCard: { borderRadius: 14, borderWidth: 1, padding: 28, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700" },
  emptyDesc: { fontSize: 12.5, textAlign: "center", lineHeight: 19 },
});
