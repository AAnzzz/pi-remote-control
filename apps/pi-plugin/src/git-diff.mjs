/**
 * Read-only, root-contained Git status & structured unified diff parser for mobile review.
 * - Uses execFile("git", ..., { shell: false }) with 5s timeout & GIT_OPTIONAL_LOCKS=0
 * - Enforces realpath containment inside authorized project root (blocks symlink/junction escape)
 * - Enforces credential deny-list (.env*, .ssh/, *.pem, .git/**)
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isDeniedCredentialPath } from "./vendor/protocol/index.mjs";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 5000;

function runGit(cwd, args) {
  return execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_DIFF_BYTES * 2,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
    },
  });
}

export function resolveSafeProjectPath(projectRoot, relPath) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new Error("Missing project root");
  }
  if (isDeniedCredentialPath(relPath)) {
    throw new Error(`Access denied for credential or traversal path: ${relPath}`);
  }
  const realRoot = fs.realpathSync(projectRoot);
  const candidate = path.resolve(realRoot, relPath);
  const relFromRoot = path.relative(realRoot, candidate);
  if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    throw new Error("Path escapes project root");
  }
  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    const realRel = path.relative(realRoot, realCandidate);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      throw new Error("Symlink/junction target escapes project root");
    }
  }
  return { realRoot, candidate, normalizedRel: relFromRoot.replace(/\\/g, "/") };
}

export async function getGitDiffSummary(projectRoot) {
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    return { isRepo: false, branch: "", files: [] };
  }
  let branch = "";
  try {
    const { stdout } = await runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    branch = stdout.trim();
  } catch {
    return { isRepo: false, branch: "", files: [] };
  }

  let statusOut = "";
  try {
    const res = await runGit(projectRoot, ["status", "--porcelain=v1", "-uall"]);
    statusOut = res.stdout;
  } catch {
    return { isRepo: true, branch, files: [] };
  }

  const numstatMap = new Map();
  for (const extraArgs of [["diff", "--numstat"], ["diff", "--cached", "--numstat"]]) {
    try {
      const { stdout } = await runGit(projectRoot, extraArgs);
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const add = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
        const del = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
        const filePath = parts.slice(2).join("\t");
        const prev = numstatMap.get(filePath) || { additions: 0, deletions: 0 };
        numstatMap.set(filePath, { additions: prev.additions + add, deletions: prev.deletions + del });
      }
    } catch {
      // ignore numstat errors on unborn HEAD
    }
  }

  const files = [];
  for (const rawLine of statusOut.split(/\r?\n/)) {
    if (!rawLine || rawLine.length < 4) continue;
    const x = rawLine[0];
    const y = rawLine[1];
    let relPath = rawLine.slice(3).trim();
    if (relPath.includes(" -> ")) {
      relPath = relPath.split(" -> ").pop().trim();
    }
    if (relPath.startsWith('"') && relPath.endsWith('"')) {
      relPath = relPath.slice(1, -1);
    }
    if (isDeniedCredentialPath(relPath)) continue;

    const staged = x !== " " && x !== "?";
    const status = x === "?" ? "?" : x !== " " ? x : y;
    const counts = numstatMap.get(relPath) || { additions: 0, deletions: 0 };
    files.push({
      path: relPath,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      staged,
    });
  }

  return { isRepo: true, branch, files: files.slice(0, 300) };
}

export function parseUnifiedDiffToHunks(diffText) {
  const hunks = [];
  const lines = diffText.split(/\r?\n/);
  let current = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push({ type: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.lines.push({ type: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return hunks;
}

export async function getGitFilePatch(projectRoot, relPath) {
  const { candidate, normalizedRel } = resolveSafeProjectPath(projectRoot, relPath);
  let rawDiff = "";
  try {
    const res = await runGit(projectRoot, ["diff", "HEAD", "--unified=3", "--", normalizedRel]);
    rawDiff = res.stdout;
  } catch {
    try {
      const res = await runGit(projectRoot, ["diff", "--unified=3", "--", normalizedRel]);
      rawDiff = res.stdout;
    } catch {
      rawDiff = "";
    }
  }

  if (rawDiff.includes("Binary files ") && rawDiff.includes(" differ")) {
    return { path: normalizedRel, status: "M", binary: true, truncated: false, hunks: [] };
  }

  // Handle untracked new file safely
  if (!rawDiff && fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return { path: normalizedRel, status: "?", binary: false, truncated: false, hunks: [] };
    }
    const truncated = stat.size > MAX_DIFF_BYTES;
    const buf = Buffer.alloc(Math.min(stat.size, MAX_DIFF_BYTES));
    const fd = fs.openSync(candidate, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.includes(0)) {
      return { path: normalizedRel, status: "?", binary: true, truncated: false, hunks: [] };
    }
    const textLines = buf.toString("utf8").split(/\r?\n/);
    return {
      path: normalizedRel,
      status: "A",
      binary: false,
      truncated,
      hunks: [
        {
          header: `@@ -0,0 +1,${textLines.length} @@ (new file)`,
          lines: textLines.map((text, idx) => ({
            type: "add",
            oldLine: null,
            newLine: idx + 1,
            text,
          })),
        },
      ],
    };
  }

  const truncated = Buffer.byteLength(rawDiff, "utf8") > MAX_DIFF_BYTES;
  const bounded = truncated ? rawDiff.slice(0, MAX_DIFF_BYTES) : rawDiff;
  return {
    path: normalizedRel,
    status: "M",
    binary: false,
    truncated,
    hunks: parseUnifiedDiffToHunks(bounded),
  };
}
