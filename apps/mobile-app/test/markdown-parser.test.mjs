import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline, tokenizeCode } from "../src/lib/markdownParser.mjs";

const text = text => ({ type: "text", text });
const code = code => ({ type: "code", code });
const bold = (...children) => ({ type: "bold", children });
const paragraph = (...children) => ({ type: "paragraph", children });
const br = { type: "break" };
const link = (kind, href, label) => ({ type: "link", kind, href, label });
const item = (indent, checked, ...children) => ({ indent, checked, children });

test("headings 1–4 interrupt paragraphs; CRLF and blank lines delimit blocks", () => {
  const levels = [1, 2, 3, 4];
  assert.deepEqual(parseMarkdown(" \r\n"), []);
  assert.deepEqual(parseMarkdown(levels.map(n => `${"#".repeat(n)} **Title**`).join("\r\n") + "\nline one\nline two\n\nlast"), [
    ...levels.map(level => ({ type: "heading", level, children: [bold(text("Title"))] })),
    paragraph(text("line one"), br, text("line two")), paragraph(text("last")),
  ]);
});

test("inline formatting preserves identifiers and protects nested code spans", () => {
  assert.deepEqual(parseInline("**`v1.0.0`** __bold__ *italic* _also_ ~~old~~ foo_bar_baz"), [
    bold(code("v1.0.0")), text(" "), bold(text("bold")), text(" "),
    { type: "italic", children: [text("italic")] }, text(" "), { type: "italic", children: [text("also")] },
    text(" "), { type: "strike", children: [text("old")] }, text(" foo_bar_baz"),
  ]);
  assert.deepEqual(parseInline("`` `**x**` `` and `~~y~~`"), [code("`**x**`"), text(" and "), code("~~y~~")]);
  assert.deepEqual(parseInline("**still `typing"), [text("**still `typing")]);
  assert.deepEqual(parseInline("\\*literal\\*"), [text("*literal*")]);
});

test("URL and absolute file links preserve their destinations and flatten formatted labels", () => {
  const win = String.raw`D:\work\pi app\apps\pi-plugin\views\index.html:12`;
  for (const [label, href, kind, expected, angle] of [
    ["**`index.html`**", win, "file", "index.html", true],
    ["src", "D:/work/file.ts:42", "file", "src", false],
    ["line 10", "/workspace/src/a.ts:10", "file", "line 10", false],
    ["**docs**", "https://example.org/ref_(api)", "url", "docs", false],
    ["test", "http://127.0.0.1:8080/", "url", "test", false],
  ]) {
    assert.deepEqual(parseInline(`[${label}](${angle ? `<${href}>` : href})`), [link(kind, href, expected)]);
  }
  for (const source of ["[bad](javascript:alert(1))", "[bad](//other.host/x)", "[partial](<D:/dir/file"]) {
    assert.deepEqual(parseInline(source), [text(source)]);
  }
});

test("mixed bullet markers, indentation and task checkboxes retain structure", () => {
  assert.deepEqual(parseMarkdown("- [x] done\n  * **a**\n    + [ ] todo\n  • note\n- end\n7. seven\n8. eight"), [
    { type: "list", ordered: false, start: 1, items: [item(0, true, text("done")), item(1, null, bold(text("a"))),
      item(2, false, text("todo")), item(1, null, text("note")), item(0, null, text("end"))] },
    { type: "list", ordered: true, start: 7, items: [item(0, null, text("seven")), item(0, null, text("eight"))] },
  ]);
});

test("multi-line and nested quotes contain blocks; spaced and unspaced rules end them", () => {
  assert.deepEqual(parseMarkdown("> first\n> second\n>\n> > inner\n> > - detail\n* * *\n___\n---"), [
    { type: "blockquote", blocks: [paragraph(text("first"), br, text("second")),
      { type: "blockquote", blocks: [paragraph(text("inner")), { type: "list", ordered: false, start: 1, items: [item(0, null, text("detail"))] }] }] },
    { type: "hr" }, { type: "hr" }, { type: "hr" },
  ]);
});

