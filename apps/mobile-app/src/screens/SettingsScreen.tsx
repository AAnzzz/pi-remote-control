import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { PairingInvite, ProviderSummary, SessionSummary } from "@pi-remote/protocol";
import type { ConnectionState, HostSettingsSummary, PairedHostRecord } from "../lib/remoteClient";
import { MODE_LABELS, PERM_LABELS, THINK_LABELS, type CodexPalette, type ThemeMode } from "../theme";

interface Props {
  palette: CodexPalette;
  themeMode: ThemeMode;
  initialSub?: "providers" | "hosts" | "general";
  capabilityMode?: "standard" | "mcp-full";
  hostSettings: HostSettingsSummary;
  providers: ProviderSummary[];
  activeSession: SessionSummary | null;
  hosts: PairedHostRecord[];
  activeHostId: string | null;
  connState: ConnectionState;
  connDetail: string;
  sasPrompt: { code: string; hostName: string } | null;
  onChangeTheme: (mode: ThemeMode) => void;
  onRefreshProviders: () => void;
  onSelectModel: (providerId: string, modelId: string) => void;
  onPairInvite: (invite: PairingInvite) => void;
  onOpenQrScanner: () => void;
  onConnectHost: (host: PairedHostRecord) => void;
  onRemoveHost: (hostId: string) => void;
  onGoChat: () => void;
}

