import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { DiffFilePatch } from "@pi-remote/protocol";
import type { CodexPalette } from "../theme";

interface Props {
  patch: DiffFilePatch;
  palette: CodexPalette;
  wrap: boolean;
}

export function DiffPatchView({ patch, palette, wrap }: Props) {
  if (patch.binary) {
    return (
      <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        <Text style={{ color: palette.textSecondary, fontSize: 13 }}>二进制文件不支持文本差异预览。</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {(patch.hunks || []).map((hunk, hIdx) => {
        const content = (
          <View style={wrap ? { width: "100%" } : undefined}>
            {hunk.lines.map((line, lIdx) => {
              const bg =
                line.type === "add"
                  ? palette.diffAddBg
                  : line.type === "del"
                  ? palette.diffDelBg
                  : "transparent";
              const fg =
                line.type === "add"
                  ? palette.diffAddText
                  : line.type === "del"
                  ? palette.diffDelText
                  : palette.text;
              const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
              return (
                <View key={lIdx} style={[styles.lineRow, { backgroundColor: bg }]}>
                  <Text style={[styles.ln, { color: palette.textTertiary, fontFamily: palette.mono }]}>
                    {line.oldLine ?? ""}
                  </Text>
                  <Text style={[styles.ln, { color: palette.textTertiary, fontFamily: palette.mono }]}>
                    {line.newLine ?? ""}
                  </Text>
                  <Text style={[styles.sign, { color: fg, fontFamily: palette.mono }]}>{sign}</Text>
                  <Text
                    style={[
                      styles.code,
                      { color: fg, fontFamily: palette.mono },
                      wrap ? styles.codeWrap : undefined,
                    ]}
                  >
                    {line.text}
                  </Text>
                </View>
              );
            })}
          </View>
        );

        return (
          <View
            key={`${hunk.header}-${hIdx}`}
            style={[styles.hunk, { backgroundColor: palette.surface, borderColor: palette.border }]}
          >
            <View
              style={[
                styles.hunkHead,
                { backgroundColor: palette.surface2, borderBottomColor: palette.border },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[styles.hunkHeadText, { color: palette.textSecondary, fontFamily: palette.mono }]}
              >
                {patch.path}  {hunk.header}
              </Text>
            </View>
            {wrap ? content : <ScrollView horizontal>{content}</ScrollView>}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14 },
  hunk: { borderRadius: 12, borderWidth: 1, overflow: "hidden" },
  hunkHead: { paddingHorizontal: 10, paddingVertical: 7, borderBottomWidth: 1 },
  hunkHeadText: { fontSize: 11 },
  lineRow: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 1.5, alignItems: "flex-start" },
  ln: { width: 28, textAlign: "right", marginRight: 6, fontSize: 11 },
  sign: { width: 13, fontSize: 11.5, fontWeight: "700" },
  code: { fontSize: 11.5, lineHeight: 17 },
  codeWrap: { flex: 1, flexWrap: "wrap" },
});
