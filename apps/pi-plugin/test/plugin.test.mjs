import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PluginVault } from "../src/vault.mjs";
import { PiHostAdapter } from "../src/host-adapter.mjs";
import { RemoteControlEngine } from "../src/remote-engine.mjs";
import { getGitDiffSummary, getGitFilePatch } from "../src/git-diff.mjs";
import {
  generateX25519KeyPair,
  computeSharedSecret,
  computeInviteProof,
  derivePairingMaterial,
  encryptEnvelope,
  decryptEnvelope,
  ReplayWindow,
  base64ToBytes,
} from "../src/vendor/protocol/index.mjs";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createMockPi(projectDir) {
  const promptCalls = [];
  const abortCalls = [];
  return {
    promptCalls,
    abortCalls,
    desktop: {
      async invoke({ operation, args }) {
        switch (operation) {
          case "project/list":
            return [{ path: projectDir, name: "demo-repo", active: true }];
          case "session/list":
            return [
              {
                id: "sess_1",
                title: "Refactor auth",
                projectPath: projectDir,
                status: "idle",
                updatedAt: "2026-11-21T10:00:00Z",
                model: "claude-sonnet",
              },
            ];
          case "session/get":
            return {
              id: args[0].id,
              title: "Refactor auth",
              projectPath: projectDir,
              status: "idle",
              messages: [{ id: "m1", role: "user", content: "Hello agent" }],
            };
          case "agent/prompt":
            promptCalls.push(args[0]);
            return { accepted: true, turnId: `turn_${promptCalls.length}` };
          case "agent/abort":
            abortCalls.push(args[0]);
            return { aborted: true };
          case "agent/pendingInteractive":
            return {
              permissions: [
                {
                  id: "perm_1",
                  toolName: "Bash",
                  risk: "high",
                  summary: "Run npm test",
                  args: { command: "npm test" },
                },
              ],
              asks: [],
            };
          case "plans/pending":
            return [];
          default:
            return {};
        }
      },
    },
  };
}

