// Data only: callers decide how to display a block or open a link.
const styleNames = { "**": "bold", "__": "bold", "*": "italic", "_": "italic", "~~": "strike" };
const wordChar = /[A-Za-z0-9_]/;
const maxDepth = 64;

function appendText(nodes, text) {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last && last.type === "text") last.text += text;
  else nodes.push({ type: "text", text });
}

// Only an equal-length backtick run closes a code span. Indexing runs avoids
// rescanning the remaining paragraph on every unfinished streaming delimiter.
function indexTickRuns(text) {
  const next = new Map();
  const last = new Map();
  const runs = /`+/g;
  let match;
  while ((match = runs.exec(text))) {
    const width = match[0].length;
    if (last.has(width)) next.set(last.get(width), match.index);
    last.set(width, match.index);
  }
  return next;
}

function labelText(nodes) {
  return nodes.map(node => node.children ? labelText(node.children) :
    node.type === "code" ? node.code : node.type === "break" ? " " : node.text).join("");
}

// Accept only absolute file paths and HTTP(S). Never normalize backslashes or
// decode escapes in a destination: PI-Desktop appends :line to native paths.
function readLink(text, start) {
  let boundary = start + 1;
  while (boundary < text.length && !"[]\n".includes(text[boundary])) boundary++;
  if (!text.startsWith("](", boundary)) return null;
  const label = text.slice(start + 1, boundary);
  let pos = boundary + 2;
  let href;
  if (text[pos] === "<") {
    const end = text.indexOf(">", pos + 1);
    if (end < 0 || text[end + 1] !== ")") return null;
    href = text.slice(pos + 1, end);
    pos = end + 1;
  } else {
    const from = pos;
    let depth = 0;
    for (; pos < text.length; pos++) {
      const c = text[pos];
      if (/\s/.test(c)) return null;
      if (c === "(") depth++;
      if (c === ")") {
        if (!depth) break;
        depth--;
      }
    }
    if (pos === text.length) return null;
    href = text.slice(from, pos);
  }
  if (/[\x00-\x1f]/.test(href)) return null;
  const kind = /^https?:\/\/[^\s/]+/i.test(href) ? "url" : /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(href) ? "file" : null;
  if (!kind) return null;
  return { end: pos + 1, node: { type: "link", label: labelText(inline(label, false)), href, kind } };
}

function inline(text, allowLinks) {
  const frames = [{ children: [] }];
  const nextTick = indexTickRuns(text);
  let pos = 0;
  while (pos < text.length) {
    const frame = frames[frames.length - 1];
    const nodes = frame.children;
    const c = text[pos];
    if (c === "\n") {
      nodes.push({ type: "break" });
      pos++;
    } else if (c === "\\" && /[\\`*_~\[\]|]/.test(text.charAt(pos + 1))) {
      appendText(nodes, text[pos + 1]);
      pos += 2;
    } else if (c === "`") {
      let end = pos + 1;
      while (text[end] === "`") end++;
      const close = nextTick.get(pos);
      if (close !== undefined) {
        let code = text.slice(end, close).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && /[^ ]/.test(code)) code = code.slice(1, -1);
        nodes.push({ type: "code", code });
        pos = close + (end - pos);
      } else {
        appendText(nodes, text.slice(pos, end));
        pos = end;
      }
    } else if (c === "[" && allowLinks) {
      const link = readLink(text, pos);
      if (link) {
        nodes.push(link.node);
        pos = link.end;
      } else {
        appendText(nodes, c);
        pos++;
      }
    } else if (c === "*" || c === "_" || c === "~") {
      const closing = frame.mark && text.startsWith(frame.mark, pos);
      const mark = closing ? frame.mark : text[pos + 1] === c ? c + c : c;
      const before = text.charAt(pos - 1);
      const after = text.charAt(pos + mark.length);
      const intraword = c === "_" && wordChar.test(before) && wordChar.test(after);
      if (!intraword && closing && before && !/\s/.test(before)) {
        frames.pop();
        frames[frames.length - 1].children.push({ type: styleNames[mark], children: nodes });
      } else if (!intraword && styleNames[mark] && after && !/\s/.test(after) && frames.length < maxDepth) {
        frames.push({ mark, children: [] });
      } else appendText(nodes, mark);
      pos += mark.length;
    } else {
      let end = pos + 1;
      while (end < text.length && !"\n\\`[*_~".includes(text[end])) end++;
      appendText(nodes, text.slice(pos, end));
      pos = end;
    }
  }
  // An opening marker at end-of-stream remains visible as literal text.
  while (frames.length > 1) {
    const frame = frames.pop();
    const parent = frames[frames.length - 1].children;
    appendText(parent, frame.mark);
    for (const node of frame.children) {
      if (node.type === "text") appendText(parent, node.text);
      else parent.push(node);
    }
  }
  return frames[0].children;
}

export function parseInline(text) {
  return inline(text.replace(/\r\n?/g, "\n"), true);
}

