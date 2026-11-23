import { Platform } from "react-native";
import type { PermissionMode, SessionMode, ThinkingLevel } from "@pi-remote/protocol";

export type ThemeMode = "light" | "dark";

export interface CodexPalette {
  mode: ThemeMode;
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentFg: string;
  accentSoft: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  userBubbleBg: string;
  userBubbleText: string;
  codeBg: string;
  codeHeader: string;
  codeText: string;
  diffAddBg: string;
  diffAddText: string;
  diffDelBg: string;
  diffDelText: string;
  backdrop: string;
  mono: string;
}

const monoFont = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) || "monospace";

export const lightPalette: CodexPalette = {
  mode: "light",
  bg: "#FFFFFF",
  surface: "#FFFFFF",
  surface2: "#F7F7F8",
  surface3: "#EFEFEF",
  border: "rgba(0, 0, 0, 0.09)",
  borderStrong: "rgba(0, 0, 0, 0.17)",
  text: "#0D0D0D",
  textSecondary: "#5D5D5D",
  textTertiary: "#8E8E93",
  accent: "#0D0D0D",
  accentFg: "#FFFFFF",
  accentSoft: "rgba(13, 13, 13, 0.06)",
  ok: "#10A37F",
  okSoft: "rgba(16, 163, 127, 0.11)",
  warn: "#B45309",
  warnSoft: "rgba(180, 83, 9, 0.10)",
  danger: "#DC2626",
  dangerSoft: "rgba(220, 38, 38, 0.10)",
  userBubbleBg: "#F2F2F3",
  userBubbleText: "#0D0D0D",
  codeBg: "#F7F7F8",
  codeHeader: "#EFEFF1",
  codeText: "#18181B",
  diffAddBg: "rgba(16, 163, 127, 0.12)",
  diffAddText: "#065F46",
  diffDelBg: "rgba(220, 38, 38, 0.11)",
  diffDelText: "#991B1B",
  backdrop: "rgba(0, 0, 0, 0.38)",
  mono: monoFont,
};

export const darkPalette: CodexPalette = {
  mode: "dark",
  bg: "#0D0D0D",
  surface: "#121212",
  surface2: "#1A1A1A",
  surface3: "#242424",
  border: "rgba(255, 255, 255, 0.10)",
  borderStrong: "rgba(255, 255, 255, 0.18)",
  text: "#ECECEC",
  textSecondary: "#9B9B9B",
  textTertiary: "#686868",
  accent: "#FFFFFF",
  accentFg: "#0D0D0D",
  accentSoft: "rgba(255, 255, 255, 0.10)",
  ok: "#34D399",
  okSoft: "rgba(52, 211, 153, 0.14)",
  warn: "#F59E0B",
  warnSoft: "rgba(245, 158, 11, 0.14)",
  danger: "#F87171",
  dangerSoft: "rgba(248, 113, 113, 0.15)",
  userBubbleBg: "#232323",
  userBubbleText: "#F3F3F3",
  codeBg: "#161616",
  codeHeader: "#1E1E1E",
  codeText: "#E5E5E5",
  diffAddBg: "rgba(52, 211, 153, 0.14)",
  diffAddText: "#A7F3D0",
  diffDelBg: "rgba(248, 113, 113, 0.15)",
  diffDelText: "#FECACA",
  backdrop: "rgba(0, 0, 0, 0.68)",
  mono: monoFont,
};

export function getPalette(mode: ThemeMode): CodexPalette {
  return mode === "dark" ? darkPalette : lightPalette;
}

export const SESSION_MODES: Array<{ id: SessionMode; label: string; desc: string }> = [
  { id: "agent", label: "智能体", desc: "直接协作编码、调用工具与执行命令，适合绝大多数开发任务" },
  { id: "goal", label: "目标", desc: "围绕最终验收标准自主拆解并持续推进直到目标达成" },
  { id: "plan", label: "规划", desc: "先只读调研并输出完整方案检查点，获批后再动手改代码" },
];

export const PERMISSION_MODES: Array<{ id: Exclude<PermissionMode, "inherit">; label: string; desc: string }> = [
  { id: "ask", label: "每次询问", desc: "写文件与执行命令前逐次请求确认，最稳妥安全" },
  { id: "accept-edits", label: "允许编辑", desc: "自动允许工作区文件编辑，高风险命令仍需确认" },
  { id: "auto", label: "全自动", desc: "自动批准工具与命令执行，适合可信沙箱与无人值守任务" },
];

export const THINKING_LEVELS: Array<{ id: ThinkingLevel; label: string }> = [
  { id: "off", label: "关闭" },
  { id: "low", label: "低" },
  { id: "medium", label: "中" },
  { id: "high", label: "高" },
  { id: "xhigh", label: "极高" },
];

export const MODE_LABELS: Record<string, string> = {
  agent: "智能体",
  goal: "目标",
  plan: "规划",
};

export const PERM_LABELS: Record<string, string> = {
  inherit: "跟随默认",
  ask: "每次询问",
  "accept-edits": "允许编辑",
  auto: "全自动",
};

export const THINK_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  omit: "默认",
};
