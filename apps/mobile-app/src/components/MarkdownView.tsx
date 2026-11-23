import React, { useMemo } from "react";
import {
  Linking,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
} from "react-native";
import {
  parseMarkdown,
  tokenizeCode,
  type CodeToken,
  type InlineNode,
  type MarkdownBlock,
} from "../lib/markdownParser.mjs";
import type { CodexPalette } from "../theme";

interface Props {
  content: string;
  palette: CodexPalette;
  streaming?: boolean;
  onPressFilePath?: (filePath: string) => void;
}

function getTokenColor(kind: CodeToken["kind"], palette: CodexPalette): string {
  const dark = palette.mode === "dark";
  switch (kind) {
    case "keyword":
      return dark ? "#D2A8FF" : "#7C3AED";
    case "string":
      return dark ? "#7EE787" : "#047857";
    case "comment":
      return palette.textTertiary;
    case "number":
      return dark ? "#F2CC60" : "#B45309";
    case "type":
      return dark ? "#79C0FF" : "#1D4ED8";
    default:
      return palette.codeText;
  }
}

function openExternalUrl(href: string) {
  if (!/^https?:\/\//i.test(href)) return;
  Linking.openURL(href).catch(() => {});
}

function renderInlineNodes(
  nodes: InlineNode[],
  palette: CodexPalette,
  keyPrefix: string,
  onPressFilePath?: (filePath: string) => void
): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case "text":
        return <React.Fragment key={key}>{node.text}</React.Fragment>;
      case "break":
        return <React.Fragment key={key}>{"\n"}</React.Fragment>;
      case "bold":
        return (
          <Text key={key} style={styles.bold}>
            {renderInlineNodes(node.children, palette, key, onPressFilePath)}
          </Text>
        );
      case "italic":
        return (
          <Text key={key} style={styles.italic}>
            {renderInlineNodes(node.children, palette, key, onPressFilePath)}
          </Text>
        );
      case "strike":
        return (
          <Text key={key} style={[styles.strike, { color: palette.textTertiary }]}>
            {renderInlineNodes(node.children, palette, key, onPressFilePath)}
          </Text>
        );
      case "code":
        return (
          <Text
            key={key}
            style={[
              styles.inlineCode,
              {
                fontFamily: palette.mono,
                backgroundColor: palette.surface3,
                color: palette.text,
              },
            ]}
          >
            {` ${node.code} `}
          </Text>
        );
      case "link":
        if (node.kind === "file") {
          return (
            <Text
              key={key}
              onPress={() => onPressFilePath?.(node.href)}
              style={[
                styles.fileLink,
                {
                  fontFamily: palette.mono,
                  backgroundColor: palette.surface2,
                  color: palette.text,
                },
              ]}
            >
              {` ${node.label} `}
            </Text>
          );
        }
        return (
          <Text
            key={key}
            onPress={() => openExternalUrl(node.href)}
            style={[styles.urlLink, { color: palette.text }]}
          >
            {node.label}
          </Text>
        );
      default:
        return null;
    }
  });
}

