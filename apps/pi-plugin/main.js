/**
 * PI-Desktop Plugin Entrypoint (`local.pi-remote-app`).
 * Uses host-provided `globalThis.pi` SDK (onLoad is invoked with no arguments by PI-Desktop).
 * Registers background service, commands, settings listener, and view/panel IPC handlers.
 */

import path from "node:path";
import os from "node:os";
import { PluginVault } from "./src/vault.mjs";
import { PiHostAdapter } from "./src/host-adapter.mjs";
import { RemoteControlEngine } from "./src/remote-engine.mjs";
import { encodeQrCode } from "./src/qr-encoder.mjs";

let activePi = null;
let engine = null;
let vault = null;
let eventListeners = [];

async function resolveDataDir(pi) {
  try {
    if (pi?.plugin?.getDataPath) {
      const p = await pi.plugin.getDataPath();
      if (typeof p === "string" && p.length > 0) return p;
    }
  } catch {
    // fallback below
  }
  return path.join(os.homedir(), ".pi-desktop", "plugins", "data", "local.pi-remote-app");
}

async function readSettings(pi) {
  try {
    if (pi?.plugin?.getSettings) {
      return (await pi.plugin.getSettings()) || {};
    }
  } catch {
    // fallback to defaults
  }
  return {};
}

export async function onLoad(injectedPi = globalThis.pi) {
  const pi = injectedPi || globalThis.pi;
  activePi = pi;

  const dataDir = await resolveDataDir(pi);
  vault = new PluginVault(dataDir);
  const settings = await readSettings(pi);
  const hostAdapter = new PiHostAdapter({
    pi,
    allowMcpHeadless: settings.allowMcpHeadlessResolve !== false,
  });

  engine = new RemoteControlEngine({ vault, hostAdapter, settings });

  if (pi?.services?.register) {
    pi.services.register({
      id: "remote-bridge",
      start: async () => {
        await engine.start();
      },
      stop: async () => {
        await engine.stop();
      },
    });
  } else {
    await engine.start();
  }

  if (pi?.commands?.register) {
    await pi.commands.register({
      id: "local.pi-remote-app.open",
      title: "PI Remote Control: Open Console / 打开远程控制台",
      keywords: ["remote", "mobile", "app", "pair", "远程", "手机"],
      run: async () => {
        if (pi?.ui?.openPanel) await pi.ui.openPanel({ title: "PI 远程控制台" });
      },
    });
    await pi.commands.register({
      id: "local.pi-remote-app.pair",
      title: "PI Remote Control: Open Remote Console Panel for Pairing / 打开远程控制台面板进行配对",
      keywords: ["pair", "qr", "配对", "二维码"],
      run: async () => {
        if (pi?.ui?.openPanel) await pi.ui.openPanel({ title: "PI 远程控制台" });
      },
    });
  }

  if (pi?.events?.on) {
    const onSettingsChanged = async () => {
      const next = await readSettings(pi);
      if (engine) await engine.applySettings(next);
    };
    const onTurnEnded = (evt) => {
      if (engine && evt?.sessionId) {
        engine.syncTurnCompletionFromHost(evt.sessionId, evt.turnId || null).catch(() => {});
      }
    };
    const onModelChanged = (evt) => engine?.handleHostModelChanged(evt);
    pi.events.on("plugin:settingsChanged", onSettingsChanged);
    pi.events.on("session:turnEnded", onTurnEnded);
    pi.events.on("session:modelChanged", onModelChanged);
    eventListeners.push(
      ["plugin:settingsChanged", onSettingsChanged],
      ["session:turnEnded", onTurnEnded],
      ["session:modelChanged", onModelChanged]
    );
  }
}

export async function onUnload() {
  const pi = activePi || globalThis.pi;
  for (const [evt, fn] of eventListeners) {
    try {
      pi?.events?.off?.(evt, fn);
    } catch {
      // ignore
    }
  }
  eventListeners = [];

  if (pi?.commands?.unregister) {
    await Promise.allSettled([
      pi.commands.unregister("local.pi-remote-app.open"),
      pi.commands.unregister("local.pi-remote-app.pair"),
    ]);
  }
  if (pi?.services?.unregister) {
    try {
      await pi.services.unregister("remote-bridge");
    } catch {
      // ignore
    }
  }
  if (engine) {
    await engine.stop();
    engine = null;
  }
  vault = null;
  activePi = null;
}

export async function onPanelInvoke(channel, payload = {}) {
  if (!engine || !vault) {
    throw new Error("Remote engine is not initialized");
  }
  const pi = activePi || globalThis.pi;
  switch (channel) {
    case "remote.status":
      return engine.getConsoleSnapshot();
    case "remote.pair.create":
      return engine.createPairingInvite();
    case "remote.pair.createWithQr": {
      const invite = engine.createPairingInvite();
      const inviteJson = JSON.stringify(invite);
      const qr = encodeQrCode(inviteJson, { ecLevel: "L" });
      return { invite, inviteJson, qr };
    }
    case "remote.qr.encode":
      return encodeQrCode(payload.text, { ecLevel: payload.ecLevel });
    case "remote.pair.approve":
      return engine.approvePendingPairing(String(payload.pendingId || ""));
    case "remote.pair.reject":
      return engine.rejectPendingPairing(String(payload.pendingId || ""));
    case "remote.device.revoke":
      return engine.revokeDevice(String(payload.deviceId || ""));
    case "remote.projects.setAllowed":
      vault.setAllowedProjects(Array.isArray(payload.projects) ? payload.projects : []);
      return { ok: true, allowedProjects: vault.state.allowedProjects };
    case "remote.settings.update": {
      const allowedKeys = ["hostName", "directEnabled", "directPort", "directOnly", "relayUrl", "allowMcpHeadlessResolve"];
      const patch = {};
      for (const k of allowedKeys) {
        if (payload[k] !== undefined) patch[k] = payload[k];
      }
      if (pi?.plugin?.setSettings) {
        await pi.plugin.setSettings(patch);
      }
      await engine.applySettings(patch);
      return engine.getConsoleSnapshot();
    }
    default:
      throw new Error(`Unknown panel channel: ${channel}`);
  }
}

export default { onLoad, onUnload, onPanelInvoke };
