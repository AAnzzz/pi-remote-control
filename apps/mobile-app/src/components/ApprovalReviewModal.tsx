import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import type { PendingApprovalItem } from "@pi-remote/protocol";
import { BottomSheet } from "./BottomSheet";
import type { CodexPalette } from "../theme";

interface Props {
  item: PendingApprovalItem | null;
  palette: CodexPalette;
  submitting: boolean;
  feedback?: string | null;
  onDecision: (item: PendingApprovalItem, decision: "allow" | "deny", scope: "once" | "session") => void;
  onClose: () => void;
}

export function ApprovalReviewModal({ item, palette, submitting, feedback, onDecision, onClose }: Props) {
  const [stepTwo, setStepTwo] = useState(false);

  useEffect(() => {
    setStepTwo(false);
  }, [item?.id]);

  if (!item) return null;
  const isHigh = item.risk === "high";
  const kindLabel = item.kind === "permission" ? "工具权限审批" : item.kind === "plan" ? "Plan 检查点" : "Agent 提问";

  const handleAllow = async () => {
    if (isHigh && !stepTwo) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setStepTwo(true);
      return;
    }
    if (isHigh && !item.requiresDesktopConfirm) {
      try {
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (enrolled) {
          const auth = await LocalAuthentication.authenticateAsync({
            promptMessage: `确认允许高风险工具：${item.title}`,
            cancelLabel: "取消",
          });
          if (!auth.success) return;
        }
      } catch {
        // Fallback when simulator/device has no biometrics
      }
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onDecision(item, "allow", "once");
  };

  const handleDeny = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onDecision(item, "deny", "once");
  };

  return (
    <BottomSheet
      visible={Boolean(item)}
      palette={palette}
      title={item.title}
      subtitle={`${kindLabel} · ${isHigh ? "高风险（仅允许单次）" : item.risk.toUpperCase()}`}
      onClose={onClose}
    >
      <Text style={[styles.summary, { color: palette.text }]}>{item.summary}</Text>

      {item.argsPreview ? (
        <View style={styles.section}>
          <Text style={[styles.label, { color: palette.textTertiary }]}>宿主结构化参数</Text>
          <ScrollView
            horizontal
            style={[styles.argsBox, { backgroundColor: palette.codeBg, borderColor: palette.border }]}
          >
            <Text style={[styles.argsText, { color: palette.codeText, fontFamily: palette.mono }]}>
              {item.argsPreview}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      {item.requiresDesktopConfirm ? (
        <View style={[styles.warnBanner, { backgroundColor: palette.warnSoft }]}>
          <Text style={[styles.warnText, { color: palette.warn }]}>
            标准模式：请回到 PI-Desktop 窗口完成最终确认，或以 PI_DESKTOP_MCP_CONTROL=1 启动宿主。
          </Text>
        </View>
      ) : null}

      {stepTwo ? (
        <Text style={[styles.stepNote, { color: palette.textSecondary }]}>
          高风险二次确认：已核对上方真实参数，再次点击即可单次放行。
        </Text>
      ) : null}

      {feedback ? <Text style={[styles.stepNote, { color: palette.warn }]}>{feedback}</Text> : null}

      <View style={styles.actions}>
        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: palette.dangerSoft, flex: 1, opacity: submitting || item.requiresDesktopConfirm ? 0.45 : 1 },
          ]}
          disabled={submitting || item.requiresDesktopConfirm}
          onPress={handleDeny}
        >
          <Text style={[styles.btnText, { color: palette.danger }]}>拒绝</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: palette.accent, flex: 1.4, opacity: submitting || item.requiresDesktopConfirm ? 0.45 : 1 },
          ]}
          disabled={submitting || item.requiresDesktopConfirm}
          onPress={handleAllow}
        >
          <Text style={[styles.btnText, { color: palette.accentFg }]}>
            {submitting ? "提交中..." : stepTwo ? "再次确认：单次允许" : isHigh ? "核对参数并继续" : "确认：单次允许"}
          </Text>
        </TouchableOpacity>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  summary: { fontSize: 14, lineHeight: 21 },
  section: { gap: 6 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  argsBox: {
    maxHeight: 200,
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
  },
  argsText: { fontSize: 11.5, lineHeight: 17 },
  warnBanner: { padding: 11, borderRadius: 10 },
  warnText: { fontSize: 12.5, lineHeight: 18, fontWeight: "500" },
  stepNote: { fontSize: 12.5, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 10, marginTop: 6 },
  btn: { paddingVertical: 12, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  btnText: { fontSize: 13.5, fontWeight: "700" },
});
