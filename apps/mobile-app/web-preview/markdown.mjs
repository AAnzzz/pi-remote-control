/**
 * Safe DOM-only Markdown & Syntax Highlighter for PI Remote Companion.
 * Zero innerHTML, zero eval, zero external dependencies.
 */

const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|async|await|import|export|from|if|else|for|while|switch|case|break|try|catch|finally|throw|new|class|extends|interface|type|func|package|defer|go|select|struct|def|elif|True|False|None|null|true|false|undefined)\b|\b\d+(?:\.\d+)?\b)/g;

function appendHighlightedCode(preEl, codeText) {
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(codeText)) !== null) {
    if (match.index > lastIndex) {
      preEl.appendChild(document.createTextNode(codeText.slice(lastIndex, match.index)));
    }
    const tok = match[0];
    const span = document.createElement("span");
    if (tok.startsWith("//") || tok.startsWith("/*") || tok.startsWith("#")) {
      span.className = "tok-cmt";
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
      span.className = "tok-str";
    } else if (/^\d/.test(tok)) {
      span.className = "tok-num";
    } else {
      span.className = "tok-kw";
    }
    span.textContent = tok;
    preEl.appendChild(span);
    lastIndex = match.index + tok.length;
  }
  if (lastIndex < codeText.length) {
    preEl.appendChild(document.createTextNode(codeText.slice(lastIndex)));
  }
}

function appendInline(parent, text) {
  const inlineRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m;
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const full = m[0];
    if (full.startsWith("`")) {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = full.slice(1, -1);
      parent.appendChild(code);
    } else if (full.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = full.slice(2, -2);
      parent.appendChild(strong);
    } else if (full.startsWith("*")) {
      const em = document.createElement("em");
      em.textContent = full.slice(1, -1);
      parent.appendChild(em);
    } else if (m[2] && m[3]) {
      const a = document.createElement("a");
      a.textContent = m[2];
      a.href = m[3];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    }
    last = m.index + full.length;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}

export function renderMarkdownToDom(container, markdownText) {
  while (container.firstChild) container.removeChild(container.firstChild);
  const src = String(markdownText || "").replace(/\r\n/g, "\n");
  if (!src) return;

  const lines = src.split("\n");
  let i = 0;

  const isFenceStart = (l) => /^```/.test(l.trim());
  const isHr = (l) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim());
  const isHeading = (l) => /^(#{1,3})\s+(.+)$/.test(l);
  const isQuote = (l) => /^>\s?/.test(l);
  const isUl = (l) => /^\s*[-*•]\s+/.test(l);
  const isOl = (l) => /^\s*\d+\.\s+/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (isFenceStart(line)) {
      const langMatch = /^```([^\s`]*)/.exec(line.trim());
      const lang = (langMatch && langMatch[1]) || "code";
      i += 1;
      const codeLines = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;

      const codeStr = codeLines.join("\n");
      const wrap = document.createElement("div");
      wrap.className = "md-code-block";

      const head = document.createElement("div");
      head.className = "md-code-head";
      const langEl = document.createElement("span");
      langEl.textContent = lang;
      const copyBtn = document.createElement("button");
      copyBtn.className = "md-copy-btn";
      copyBtn.type = "button";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(codeStr);
          copyBtn.textContent = "已复制 ✓";
          setTimeout(() => { copyBtn.textContent = "复制"; }, 1400);
        } catch {
          copyBtn.textContent = "复制失败";
        }
      });
      head.append(langEl, copyBtn);

      const pre = document.createElement("pre");
      pre.className = "md-code-pre";
      appendHighlightedCode(pre, codeStr);

      wrap.append(head, pre);
      container.appendChild(wrap);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (isHr(line)) {
      container.appendChild(document.createElement("hr"));
      i += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const tag = heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3";
      const h = document.createElement(tag);
      appendInline(h, heading[2]);
      container.appendChild(h);
      i += 1;
      continue;
    }

    if (isQuote(line)) {
      const bq = document.createElement("blockquote");
      const qLines = [];
      while (i < lines.length && isQuote(lines[i])) {
        qLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      appendInline(bq, qLines.join("\n"));
      container.appendChild(bq);
      continue;
    }

    if (isUl(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && isUl(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\s*[-*•]\s+/, ""));
        ul.appendChild(li);
        i += 1;
      }
      container.appendChild(ul);
      continue;
    }

    if (isOl(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && isOl(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
        ol.appendChild(li);
        i += 1;
      }
      container.appendChild(ol);
      continue;
    }

    // Paragraph (coalesce consecutive plain lines; guaranteed to consume at least 1 line)
    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFenceStart(lines[i]) &&
      !isHeading(lines[i]) &&
      !isQuote(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !isHr(lines[i])
    ) {
      pLines.push(lines[i]);
      i += 1;
    }
    if (pLines.length === 0) {
      pLines.push(lines[i]);
      i += 1;
    }
    const p = document.createElement("p");
    pLines.forEach((pl, idx) => {
      if (idx > 0) p.appendChild(document.createElement("br"));
      appendInline(p, pl);
    });
    container.appendChild(p);
  }
}