export function SettingsScreen({
  palette,
  themeMode,
  initialSub = "providers",
  capabilityMode,
  hostSettings,
  providers,
  activeSession,
  hosts,
  activeHostId,
  connState,
  connDetail,
  sasPrompt,
  onChangeTheme,
  onRefreshProviders,
  onSelectModel,
  onPairInvite,
  onOpenQrScanner,
  onConnectHost,
  onRemoveHost,
  onGoChat,
}: Props) {
  const [sub, setSub] = useState<"providers" | "hosts" | "general">(initialSub);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [inviteText, setInviteText] = useState("");
  const [pairErr, setPairErr] = useState("");

  const submitInvite = () => {
    setPairErr("");
    try {
      const parsed = JSON.parse(inviteText.trim()) as PairingInvite;
      onPairInvite(parsed);
      setInviteText("");
    } catch {
      setPairErr("配对串 JSON 格式无效");
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={[styles.segmented, { backgroundColor: palette.surface2, borderColor: palette.border }]}>
        {(
          [
            { id: "providers" as const, label: "供应商与模型" },
            { id: "hosts" as const, label: "主机与配对" },
            { id: "general" as const, label: "外观与偏好" },
          ]
        ).map((t) => {
          const active = sub === t.id;
          return (
            <TouchableOpacity
              key={t.id}
              style={[styles.segBtn, active ? { backgroundColor: palette.surface } : undefined]}
              onPress={() => setSub(t.id)}
            >
              <Text style={[styles.segText, { color: active ? palette.text : palette.textSecondary }]}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {sub === "providers" ? (
        <View style={styles.stack}>
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
            <View style={styles.between}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, { color: palette.text }]}>桌面端默认会话配置</Text>
                <Text style={[styles.cardSub, { color: palette.textSecondary }]}>
                  来自 PI-Desktop 全局设置，新建会话自动沿用
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.smBtn, { backgroundColor: palette.surface, borderColor: palette.borderStrong }]}
                onPress={onRefreshProviders}
              >
                <Text style={{ color: palette.text, fontSize: 11.5, fontWeight: "600" }}>刷新目录</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.kvGrid}>
              {[
                ["默认模式", MODE_LABELS[hostSettings.defaultMode] || hostSettings.defaultMode],
                ["默认权限", PERM_LABELS[hostSettings.defaultPermissionMode] || hostSettings.defaultPermissionMode],
                ["默认模型", hostSettings.defaultModelId || "未指定"],
                ["默认推理", THINK_LABELS[hostSettings.defaultThinkingLevel] || hostSettings.defaultThinkingLevel],
              ].map(([k, v]) => (
                <View
                  key={k}
                  style={[styles.kvCell, { backgroundColor: palette.surface2, borderColor: palette.border }]}
                >
                  <Text style={{ color: palette.textTertiary, fontSize: 10.5, fontWeight: "600" }}>{k}</Text>
                  <Text numberOfLines={1} style={{ color: palette.text, fontSize: 12.5, fontWeight: "600", marginTop: 2 }}>
                    {v}
                  </Text>
                </View>
              ))}
            </View>
            {capabilityMode ? (
              <View
                style={[
                  styles.capNotice,
                  {
                    backgroundColor: capabilityMode === "mcp-full" ? palette.okSoft : palette.warnSoft,
                  },
                ]}
              >
                <Text
                  style={{
                    color: capabilityMode === "mcp-full" ? palette.ok : palette.warn,
                    fontSize: 11.5,
                    fontWeight: "600",
                    lineHeight: 17,
                  }}
                >
                  {capabilityMode === "mcp-full"
                    ? "● MCP 免弹窗控制已就绪：点击下方模型将直接切换生效"
                    : "标准安全模式：切换模型/权限需在电脑弹窗点「允许一次」；以 PI_DESKTOP_MCP_CONTROL=1 启动 PI-Desktop 可解锁手机免弹窗直切"}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.between}>
            <Text style={[styles.sectionLabel, { color: palette.textTertiary }]}>模型供应商</Text>
            <View style={[styles.chip, { backgroundColor: palette.surface2, borderColor: palette.border, borderWidth: 1 }]}>
              <Text style={{ color: palette.textSecondary, fontSize: 11, fontWeight: "600" }}>
                {providers.length} 个
              </Text>
            </View>
          </View>

          {providers.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.emptyTitle, { color: palette.text }]}>尚未同步模型供应商</Text>
              <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
                连接 PI-Desktop 主机后会自动同步全部已配置供应商与可用模型（不含任何明文密钥）。
              </Text>
            </View>
          ) : (
            providers.map((p, idx) => {
              const isOpen = expanded[p.id] ?? idx === 0;
              return (
                <View
                  key={p.id}
                  style={[styles.provCard, { backgroundColor: palette.surface, borderColor: palette.border }]}
                >
                  <TouchableOpacity
                    style={styles.provHead}
                    onPress={() => setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }))}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={styles.row}>
                        <Text style={{ color: palette.text, fontSize: 13.5, fontWeight: "700" }}>{p.name}</Text>
                        <View
                          style={[
                            styles.chip,
                            { backgroundColor: !p.enabled ? palette.surface2 : p.hasApiKey ? palette.okSoft : palette.warnSoft },
                          ]}
                        >
                          <Text
                            style={{
                              color: !p.enabled ? palette.textTertiary : p.hasApiKey ? palette.ok : palette.warn,
                              fontSize: 10.5,
                              fontWeight: "700",
                            }}
                          >
                            {!p.enabled ? "已停用" : p.hasApiKey ? "已认证" : "未配密钥"}
                          </Text>
                        </View>
                      </View>
                      <Text
                        numberOfLines={1}
                        style={{ color: palette.textSecondary, fontSize: 11, fontFamily: palette.mono, marginTop: 3 }}
                      >
                        {p.apiStyle || "standard"}
                        {p.baseUrl ? ` · ${p.baseUrl}` : ""}
                      </Text>
                    </View>
                    <View style={styles.row}>
                      <View style={[styles.chip, { backgroundColor: palette.surface2 }]}>
                        <Text style={{ color: palette.textSecondary, fontSize: 10.5, fontWeight: "600" }}>
                          {p.models.length} 模型
                        </Text>
                      </View>
                      <Text style={{ color: palette.textTertiary, fontSize: 12 }}>{isOpen ? "▴" : "▾"}</Text>
                    </View>
                  </TouchableOpacity>

                  {isOpen ? (
                    <View
                      style={[
                        styles.provModels,
                        { backgroundColor: palette.surface2, borderTopColor: palette.border },
                      ]}
                    >
                      {p.models.length === 0 ? (
                        <Text style={{ color: palette.textSecondary, fontSize: 12 }}>
                          暂无缓存模型，可点击上方「刷新目录」。
                        </Text>
                      ) : (
                        p.models.map((m) => {
                          const isCur =
                            activeSession?.modelId === m.id &&
                            (!activeSession.providerId || activeSession.providerId === p.id);
                          const meta: string[] = [];
                          if (m.contextWindow) meta.push(`${Math.round(m.contextWindow / 1000)}K ctx`);
                          if (m.reasoning) meta.push("推理");
                          if (m.vision) meta.push("视觉");
                          return (
                            <TouchableOpacity
                              key={m.id}
                              style={[
                                styles.modelRow,
                                {
                                  backgroundColor: palette.surface,
                                  borderColor: isCur ? palette.text : palette.border,
                                },
                              ]}
                              onPress={() => onSelectModel(p.id, m.id)}
                            >
                              <View style={{ flex: 1 }}>
                                <Text
                                  numberOfLines={1}
                                  style={{ color: palette.text, fontSize: 12, fontWeight: "700", fontFamily: palette.mono }}
                                >
                                  {m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id}
                                </Text>
                                {meta.length > 0 ? (
                                  <Text style={{ color: palette.textSecondary, fontSize: 11, marginTop: 2 }}>
                                    {meta.join(" · ")}
                                  </Text>
                                ) : null}
                              </View>
                              <View
                                style={[
                                  styles.chip,
                                  { backgroundColor: isCur ? palette.accent : palette.surface2 },
                                ]}
                              >
                                <Text
                                  style={{
                                    color: isCur ? palette.accentFg : palette.textSecondary,
                                    fontSize: 10.5,
                                    fontWeight: "700",
                                  }}
                                >
                                  {isCur ? "当前使用" : "选用"}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
      ) : null}

      {sub === "hosts" ? (
        <View style={styles.stack}>
          {sasPrompt ? (
            <View style={[styles.sasCard, { backgroundColor: palette.warnSoft, borderColor: palette.warn }]}>
              <Text style={{ color: palette.warn, fontSize: 12, fontWeight: "700" }}>
                请核对 {sasPrompt.hostName} 屏幕上的 6 位安全短码
              </Text>
              <Text style={[styles.sasDigits, { color: palette.text, fontFamily: palette.mono }]}>
                {sasPrompt.code}
              </Text>
              <Text style={{ color: palette.textSecondary, fontSize: 12 }}>
                核对一致后请在电脑端点击「同意配对」...
              </Text>
            </View>
          ) : null}

          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border, gap: 10 }]}>
            <View style={styles.between}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, { color: palette.text }]}>配对 PI-Desktop 主机</Text>
                <Text style={[styles.cardSub, { color: palette.textSecondary }]}>
                  120 秒单次凭证 · X25519 + AES-256-GCM 端到端加密
                </Text>
              </View>
              <View style={[styles.chip, { backgroundColor: palette.surface2 }]}>
                <Text style={{ color: palette.textSecondary, fontSize: 11, fontWeight: "700" }}>E2EE</Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: palette.accent }]}
              onPress={onOpenQrScanner}
            >
              <Text style={{ color: palette.accentFg, fontWeight: "700", fontSize: 13 }}>扫码配对</Text>
            </TouchableOpacity>

            <TextInput
              style={[
                styles.textarea,
                {
                  backgroundColor: palette.surface2,
                  borderColor: palette.borderStrong,
                  color: palette.text,
                  fontFamily: palette.mono,
                },
              ]}
              placeholder="或直接粘贴 PI-Desktop 插件生成的配对 JSON..."
              placeholderTextColor={palette.textTertiary}
              multiline
              value={inviteText}
              onChangeText={setInviteText}
            />

            <View style={styles.between}>
              <TouchableOpacity
                style={[styles.smBtn, { backgroundColor: palette.accent, borderColor: palette.accent }]}
                onPress={submitInvite}
              >
                <Text style={{ color: palette.accentFg, fontSize: 12, fontWeight: "700" }}>使用配对串连接</Text>
              </TouchableOpacity>
              {pairErr ? (
                <Text style={{ color: palette.danger, fontSize: 12, fontWeight: "600" }}>{pairErr}</Text>
              ) : connDetail ? (
                <Text numberOfLines={1} style={{ color: palette.textSecondary, fontSize: 11.5, flex: 1, textAlign: "right" }}>
                  {connDetail}
                </Text>
              ) : null}
            </View>
          </View>

          <View style={styles.between}>
            <Text style={[styles.sectionLabel, { color: palette.textTertiary }]}>已配对桌面主机</Text>
            <View style={[styles.chip, { backgroundColor: palette.surface2 }]}>
              <Text style={{ color: palette.textSecondary, fontSize: 11, fontWeight: "600" }}>{hosts.length} 台</Text>
            </View>
          </View>

          {hosts.length === 0 ? (
            <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.emptyTitle, { color: palette.text }]}>尚未绑定桌面主机</Text>
              <Text style={[styles.emptyDesc, { color: palette.textSecondary }]}>
                打开 PI-Desktop「远程控制」面板点击「生成配对码」，在上方扫码或粘贴 JSON 完成绑定。
              </Text>
            </View>
          ) : (
            hosts.map((h) => {
              const online =
                activeHostId === h.hostId && (connState === "online_direct" || connState === "online_relay");
              return (
                <View
                  key={h.hostId}
                  style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border, gap: 8 }]}
                >
                  <View style={styles.between}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.cardTitle, { color: palette.text }]}>{h.hostName}</Text>
                      <Text style={{ color: palette.textTertiary, fontSize: 11, fontFamily: palette.mono }}>
                        {h.hostId}
                      </Text>
                    </View>
                    <View style={[styles.chip, { backgroundColor: online ? palette.okSoft : palette.surface2 }]}>
                      <Text style={{ color: online ? palette.ok : palette.textSecondary, fontSize: 11, fontWeight: "700" }}>
                        {online ? (connState === "online_relay" ? "● 盲中继" : "● 直连") : "○ 离线"}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ color: palette.textSecondary, fontSize: 11.5 }}>
                    直连端点 {(h.directUrls || []).length} 个 · {h.relayUrl || "仅局域网直连"}
                  </Text>
                  <View style={styles.row}>
                    <TouchableOpacity
                      style={[
                        online ? styles.outlineBtn : styles.primaryBtn,
                        {
                          flex: 1,
                          backgroundColor: online ? palette.surface : palette.accent,
                          borderColor: palette.borderStrong,
                        },
                      ]}
                      onPress={() => (online ? onGoChat() : onConnectHost(h))}
                    >
                      <Text
                        style={{
                          color: online ? palette.text : palette.accentFg,
                          fontWeight: "700",
                          fontSize: 13,
                        }}
                      >
                        {online ? "进入工作台" : "加密连接"}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.dangerBtn, { backgroundColor: palette.dangerSoft }]}
                      onPress={() => onRemoveHost(h.hostId)}
                    >
                      <Text style={{ color: palette.danger, fontWeight: "700", fontSize: 13 }}>移除</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })
          )}
        </View>
      ) : null}

      {sub === "general" ? (
        <View style={styles.stack}>
          <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border, gap: 12 }]}>
            <Text style={[styles.cardTitle, { color: palette.text }]}>外观风格</Text>
            <View style={styles.between}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: palette.text, fontSize: 13.5, fontWeight: "600" }}>界面主题</Text>
                <Text style={[styles.cardSub, { color: palette.textSecondary }]}>
                  仿 Codex 极简单色配色，提供纯白与炭黑双模式
                </Text>
              </View>
              <View style={[styles.miniSeg, { backgroundColor: palette.surface2, borderColor: palette.border }]}>
                <TouchableOpacity
                  style={[styles.miniSegBtn, themeMode === "light" ? { backgroundColor: palette.surface } : undefined]}
                  onPress={() => onChangeTheme("light")}
                >
                  <Text style={{ color: themeMode === "light" ? palette.text : palette.textSecondary, fontSize: 12, fontWeight: "600" }}>
                    浅色
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.miniSegBtn, themeMode === "dark" ? { backgroundColor: palette.surface } : undefined]}
                  onPress={() => onChangeTheme("dark")}
                >
                  <Text style={{ color: themeMode === "dark" ? palette.text : palette.textSecondary, fontSize: 12, fontWeight: "600" }}>
                    深色
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, paddingBottom: 28, gap: 12 },
  segmented: { flexDirection: "row", padding: 3, borderRadius: 10, borderWidth: 1, gap: 3 },
  segBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 7, borderRadius: 7 },
  segText: { fontSize: 12, fontWeight: "600" },
  stack: { gap: 10 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14 },
  cardTitle: { fontSize: 14, fontWeight: "700" },
  cardSub: { fontSize: 12, marginTop: 2, lineHeight: 18 },
  between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionLabel: { fontSize: 11.5, fontWeight: "700", letterSpacing: 0.4 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  smBtn: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  kvGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  kvCell: { width: "48%", padding: 9, borderRadius: 9, borderWidth: 1 },
  capNotice: { marginTop: 10, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 9 },
  provCard: { borderRadius: 13, borderWidth: 1, overflow: "hidden" },
  provHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 13, gap: 8 },
  provModels: { borderTopWidth: 1, padding: 9, gap: 6 },
  modelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 10,
    borderRadius: 9,
    borderWidth: 1,
  },
  sasCard: { borderRadius: 14, borderWidth: 1, padding: 18, alignItems: "center", gap: 8 },
  sasDigits: { fontSize: 32, fontWeight: "800", letterSpacing: 8 },
  textarea: { borderRadius: 10, borderWidth: 1, padding: 10, minHeight: 82, fontSize: 11.5, textAlignVertical: "top" },
  primaryBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  outlineBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, borderWidth: 1, alignItems: "center" },
  dangerBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  miniSeg: { flexDirection: "row", borderRadius: 8, borderWidth: 1, padding: 2, gap: 2 },
  miniSegBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  emptyCard: { borderRadius: 14, borderWidth: 1, padding: 26, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: "700" },
  emptyDesc: { fontSize: 12.5, textAlign: "center", lineHeight: 19 },
});
