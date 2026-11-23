/**
 * PI-Desktop Agent Sidecar Extension (runs inside agent-runtime/sidecar.js).
 * Subscribes to live streaming & tool execution events and forwards them to the plugin's
 * loopback-only ingress endpoint discovered via plugin private data directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BRIDGE_FILE = path.join(
  os.homedir(),
  ".pi-desktop",
  "plugins",
  "data",
  "local.pi-remote-app",
  "stream-bridge.json"
);

let cachedBridge = null;
let lastReadAt = 0;

function getBridgeConfig() {
  const now = Date.now();
  if (cachedBridge && now - lastReadAt < 2000) return cachedBridge;
  lastReadAt = now;
  try {
    if (!fs.existsSync(BRIDGE_FILE)) {
      cachedBridge = null;
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
    if (parsed && typeof parsed.port === "number" && typeof parsed.token === "string") {
      cachedBridge = parsed;
      return parsed;
    }
  } catch {
    cachedBridge = null;
  }
  return null;
}

function resolveSessionId(event, ctx) {
  try {
    const fromMgr = ctx?.sessionManager?.getSessionId?.();
    if (typeof fromMgr === "string" && fromMgr.length > 0) return fromMgr;
  } catch {
    // ignore
  }
  if (typeof event?.sessionId === "string" && event.sessionId.length > 0) return event.sessionId;
  if (typeof ctx?.sessionId === "string" && ctx.sessionId.length > 0) return ctx.sessionId;
  return null;
}

function sanitizeEventForBridge(type, event) {
  if (!event || typeof event !== "object") return event;
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    const toolName = event.toolName || event.name || "";
    const keepStructured =
      toolName === "TodoWrite" ||
      toolName === "Bash" ||
      toolName === "Task" ||
      toolName === "TaskWait" ||
      toolName === "TaskStop" ||
      toolName === "TaskList";
    return {
      toolCallId: event.toolCallId || event.id || null,
      toolName,
      name: toolName,
      isError: Boolean(event.isError),
      args: keepStructured ? (event.args ?? event.input) : undefined,
      result: keepStructured ? (event.result ?? event.output) : undefined,
      output: typeof event.output === "string" ? event.output.slice(0, 1200) : undefined,
    };
  }
  return event;
}

function forwardEvent(type, event, ctx) {
  const cfg = getBridgeConfig();
  if (!cfg) return;
  const sessionId = resolveSessionId(event, ctx);
  if (!sessionId) return;
  const payload = {
    type,
    sessionId,
    turnId: event?.turnId || ctx?.turnId || null,
    event: sanitizeEventForBridge(type, event),
  };
  fetch(`http://127.0.0.1:${cfg.port}/internal/stream-event`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-token": cfg.token,
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // plugin background service may be restarting
  });
}

export default function registerRemoteStreamBridge(pi) {
  if (!pi || typeof pi.on !== "function") return;
  const events = [
    "turn_start",
    "turn_end",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_end",
  ];
  for (const name of events) {
    pi.on(name, (event, ctx) => {
      forwardEvent(name, event, ctx);
    });
  }
}
