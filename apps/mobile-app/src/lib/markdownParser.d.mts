export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "strike"; children: InlineNode[] }
  | { type: "code"; code: string }
  | { type: "link"; label: string; href: string; kind: "url" | "file" }
  | { type: "break" };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "code"; lang: string; code: string; unclosed?: boolean }
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "list"; ordered: boolean; start: number; items: Array<{
      checked: boolean | null; indent: number; children: InlineNode[];
    }> }
  | { type: "table"; headers: InlineNode[][]; alignments: Array<"left" | "center" | "right">; rows: InlineNode[][][] }
  | { type: "hr" };

export type CodeToken = {
  kind: "plain" | "keyword" | "string" | "comment" | "number" | "type";
  text: string;
};

export function parseMarkdown(source: string): MarkdownBlock[];
export function parseInline(text: string): InlineNode[];
export function tokenizeCode(code: string, lang?: string): CodeToken[];