const CodeBlockView = React.memo(function CodeBlockView({
  lang,
  code,
  unclosed,
  palette,
}: {
  lang: string;
  code: string;
  unclosed?: boolean;
  palette: CodexPalette;
}) {
  const tokens = useMemo(() => tokenizeCode(code, lang), [code, lang]);

  const handleShareCode = () => {
    Share.share({ message: code }).catch(() => {});
  };

  return (
    <View style={[styles.codeBlock, { backgroundColor: palette.codeBg, borderColor: palette.border }]}>
      <View
        style={[
          styles.codeHead,
          { backgroundColor: palette.codeHeader, borderBottomColor: palette.border },
        ]}
      >
        <Text style={{ color: palette.textSecondary, fontSize: 11, fontFamily: palette.mono }}>
          {lang || "code"}
          {unclosed ? " · 生成中" : ""}
        </Text>
        <TouchableOpacity
          style={[styles.codeActionBtn, { backgroundColor: palette.surface, borderColor: palette.border }]}
          onPress={handleShareCode}
          activeOpacity={0.7}
        >
          <Text style={{ color: palette.textSecondary, fontSize: 10.5, fontWeight: "600" }}>复制/分享</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={[styles.codePre, { fontFamily: palette.mono, color: palette.codeText }]}>
          {tokens.map((tok, idx) => (
            <Text
              key={idx}
              style={{
                color: getTokenColor(tok.kind, palette),
                fontStyle: tok.kind === "comment" ? "italic" : "normal",
              }}
            >
              {tok.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
});

function renderBlocks(
  blocks: MarkdownBlock[],
  palette: CodexPalette,
  keyPrefix: string,
  streaming: boolean,
  onPressFilePath?: (filePath: string) => void
): React.ReactNode[] {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-b-${idx}`;
    const isLast = idx === blocks.length - 1;
    const cursor = streaming && isLast ? " ▍" : "";

    switch (block.type) {
      case "heading": {
        const headingStyle: TextStyle =
          block.level === 1
            ? styles.h1
            : block.level === 2
            ? styles.h2
            : block.level === 3
            ? styles.h3
            : styles.h4;
        return (
          <View
            key={key}
            style={[
              styles.headingWrap,
              block.level <= 2 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingBottom: 4 } : undefined,
            ]}
          >
            <Text selectable style={[headingStyle, { color: palette.text }]}>
              {renderInlineNodes(block.children, palette, key, onPressFilePath)}
              {cursor}
            </Text>
          </View>
        );
      }

      case "paragraph":
        return (
          <Text key={key} selectable style={[styles.paragraph, { color: palette.text }]}>
            {renderInlineNodes(block.children, palette, key, onPressFilePath)}
            {cursor}
          </Text>
        );

      case "code":
        return (
          <CodeBlockView
            key={key}
            lang={block.lang}
            code={block.code}
            unclosed={block.unclosed}
            palette={palette}
          />
        );

      case "hr":
        return <View key={key} style={[styles.hr, { backgroundColor: palette.borderStrong }]} />;

      case "blockquote":
        return (
          <View
            key={key}
            style={[
              styles.blockquote,
              {
                borderLeftColor: palette.borderStrong,
                backgroundColor: palette.surface2,
              },
            ]}
          >
            {renderBlocks(block.blocks, palette, key, streaming && isLast, onPressFilePath)}
          </View>
        );

      case "list": {
        let ordCounter = block.start || 1;
        return (
          <View key={key} style={styles.listWrap}>
            {block.items.map((item, itemIdx) => {
              const itemKey = `${key}-li-${itemIdx}`;
              const isLastItem = isLast && itemIdx === block.items.length - 1;
              const indentPx = Math.min(item.indent, 4) * 14;
              const bulletText = block.ordered
                ? `${ordCounter++}.`
                : item.indent > 0
                ? "◦"
                : "•";
              return (
                <View key={itemKey} style={[styles.listRow, { paddingLeft: indentPx }]}>
                  {item.checked !== null ? (
                    <View
                      style={[
                        styles.checkBox,
                        {
                          borderColor: item.checked ? palette.ok : palette.borderStrong,
                          backgroundColor: item.checked ? palette.okSoft : "transparent",
                        },
                      ]}
                    >
                      <Text style={{ color: palette.ok, fontSize: 10, fontWeight: "800" }}>
                        {item.checked ? "✓" : ""}
                      </Text>
                    </View>
                  ) : (
                    <Text
                      style={[
                        styles.listBullet,
                        {
                          color: palette.textSecondary,
                          fontFamily: block.ordered ? palette.mono : undefined,
                        },
                      ]}
                    >
                      {bulletText}
                    </Text>
                  )}
                  <Text
                    selectable
                    style={[
                      styles.listText,
                      {
                        color: item.checked ? palette.textTertiary : palette.text,
                        textDecorationLine: item.checked ? "line-through" : "none",
                      },
                    ]}
                  >
                    {renderInlineNodes(item.children, palette, itemKey, onPressFilePath)}
                    {streaming && isLastItem ? " ▍" : ""}
                  </Text>
                </View>
              );
            })}
          </View>
        );
      }

      case "table":
        return (
          <ScrollView
            key={key}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.tableScroll, { borderColor: palette.border, backgroundColor: palette.surface }]}
          >
            <View>
              <View
                style={[
                  styles.tableRow,
                  { backgroundColor: palette.surface2, borderBottomColor: palette.borderStrong },
                ]}
              >
                {block.headers.map((cell, cIdx) => (
                  <View key={cIdx} style={styles.tableCell}>
                    <Text
                      selectable
                      style={[
                        styles.tableHeadText,
                        { color: palette.text, textAlign: block.alignments[cIdx] || "left" },
                      ]}
                    >
                      {renderInlineNodes(cell, palette, `${key}-th-${cIdx}`, onPressFilePath)}
                    </Text>
                  </View>
                ))}
              </View>
              {block.rows.map((row, rIdx) => (
                <View
                  key={rIdx}
                  style={[
                    styles.tableRow,
                    rIdx < block.rows.length - 1
                      ? { borderBottomColor: palette.border }
                      : { borderBottomWidth: 0 },
                  ]}
                >
                  {row.map((cell, cIdx) => (
                    <View key={cIdx} style={styles.tableCell}>
                      <Text
                        selectable
                        style={[
                          styles.tableCellText,
                          { color: palette.text, textAlign: block.alignments[cIdx] || "left" },
                        ]}
                      >
                        {renderInlineNodes(cell, palette, `${key}-td-${rIdx}-${cIdx}`, onPressFilePath)}
                      </Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
        );

      default:
        return null;
    }
  });
}

export const MarkdownView = React.memo(function MarkdownView({
  content,
  palette,
  streaming = false,
  onPressFilePath,
}: Props) {
  const blocks = useMemo(() => parseMarkdown(content || ""), [content]);

  if (blocks.length === 0) {
    if (!streaming) return null;
    return (
      <Text style={[styles.paragraph, { color: palette.textSecondary }]}>
        正在生成回复... ▍
      </Text>
    );
  }

  return (
    <View style={styles.root}>
      {renderBlocks(blocks, palette, "md", streaming, onPressFilePath)}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: 8 },
  headingWrap: { marginTop: 4, marginBottom: 1 },
  h1: { fontSize: 19, fontWeight: "700", lineHeight: 26, letterSpacing: -0.2 },
  h2: { fontSize: 17, fontWeight: "700", lineHeight: 24, letterSpacing: -0.15 },
  h3: { fontSize: 15.5, fontWeight: "700", lineHeight: 22 },
  h4: { fontSize: 14.5, fontWeight: "700", lineHeight: 21 },
  paragraph: { fontSize: 14.5, lineHeight: 23 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: { fontSize: 12.5, borderRadius: 4 },
  fileLink: { fontSize: 12.5, fontWeight: "600", borderRadius: 4 },
  urlLink: { textDecorationLine: "underline", fontWeight: "600" },
  codeBlock: {
    borderRadius: 11,
    borderWidth: 1,
    overflow: "hidden",
    marginVertical: 2,
  },
  codeHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    gap: 8,
  },
  codeActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  codePre: {
    paddingHorizontal: 11,
    paddingVertical: 10,
    fontSize: 12,
    lineHeight: 18.5,
  },
  hr: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 6,
  },
  blockquote: {
    borderLeftWidth: 2.5,
    paddingLeft: 11,
    paddingRight: 10,
    paddingVertical: 7,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    gap: 6,
  },
  listWrap: { gap: 5 },
  listRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 7,
  },
  listBullet: {
    fontSize: 13.5,
    lineHeight: 23,
    minWidth: 16,
    textAlign: "right",
    fontWeight: "600",
  },
  checkBox: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  listText: {
    flex: 1,
    fontSize: 14.5,
    lineHeight: 23,
  },
  tableScroll: {
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 2,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tableCell: {
    minWidth: 96,
    maxWidth: 240,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  tableHeadText: {
    fontSize: 12.5,
    fontWeight: "700",
    lineHeight: 18,
  },
  tableCellText: {
    fontSize: 12.5,
    lineHeight: 18,
  },
});