test("GFM tables parse alignment, escaped pipes and inline markup; pad missing cells", () => {
  assert.deepEqual(parseMarkdown("intro\n| **k** | v | n |\n| --- | :---: | ---: |\na\\|b | `x` | 1\nc | d\nend"), [
    paragraph(text("intro")),
    { type: "table", headers: [[bold(text("k"))], [text("v")], [text("n")]], alignments: ["left", "center", "right"],
      rows: [[[text("a|b")], [code("x")], [text("1")]], [[text("c")], [text("d")], []]] },
    paragraph(text("end")),
  ]);
  assert.equal(parseMarkdown("a | b\n--- | invalid")[0].type, "paragraph");
});

test("streaming code fences preserve literal text, indentation and trailing partial lines", () => {
  const prefix = "Before\n```ts\n";
  const body = "  const s = '**literal**';\n# not a heading\n";
  assert.deepEqual(parseMarkdown(prefix), [paragraph(text("Before")), { type: "code", lang: "ts", code: "", unclosed: true }]);
  assert.deepEqual(parseMarkdown(prefix + body), [paragraph(text("Before")), { type: "code", lang: "ts", code: body, unclosed: true }]);
  assert.deepEqual(parseMarkdown(prefix + body + "```\nafter"), [paragraph(text("Before")),
    { type: "code", lang: "ts", code: body.trimEnd() }, paragraph(text("after"))]);
  assert.deepEqual(parseMarkdown("````\n```\n````"), [{ type: "code", lang: "", code: "```" }]);
});

test("code tokenizer classifies lexemes without losing whitespace or interpreting string contents", () => {
  const source = 'const x: Thing = 3.25; // n\nreturn "\\\"//" /* ok */';
  const tokens = tokenizeCode(source, "ts");
  assert.equal(tokens.map(t => t.text).join(""), source);
  assert.deepEqual(tokens.filter(t => t.kind !== "plain").map(t => [t.kind, t.text]), [
    ["keyword", "const"], ["type", "Thing"], ["number", "3.25"], ["comment", "// n"],
    ["keyword", "return"], ["string", '"\\\"//"'], ["comment", "/* ok */"],
  ]);
  assert.deepEqual(tokenizeCode("# note", "python"), [{ kind: "comment", text: "# note" }]);
  assert.deepEqual(tokenizeCode(""), []);
});

test("50 KiB ordinary and unfinished code blocks tokenize losslessly", () => {
  for (const source of ["let i = 0;\n".repeat(5120).slice(0, 51200), "/*" + "*".repeat(51198), '"' + "\\".repeat(51199)]) {
    assert.equal(source.length, 51200);
    assert.equal(tokenizeCode(source, "js").map(t => t.text).join(""), source);
  }
});

test("PI-Desktop progress message retains Chinese prose, formatted status and both source links", () => {
  // Verbatim progress message from the PI-Desktop conversation for this change.
  const message = [
    "**会话恢复已验证。** 回环服务器清空会话后，适配器收到 `404`，重新握手并成功重试了一次。",
    "",
    String.raw`- [host-adapter.mjs](<D:\work\pi app\apps\pi-plugin\src\host-adapter.mjs:445>) 处理过期会话。`,
    String.raw`- [markdownParser.mjs](<D:\work\pi app\apps\mobile-app\src\lib\markdownParser.mjs:245>) 保留未闭合代码块的内容和 ` + "`unclosed` 标记。",
  ].join("\n");
  assert.deepEqual(parseMarkdown(message), [
    paragraph(bold(text("会话恢复已验证。")), text(" 回环服务器清空会话后，适配器收到 "), code("404"), text("，重新握手并成功重试了一次。")),
    { type: "list", ordered: false, start: 1, items: [
      item(0, null, link("file", String.raw`D:\work\pi app\apps\pi-plugin\src\host-adapter.mjs:445`, "host-adapter.mjs"), text(" 处理过期会话。")),
      item(0, null, link("file", String.raw`D:\work\pi app\apps\mobile-app\src\lib\markdownParser.mjs:245`, "markdownParser.mjs"), text(" 保留未闭合代码块的内容和 "), code("unclosed"), text(" 标记。")),
    ] },
  ]);
});