const fence = /^ {0,3}(`{3,})([^`]*)$/;
const closingFence = /^ {0,3}(`{3,})[ \t]*$/;
const heading = /^ {0,3}(#{1,4})(?:[ \t]+(.*)|$)/;
const quote = /^ {0,3}>[ \t]?/;
const rule = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const listItem = /^([ \t]*)([-*+•]|([0-9]{1,9})\.)(?:[ \t]+(.*)|$)/;

function cells(line) {
  const fields = [];
  const source = line.trim();
  let start = source[0] === "|" ? 1 : 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "|") {
      fields.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < source.length) fields.push(source.slice(start).trim());
  return fields;
}

function readTable(lines, index) {
  const sep = lines[index + 1];
  if (!sep || !lines[index].includes("|") || !/^[\s|:-]+$/.test(sep)) return null;
  const separators = cells(sep);
  if (!separators.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  const headers = cells(lines[index]);
  if (headers.length !== separators.length) return null;
  const alignments = separators.map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left");
  return { type: "table", headers: headers.map(parseInline), alignments, rows: [] };
}

function blocksFrom(lines, depth) {
  const blocks = [];
  let paragraph = [];
  function flush() {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let match, table;
    if (!line.trim()) {
      flush();
      i++;
    } else if ((match = fence.exec(line))) {
      flush();
      const start = ++i;
      while (i < lines.length && (closingFence.exec(lines[i])?.[1].length || 0) < match[1].length) i++;
      const code = lines.slice(start, i).join("\n");
      const unclosed = i === lines.length;
      blocks.push({ type: "code", lang: match[2].trim().split(/\s/)[0], code, ...(unclosed ? { unclosed: true } : {}) });
      if (!unclosed) i++;
    } else if ((match = heading.exec(line))) {
      flush();
      blocks.push({ type: "heading", level: match[1].length, children: parseInline((match[2] || "").replace(/\s+#+\s*$/, "").trim()) });
      i++;
    } else if (depth < maxDepth && quote.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length && quote.test(lines[i])) inner.push(lines[i++].replace(quote, ""));
      blocks.push({ type: "blockquote", blocks: blocksFrom(inner, depth + 1) });
    } else if (rule.test(line)) {
      flush();
      blocks.push({ type: "hr" });
      i++;
    } else if ((match = listItem.exec(line))) {
      flush();
      const ordered = !!match[3];
      const start = ordered ? Number(match[3]) : 1;
      const widths = [];
      const items = [];
      while (match) {
        const width = match[1].replace(/\t/g, "    ").length;
        if (items.length && width <= widths[0] && !!match[3] !== ordered) break;
        while (widths.length && widths[widths.length - 1] > width) widths.pop();
        if (widths[widths.length - 1] !== width) widths.push(width);
        const body = match[4] || "";
        const task = /^\[([ xX])\](?:\s+|$)/.exec(body);
        items.push({ checked: task ? task[1] !== " " : null, indent: widths.length - 1,
          children: parseInline(task ? body.slice(task[0].length) : body) });
        i++;
        match = i < lines.length && !rule.test(lines[i]) && listItem.exec(lines[i]);
      }
      blocks.push({ type: "list", ordered, start, items });
    } else if ((table = readTable(lines, i))) {
      flush();
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !fence.test(lines[i]) && !heading.test(lines[i]) && !quote.test(lines[i]) && !listItem.test(lines[i])) {
        const row = cells(lines[i++]);
        table.rows.push(table.headers.map((_, col) => parseInline(row[col] || "")));
      }
      blocks.push(table);
    } else {
      paragraph.push(line.trim());
      i++;
    }
  }
  flush();
  return blocks;
}

export function parseMarkdown(source) {
  return blocksFrom(source.replace(/\r\n?/g, "\n").split("\n"), 0);
}

const keywords = new Set(("as async await break case catch class const continue def default defer delete do else elif enum " +
  "export extends false finally fn for from func function go if implements import in instanceof interface let match " +
  "new null package pass private public raise return static struct switch this throw true try type typeof var while yield").split(" "));
const types = new Set("any bigint bool boolean byte char double float int long number object str string unknown void".split(" "));

// One forward cursor. Delimiters inside a string/comment never restart the lexer.
export function tokenizeCode(code, lang = "") {
  const tokens = [];
  const hashComments = /^(?:py(?:thon)?|sh|bash|zsh|shell|powershell|ps1|ya?ml|rb|ruby|r|toml|)$/i.test(lang);
  const slashComments = !/^(?:py(?:thon)?|sh|bash|zsh|shell|ya?ml|json)$/i.test(lang);
  let i = 0, plainStart = 0;
  while (i < code.length) {
    const start = i;
    const c = code[i++];
    let kind = "plain";
    if ((hashComments && c === "#") || (slashComments && c === "/" && code[i] === "/")) {
      kind = "comment";
      const end = code.indexOf("\n", i);
      i = end < 0 ? code.length : end;
    } else if (slashComments && c === "/" && code[i] === "*") {
      kind = "comment";
      const end = code.indexOf("*/", i + 1);
      i = end < 0 ? code.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      kind = "string";
      while (i < code.length) {
        const ch = code[i++];
        if (ch === c) break;
        if (ch === "\\" && i < code.length) i++;
      }
    } else if (/[0-9]/.test(c)) {
      kind = "number";
      if (c === "0" && /[xX]/.test(code.charAt(i))) {
        i++;
        while (/[a-fA-F0-9_]/.test(code.charAt(i))) i++;
      } else {
        while (/[0-9_]/.test(code.charAt(i))) i++;
        if (code[i] === "." && /[0-9]/.test(code.charAt(i + 1))) {
          i++;
          while (/[0-9_]/.test(code.charAt(i))) i++;
        }
      }
    } else if (/[A-Za-z_$]/.test(c)) {
      while (/[A-Za-z0-9_$]/.test(code.charAt(i))) i++;
      const word = code.slice(start, i);
      if (keywords.has(word)) kind = "keyword";
      else if (types.has(word) || /[A-Z]/.test(c)) kind = "type";
    }
    if (kind !== "plain") {
      if (start > plainStart) tokens.push({ kind: "plain", text: code.slice(plainStart, start) });
      tokens.push({ kind, text: code.slice(start, i) });
      plainStart = i;
    }
  }
  if (plainStart < i) tokens.push({ kind: "plain", text: code.slice(plainStart) });
  return tokens;
}