test("PluginVault encrypts at rest and refuses plaintext fallback when corrupted", () => {
  const dir = makeTempDir("pi-vault-test-");
  try {
    const v1 = new PluginVault(dir);
    v1.addDevice({
      deviceId: "dev_1",
      name: "iPhone",
      keyId: "kid1",
      sessionKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    const rawDisk = fs.readFileSync(path.join(dir, "vault.enc.json"), "utf8");
    assert.equal(rawDisk.includes("dev_1"), false, "deviceId must not appear in plaintext on disk");

    const v2 = new PluginVault(dir);
    assert.equal(v2.state.devices.dev_1.name, "iPhone");

    // Corrupt vault into plaintext JSON -> must throw
    fs.writeFileSync(path.join(dir, "vault.enc.json"), JSON.stringify({ hostId: "plaintext" }));
    assert.throws(() => new PluginVault(dir), /refusing plaintext downgrade/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Git diff lists modified files, parses unified hunks, and blocks .env & traversal", async () => {
  const repo = makeTempDir("pi-git-test-");
  try {
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "app.ts"), "const a = 1;\nconst b = 2;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    fs.writeFileSync(path.join(repo, "app.ts"), "const a = 1;\nconst b = 42;\nconst c = 3;\n");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET_KEY=supersecret\n");

    const summary = await getGitDiffSummary(repo);
    assert.equal(summary.isRepo, true);
    assert.equal(summary.files.some((f) => f.path === "app.ts"), true);
    assert.equal(summary.files.some((f) => f.path === ".env"), false, ".env must be filtered out");

    const patch = await getGitFilePatch(repo, "app.ts");
    assert.equal(patch.binary, false);
    assert.equal(patch.hunks.length >= 1, true);
    assert.equal(patch.hunks[0].lines.some((l) => l.type === "add" && l.text.includes("42")), true);

    await assert.rejects(() => getGitFilePatch(repo, ".env"), /Access denied/);
    await assert.rejects(() => getGitFilePatch(repo, "../outside.txt"), /Access denied/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("End-to-end direct WS pairing (SAS approval), E2EE RPC, streaming bridge, idempotency & revocation", async () => {
  const dataDir = makeTempDir("pi-engine-data-");
  const projectDir = makeTempDir("pi-engine-proj-");
  const vault = new PluginVault(dataDir);
  const mockPi = createMockPi(projectDir);
  const hostAdapter = new PiHostAdapter({ pi: mockPi, allowMcpHeadless: false });
  const engine = new RemoteControlEngine({
    vault,
    hostAdapter,
    settings: { directEnabled: true, directPort: 0, directOnly: true },
  });

  await engine.start();
  try {
    const invite = engine.createPairingInvite();
    const wsUrl = `ws://127.0.0.1:${engine.directActualPort}/ws`;

    const ws = new WebSocket(wsUrl);
    const inbox = [];
    let waiter = null;
    const nextMsg = () =>
      new Promise((resolve, reject) => {
        if (inbox.length > 0) return resolve(inbox.shift());
        const t = setTimeout(() => reject(new Error("Timed out waiting for WS message")), 4000);
        waiter = (m) => {
          clearTimeout(t);
          resolve(m);
        };
      });

    ws.addEventListener("message", (evt) => {
      const parsed = JSON.parse(String(evt.data));
      if (waiter) {
        const fn = waiter;
        waiter = null;
        fn(parsed);
      } else {
        inbox.push(parsed);
      }
    });

    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    const deviceId = "dev_mobile_test";
    const clientKp = generateX25519KeyPair();

    // 1. Join & Pair
    ws.send(JSON.stringify({ t: "client.join", routeId: invite.routeId || "direct", deviceId }));
    const joined = await nextMsg();
    assert.equal(joined.t, "client.joined");
    assert.equal(joined.paired, false);

    const inviteProof = await computeInviteProof({
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      clientDhPubB64: clientKp.publicKeyB64,
    });

    ws.send(
      JSON.stringify({
        t: "pair",
        deviceId,
        payload: {
          step: "pair.hello",
          inviteId: invite.inviteId,
          deviceName: "Test iPhone",
          clientDhPub: clientKp.publicKeyB64,
          inviteProof,
        },
      })
    );

    const pendingResp = await nextMsg();
    assert.equal(pendingResp.t, "pair");
    assert.equal(pendingResp.payload.step, "pair.pending_approval");

    // Derive SAS on client and assert exact match with host pending pairing
    const sharedClient = computeSharedSecret(clientKp.privateKey, base64ToBytes(invite.hostDhPub));
    const clientMat = await derivePairingMaterial({
      sharedSecret: sharedClient,
      inviteSecret: invite.inviteSecret,
      inviteId: invite.inviteId,
      hostId: invite.hostId,
      deviceId,
      hostDhPubB64: invite.hostDhPub,
      clientDhPubB64: clientKp.publicKeyB64,
    });

    const snap = await engine.getConsoleSnapshot();
    assert.equal(snap.pendingPairings.length, 1);
    assert.equal(snap.pendingPairings[0].sasCode, clientMat.sasCode);

    // Desktop human approves after checking SAS
    engine.approvePendingPairing(snap.pendingPairings[0].pendingId);
    const approved = await nextMsg();
    assert.equal(approved.t, "pair");
    assert.equal(approved.payload.step, "pair.approved");

    // 2. Encrypted RPC call: turn.start with idempotencyKey
    let clientSeq = 0;
    const clientReplay = new ReplayWindow();
    const sendRpc = async (method, params, idempotencyKey) => {
      clientSeq += 1;
      const reqId = `req_${clientSeq}`;
      const env = await encryptEnvelope({
        keyBytes: clientMat.sessionKey,
        keyId: clientMat.keyId,
        hostId: invite.hostId,
        deviceId,
        direction: "c2h",
        seq: clientSeq,
        payload: { type: "req", id: reqId, idempotencyKey, method, params },
      });
      ws.send(JSON.stringify({ t: "cipher", deviceId, frameId: reqId, envelope: env }));

      while (true) {
        const frame = await nextMsg();
        assert.equal(frame.t, "cipher");
        const dec = await decryptEnvelope({
          keyBytes: clientMat.sessionKey,
          keyId: clientMat.keyId,
          hostId: invite.hostId,
          deviceId,
          expectedDirection: "h2c",
          envelope: frame.envelope,
          replayWindow: clientReplay,
        });
        if (dec.type === "res" && dec.id === reqId) return dec;
      }
    };

    const infoRes = await sendRpc("host.info", {});
    assert.equal(infoRes.ok, true);
    assert.equal(infoRes.result.capabilityMode, "standard");

    const t1 = await sendRpc("turn.start", { sessionId: "sess_1", content: "Run tests" }, "idem_100");
    const t2 = await sendRpc("turn.start", { sessionId: "sess_1", content: "Run tests" }, "idem_100");
    assert.equal(t1.ok, true);
    assert.equal(t2.ok, true);
    assert.equal(t1.result.turnId, t2.result.turnId);
    assert.equal(mockPi.promptCalls.length, 1, "Idempotency key must prevent duplicate turn execution");

    // 3. Sidecar loopback stream event -> encrypted stream.delta delivered to client
    const bridgeCfg = JSON.parse(fs.readFileSync(path.join(dataDir, "stream-bridge.json"), "utf8"));
    const postRes = await fetch(`http://127.0.0.1:${bridgeCfg.port}/internal/stream-event`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridge-token": bridgeCfg.token,
      },
      body: JSON.stringify({
        type: "message_update",
        sessionId: "sess_1",
        turnId: "turn_1",
        event: { message: { content: "Streaming answer from agent..." } },
      }),
    });
    assert.equal(postRes.status, 204);

    // Wait for coalesced delta frame
    let gotDelta = false;
    for (let i = 0; i < 5; i++) {
      const frame = await nextMsg();
      if (frame.t !== "cipher") continue;
      const dec = await decryptEnvelope({
        keyBytes: clientMat.sessionKey,
        keyId: clientMat.keyId,
        hostId: invite.hostId,
        deviceId,
        expectedDirection: "h2c",
        envelope: frame.envelope,
        replayWindow: clientReplay,
      });
      if (dec.type === "evt" && dec.event === "stream.delta") {
        assert.equal(dec.payload.delta, "Streaming answer from agent...");
        gotDelta = true;
        break;
      }
    }
    assert.equal(gotDelta, true);

    // 4. Standard mode approval returns honest requiresDesktopConfirm=true
    const permRes = await sendRpc("approval.resolve", {
      approvalId: "perm_1",
      sessionId: "sess_1",
      decision: "allow",
      risk: "high",
    });
    assert.equal(permRes.ok, true);
    assert.equal(permRes.result.resolved, false);
    assert.equal(permRes.result.requiresDesktopConfirm, true);

    // 5. Revoking device immediately kicks it offline
    const closedPromise = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    await engine.revokeDevice(deviceId);
    const closeCode = await closedPromise;
    assert.equal(closeCode, 4003);
  } finally {
    await engine.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("main.js binds globalThis.pi with zero-arg onLoad(), registers remote-bridge service & commands, and handles panel invoke", async () => {
  const dataDir = makeTempDir("pi-main-lifecycle-");
  const projectDir = makeTempDir("pi-main-proj-");
  const services = new Map();
  const commands = new Map();
  const events = new Map();
  const mockPi = createMockPi(projectDir);

  const prevGlobalPi = globalThis.pi;
  globalThis.pi = {
    plugin: {
      getDataPath: async () => dataDir,
      getSettings: async () => ({ directEnabled: true, directPort: 0, directOnly: true }),
      setSettings: async () => ({}),
    },
    desktop: mockPi.desktop,
    services: {
      register: (s) => services.set(s.id, s),
      unregister: async (id) => {
        const s = services.get(id);
        services.delete(id);
        if (s?.stop) await s.stop();
      },
    },
    commands: {
      register: async (c) => {
        assert.equal(typeof c.id, "string");
        assert.equal(typeof c.run, "function");
        commands.set(c.id, c);
      },
      unregister: async (id) => commands.delete(id),
    },
    events: {
      on: (e, fn) => events.set(e, fn),
      off: (e) => events.delete(e),
    },
  };

  const mod = await import(`../main.js?lifecycle=${Date.now()}`);
  try {
    // Host calls onLoad() with NO arguments!
    await mod.onLoad();
    assert.equal(services.has("remote-bridge"), true, "remote-bridge service must be registered");
    assert.equal(commands.has("local.pi-remote-app.open"), true, "open command must be registered");
    assert.equal(commands.has("local.pi-remote-app.pair"), true, "pair command must be registered");

    assert.equal(typeof events.get("session:modelChanged"), "function");
    events.get("session:modelChanged")({ sessionId: "s1", modelKey: "p/m" });
    await services.get("remote-bridge").start();
    const snap = await mod.onPanelInvoke("remote.status", {});
    assert.equal(snap.projects.length, 1);
    assert.equal(typeof snap.directPort, "number");
    assert.ok(snap.directPort > 0);

    const invite = await mod.onPanelInvoke("remote.pair.create", {});
    assert.equal(invite.v, 1);
    assert.ok(invite.directUrls.length >= 1);
  } finally {
    await mod.onUnload();
    globalThis.pi = prevGlobalPi;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
  assert.equal(events.has("session:modelChanged"), false);
});

test("host-adapter & remote-engine parse PI-Desktop blocks/content[] arrays, skip system msgs, and fallback on turnEnded", async () => {
  const dataDir = makeTempDir("pi-blocks-data-");
  const projectDir = makeTempDir("pi-blocks-proj-");
  const vault = new PluginVault(dataDir);
  const realShapePi = {
    desktop: {
      async invoke({ operation }) {
        if (operation === "session/get") {
          return {
            session: {
              id: "s_blocks",
              title: "Remote Web Session",
              projectPath: projectDir,
              status: "idle",
              messages: [
                { id: "m_sys", role: "system", blocks: [{ type: "text", text: "" }] },
                { id: "m_u1", role: "user", blocks: [{ type: "text", text: "你好" }] },
                {
                  id: "m_a1",
                  role: "assistant",
                  blocks: [
                    { type: "thinking", thinking: "打个招呼" },
                    { type: "text", text: "你好呀，小马在。" },
                  ],
                },
              ],
            },
          };
        }
        return {};
      },
    },
  };
  const adapter = new PiHostAdapter({ pi: realShapePi, allowMcpHeadless: false });
  const detail = await adapter.getSession({ sessionId: "s_blocks" });
  assert.equal(detail.messages.length, 2, "System messages must be stripped");
  assert.equal(detail.messages[0].content, "你好");
  assert.equal(detail.messages[1].content, "你好呀，小马在。");
  assert.equal(detail.messages[1].thinking, "打个招呼");

  const engine = new RemoteControlEngine({
    vault,
    hostAdapter: adapter,
    settings: { directEnabled: false, directOnly: true },
  });
  // Sidecar pi-ai array content streaming
  const deltas = [];
  engine._broadcastTransient = (event, payload) => {
    if (event === "stream.delta") deltas.push(payload);
  };
  engine.handleSidecarStreamEvent({
    type: "message_update",
    sessionId: "s_blocks",
    turnId: "t1",
    event: {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "思考中" },
          { type: "text", text: "你好呀" },
        ],
      },
    },
  });
  engine.coalescer.flush();
  assert.equal(deltas.some((d) => d.channel === "text" && d.delta === "你好呀"), true);
  assert.equal(deltas.some((d) => d.channel === "thinking" && d.delta === "思考中"), true);

  // Fallback sync on session:turnEnded when message_end never arrived
  const replayEvents = [];
  const origAppend = engine.cursorLog.append.bind(engine.cursorLog);
  engine.cursorLog.append = (ev, payload, sid) => {
    replayEvents.push({ ev, payload, sid });
    return origAppend(ev, payload, sid);
  };
  await engine.syncTurnCompletionFromHost("s_blocks", "t1");
  const finalEvt = replayEvents.find((e) => e.ev === "message.final");
  assert.ok(finalEvt, "Fallback sync must emit message.final");
  assert.equal(finalEvt.payload.message.content, "你好呀，小马在。");
  assert.equal(replayEvents.some((e) => e.ev === "turn.state" && e.payload.status === "idle"), true);

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("getSession filters subagent parentToolCallId items and marks intermediate thinking/tool steps as collapsible process steps", async () => {
  const pi = {
    desktop: {
      async invoke({ operation }) {
        if (operation !== "session/get") return {};
        return {
          session: {
            id: "s_turns",
            title: "Complex Turn",
            messages: [
              { id: "u1", role: "user", blocks: [{ type: "text", text: "帮我查一下" }] },
              { id: "a_step1", role: "assistant", blocks: [{ type: "thinking", text: "先翻文件" }, { type: "text", text: "小马先翻文件。" }] },
              { id: "t1", role: "tool", toolName: "Glob", blocks: [{ type: "tool_call", name: "Glob", status: "done", args: { pattern: "*" }, result: { count: 0 } }] },
              { id: "sub_1", role: "assistant", parentToolCallId: "call_sub_1", blocks: [{ type: "text", text: "子代理内部输出" }] },
              { id: "a_think_only", role: "assistant", blocks: [{ type: "thinking", text: "继续思考..." }] },
              { id: "a_final", role: "assistant", blocks: [{ type: "thinking", text: "组织最终回答" }, { type: "text", text: "查到了，这是 PI-Desktop。" }] },
            ],
          },
        };
      },
    },
  };
  const adapter = new PiHostAdapter({ pi, allowMcpHeadless: false });
  const detail = await adapter.getSession({ sessionId: "s_turns" });

  assert.equal(detail.messages.some((m) => m.id === "sub_1"), false, "Subagent nested messages must be filtered");
  const byId = Object.fromEntries(detail.messages.map((m) => [m.id, m]));
  assert.equal(byId.u1.isProcessStep, false);
  assert.equal(byId.a_step1.isProcessStep, true, "Narration before tool call must collapse into process steps");
  assert.equal(byId.t1.isProcessStep, true, "Tool call must collapse into process steps");
  assert.equal(byId.t1.content, "", "Tool call raw JSON must not be dumped into chat bubble content");
  assert.equal(byId.a_think_only.isProcessStep, true, "Thinking-only assistant item must collapse");
  assert.equal(byId.a_final.isProcessStep, false, "Final assistant answer must stay visible");
  assert.equal(byId.a_final.content, "查到了，这是 PI-Desktop。");
  assert.equal(byId.a_final.thinking, "组织最终回答");
});

test("session.configure, providers.list (no secret leak), and settings.get work across modes/permissions/models", async () => {
  const configCalls = [];
  let denyConfigure = false;
  const pi = {
    desktop: {
      async invoke({ operation, args, confirm }) {
        if (operation === "session/configure") {
          configCalls.push({ args, confirm });
          if (denyConfigure) {
            const err = new Error("user declined session/configure");
            err.code = "PERMISSION_DENIED";
            throw err;
          }
          return {
            session: {
              id: args[0],
              title: "Configured Session",
              mode: args[1].mode || "agent",
              permissionMode: args[1].permissionMode || "ask",
              providerId: args[1].providerId || "openai",
              modelId: args[1].modelId || "gpt-5.4",
              thinkingLevel: args[1].thinkingLevel || "high",
            },
          };
        }
        if (operation === "providers/list") {
          return {
            providers: [
              {
                id: "openai",
                name: "OpenAI",
                apiStyle: "responses",
                baseUrl: "https://api.openai.com/v1",
                enabled: true,
                hasApiKey: true,
                apiKey: "sk-MUST-NEVER-LEAK-1234567890",
                secret: "top-secret-token",
                models: [{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, reasoning: true }],
              },
            ],
          };
        }
        if (operation === "settings/get") {
          return {
            defaultMode: "goal",
            defaultPermissionMode: "accept-edits",
            defaultProviderId: "openai",
            defaultModelId: "gpt-5.4",
            defaultThinkingLevel: "high",
          };
        }
        return {};
      },
    },
  };

  const adapter = new PiHostAdapter({ pi, allowMcpHeadless: false });
  const cfgRes = await adapter.configureSession({
    sessionId: "s_cfg",
    mode: "plan",
    permissionMode: "auto",
    providerId: "openai",
    modelId: "gpt-5.4",
    thinkingLevel: "xhigh",
  });
  assert.equal(cfgRes.applied, true);
  assert.equal(cfgRes.session.mode, "plan");
  assert.equal(cfgRes.session.permissionMode, "auto");
  assert.equal(cfgRes.session.modelId, "gpt-5.4");
  assert.equal(configCalls[0].confirm, true);

  denyConfigure = true;
  const deniedRes = await adapter.configureSession({ sessionId: "s_cfg", mode: "goal" });
  assert.equal(deniedRes.applied, false);
  assert.equal(deniedRes.requiresDesktopConfirm, true);

  const provRes = await adapter.listProviders();
  assert.equal(provRes.providers.length, 1);
  assert.equal(provRes.providers[0].hasApiKey, true);
  assert.equal(JSON.stringify(provRes).includes("sk-MUST-NEVER-LEAK"), false, "Provider secrets must never leak");
  assert.equal(JSON.stringify(provRes).includes("top-secret-token"), false, "Provider secrets must never leak");

  const settings = await adapter.getHostSettings();
  assert.equal(settings.defaultMode, "goal");
  assert.equal(settings.defaultPermissionMode, "accept-edits");
});

test("extracts real TodoWrite checklist, background Bash/Subagent tasks, live sidecar updates, and scheduled tasks", async () => {
  const dataDir = makeTempDir("pi-tasks-data-");
  const pi = {
    desktop: {
      async invoke({ operation }) {
        if (operation === "session/get") {
          return {
            session: {
              id: "s_work",
              title: "Work Session",
              mode: "agent",
              permissionMode: "accept-edits",
              messages: [
                {
                  id: "t_todo",
                  role: "tool",
                  toolName: "TodoWrite",
                  toolArgs: {
                    todos: [
                      { content: "Build relay", status: "completed", priority: "high" },
                      { content: "Verify UI", status: "in_progress", priority: "high" },
                    ],
                  },
                },
                {
                  id: "t_bg",
                  role: "tool",
                  toolName: "Bash",
                  toolArgs: { command: "node apps/relay/node/src/server.mjs", runInBackground: true },
                  toolResult: { backgroundTaskId: "bg_relay_1", state: "running" },
                },
                {
                  id: "t_wait",
                  role: "tool",
                  toolName: "TaskWait",
                  toolArgs: { job: { kind: "bash", id: "bg_relay_1" } },
                  toolResult: { id: "bg_relay_1", state: "running", stdout: "listening on :8787" },
                },
              ],
            },
          };
        }
        if (operation === "scheduled/list") {
          return {
            tasks: [{ id: "sch_1", title: "Nightly test", cadence: "daily", enabled: true }],
          };
        }
        return {};
      },
    },
  };

  const vault = new PluginVault(dataDir);
  const adapter = new PiHostAdapter({ pi, allowMcpHeadless: false });
  const engine = new RemoteControlEngine({
    vault,
    hostAdapter: adapter,
    settings: { directEnabled: false, directOnly: true },
  });

  try {
    const initial = await engine._dispatchRpc("dev_1", "tasks.list", { sessionId: "s_work" });
    assert.equal(initial.todos.length, 2);
    assert.equal(initial.todos[1].status, "in_progress");
    assert.equal(initial.backgroundTasks.length, 1);
    assert.equal(initial.backgroundTasks[0].id, "bg_relay_1");
    assert.equal(initial.backgroundTasks[0].outputPreview.includes("listening on :8787"), true);
    assert.equal(initial.scheduledTasks.length, 1);

    // Live sidecar TodoWrite update overrides historical snapshot and emits todos.updated
    const emitted = [];
    const origAppend = engine.cursorLog.append.bind(engine.cursorLog);
    engine.cursorLog.append = (ev, payload, sid) => {
      emitted.push({ ev, payload, sid });
      return origAppend(ev, payload, sid);
    };
    engine.handleSidecarStreamEvent({
      type: "tool_execution_end",
      sessionId: "s_work",
      turnId: "t2",
      event: {
        toolName: "TodoWrite",
        args: {
          todos: [
            { content: "Build relay", status: "completed" },
            { content: "Verify UI", status: "completed" },
          ],
        },
      },
    });
    assert.equal(emitted.some((e) => e.ev === "todos.updated" && e.payload.todos[1].status === "completed"), true);
    const updated = await engine._dispatchRpc("dev_1", "tasks.list", { sessionId: "s_work" });
    assert.equal(updated.todos[1].status, "completed");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Loopback transport, real headers and status codes; no fetch interception.
async function startControlPlane(t, { legacy = null, tokenFile = true, active = true } = {}) {
  const dir = makeTempDir("pi-mcp-control-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = new Map();
  const requests = [];
  const version = "2025-06-18"; // Distinct from the offer to exercise negotiation.
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { id, method, params, jsonrpc } = JSON.parse(body);
    const sid = req.headers["mcp-session-id"];
    const entry = { method, params, sid, status: 200 };
    requests.push(entry);
    function send(status, value) {
      entry.status = status;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    }
    function result(value, sse = false) {
      const reply = { jsonrpc: "2.0", id, result: value };
      if (!sse) return send(200, reply);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`: ping\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\nevent: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`);
    }
    if (req.url !== "/mcp" || req.method !== "POST" || jsonrpc !== "2.0") return send(400, {});
    if (req.headers.authorization !== "Bearer loopback-test") return send(401, {});
    if (method === "initialize") {
      if (legacy === "method-not-found") return send(200, { jsonrpc, id, error: { code: -32601, message: "Method not found" } });
      if (!legacy) {
        const issued = randomUUID();
        sessions.set(issued, false);
        res.setHeader("Mcp-Session-Id", issued);
      }
      return result({ protocolVersion: version, capabilities: { tools: {} } }, !legacy);
    }
    if (!legacy) {
      if (!sid) return send(400, { error: "Mcp-Session-Id is required" });
      if (!sessions.has(sid)) return send(404, { error: "unknown MCP session" });
      if (req.headers["mcp-protocol-version"] !== version) return send(400, { error: "wrong version" });
      if (method === "notifications/initialized" && id === undefined) {
        sessions.set(sid, true);
        return send(202);
      }
      if (!sessions.get(sid)) return send(400, { error: "not initialized" });
    }
    if (method === "tools/list") return result({ tools: [{ name: "pi_desktop_invoke" }] });
    if (method !== "tools/call" || params?.name !== "pi_desktop_invoke") return send(400, {});
    const { operation, args, confirm } = params.arguments;
    if (operation !== "session/configure" || confirm !== true) return send(400, {});
    const [sessionId, config] = args;
    if (config.modelId === "bad-request") return send(400, { error: "invalid args" });
    if (config.modelId === "unavailable") return result({ isError: true, content: [{ type: "text", text: "model unavailable" }] }, true);
    const updated = { operation, result: { session: { id: sessionId, ...config } } };
    return result({ content: [{ type: "text", text: JSON.stringify(updated) }] }, !legacy);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  fs.writeFileSync(path.join(dir, "mcp-control.json"), JSON.stringify({ url, active, token: tokenFile ? "superseded" : "loopback-test" }));
  if (tokenFile) fs.writeFileSync(path.join(dir, "mcp-control.token"), "loopback-test\n");
  return { adapter: new PiHostAdapter({ mcpConfigDir: dir }), sessions, requests, url };
}

test("strict MCP: handshake before tools/list, cache session, configure, recover once after expiry", async t => {
  const { adapter, sessions, requests, url } = await startControlPlane(t);
  const missing = await fetch(url, { method: "POST", headers: { authorization: "Bearer loopback-test" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "Mcp-Session-Id is required");
  requests.length = 0;
  assert.deepEqual(await Promise.all([adapter.detectCapabilityMode(), adapter.detectCapabilityMode()]), ["mcp-full", "mcp-full"]);
  const configure = modelId => adapter.configureSession({ sessionId: "s1", modelId });
  const first = await configure("before");
  assert.equal(first.capabilityMode, "mcp-full");
  assert.equal(first.requiresDesktopConfirm, false);
  assert.equal(first.session.modelId, "before");
  assert.deepEqual(requests.map(r => [r.method, r.status]), [["initialize", 200], ["notifications/initialized", 202], ["tools/list", 200], ["tools/call", 200]]);
  assert.deepEqual(requests[0].params, { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "local.pi-remote-app", version: "1.0.1" } });
  const old = requests[3].sid;
  sessions.clear();
  requests.length = 0;
  const second = await configure("after");
  assert.equal(second.session.modelId, "after");
  assert.deepEqual(requests.map(r => [r.method, r.status]), [["tools/call", 404], ["initialize", 200], ["notifications/initialized", 202], ["tools/call", 200]]);
  assert.equal(requests[0].sid, old);
  assert.notEqual(requests[3].sid, old);
  assert.deepEqual(requests[0].params, requests[3].params);
  // Force the TTL boundary without sleeping ten seconds.
  adapter._mcpState.checkedAt -= 10_001;
  requests.length = 0;
  assert.equal(await adapter.detectCapabilityMode(), "mcp-full");
  assert.deepEqual(requests.map(r => r.method), ["initialize", "notifications/initialized", "tools/list"]);
});

test("MCP tool failures expose the text and persistent HTTP 400 gets only one retry", async t => {
  const { adapter, requests } = await startControlPlane(t);
  await assert.rejects(adapter.configureSession({ sessionId: "s1", modelId: "unavailable" }), /model unavailable/);
  assert.equal(requests.filter(r => r.method === "tools/call").length, 1);
  requests.length = 0;
  await assert.rejects(adapter.configureSession({ sessionId: "s1", modelId: "bad-request" }), /HTTP 400/);
  assert.deepEqual(requests.map(r => r.status), [400, 200, 202, 400]);
});

for (const legacy of ["no-header", "method-not-found"]) {
  test(`stateless MCP (${legacy}) uses config token when token file is missing`, async t => {
    const { adapter, requests } = await startControlPlane(t, { legacy, tokenFile: false });
    const result = await adapter.configureSession({ sessionId: "s", modelId: "legacy" });
    assert.equal(result.session.model, "legacy");
    assert.equal(result.capabilityMode, "mcp-full");
    assert.deepEqual(requests.map(r => r.method), ["initialize", "tools/list", "tools/call"]);
    assert.ok(requests.every(r => r.sid === undefined));
  });
}

test("inactive MCP config does not contact control server", async t => {
  const { adapter, requests } = await startControlPlane(t, { active: false });
  assert.equal(await adapter.detectCapabilityMode(), "standard");
  assert.equal(requests.length, 0);
});

test("host model changes broadcast replayable partial session.configured updates", t => {
  const dir = makeTempDir("pi-model-events-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = new RemoteControlEngine({ vault: new PluginVault(dir) });
  const sent = [];
  engine._broadcastToAllPeers = entry => sent.push(entry);
  engine.handleHostModelChanged({ modelKey: "ignored" });
  engine.handleHostModelChanged({ sessionId: "s1", modelKey: "provider/org/model", thinkingLevel: "high" });
  engine.handleHostModelChanged({ sessionId: "s1", modelKey: "raw-id" });
  engine.handleHostModelChanged({ sessionId: "s1", thinkingLevel: "off" });
  const replay = engine.cursorLog.pull({ epoch: engine.cursorLog.epoch, sessionId: "s1" });
  assert.deepEqual(sent, replay.events);
  assert.ok(sent.every(e => e.event === "session.configured" && e.sessionId === "s1" && e.payload.sessionId === "s1"));
  assert.deepEqual(sent.map(e => e.payload.session), [
    { id: "s1", providerId: "provider", modelId: "org/model", model: "org/model", thinkingLevel: "high" },
    { id: "s1", modelId: "raw-id", model: "raw-id" }, { id: "s1", thinkingLevel: "off" },
  ]);
});
