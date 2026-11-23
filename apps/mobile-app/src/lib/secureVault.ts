import * as SecureStore from "expo-secure-store";
import type { PairedHostRecord } from "./remoteClient";

const INDEX_KEY = "pi_remote_host_index_v1";
const THEME_KEY = "pi_remote_theme_v1";
const MAX_VALUE_BYTES = 2048;
type Theme = "light" | "dark";

function hostKey(id: string): string {
  // Escape into a disjoint namespace so e.g. 'a/b', 'a_b' and the index cannot collide.
  const safe = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) && id !== "index_v1";
  const suffix = safe ? id : "." + id.replace(/[\s\S]/g, ch => ch.charCodeAt(0).toString(16).padStart(4, "0"));
  return "pi_remote_host_" + suffix;
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength > MAX_VALUE_BYTES) throw new Error("SecureStore value too large");
  return json;
}

async function readIndex(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(INDEX_KEY);
  if (raw === null) return [];
  const ids: unknown = JSON.parse(raw);
  if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && id.length > 0)) {
    throw new Error("Invalid host index");
  }
  return [...new Set<string>(ids)];
}

async function readHosts(): Promise<PairedHostRecord[]> {
  const ids = await readIndex();
  const hosts = await Promise.all(ids.map(async id => {
    try {
      const raw = await SecureStore.getItemAsync(hostKey(id));
      if (raw === null) return null;
      const host = JSON.parse(raw);
      if (host?.hostId !== id || !Array.isArray(host.directUrls) || !host.directUrls.every((url: unknown) => typeof url === "string") ||
          ![host.hostName, host.deviceId, host.keyId, host.sessionKeyB64].every(v => typeof v === "string")) return null;
      return host as PairedHostRecord;
    } catch {
      return null; // One inaccessible or corrupt record must not hide the others.
    }
  }));
  return hosts.filter((host): host is PairedHostRecord => host !== null);
}

// Serialize read/modify/write operations so simultaneous pairings cannot lose an index entry.
let writes = Promise.resolve();
function update(mutate: (ids: string[]) => Promise<void>): Promise<PairedHostRecord[]> {
  const result = writes.then(async () => {
    try {
      await mutate(await readIndex());
    } catch {
      // Report only records that are actually persisted. Never fall back to plaintext storage.
    }
    return readHosts().catch(() => []);
  });
  writes = result.then(() => undefined);
  return result;
}

export async function loadPairedHosts(): Promise<PairedHostRecord[]> {
  await writes;
  return readHosts().catch(() => []);
}

export function savePairedHost(record: PairedHostRecord): Promise<PairedHostRecord[]> {
  return update(async ids => {
    if (!record.hostId) return;
    const key = hostKey(record.hostId);
    const nextIndex = ids.includes(record.hostId) ? null : boundedJson([...ids, record.hostId]);
    await SecureStore.setItemAsync(key, boundedJson(record));
    if (nextIndex !== null) {
      try {
        await SecureStore.setItemAsync(INDEX_KEY, nextIndex);
      } catch (error) {
        await SecureStore.deleteItemAsync(key);
        throw error;
      }
    }
  });
}

export function removePairedHost(hostId: string): Promise<PairedHostRecord[]> {
  return update(async ids => {
    await SecureStore.deleteItemAsync(hostKey(hostId));
    if (ids.includes(hostId)) {
      await SecureStore.setItemAsync(INDEX_KEY, boundedJson(ids.filter(id => id !== hostId)));
    }
  });
}

export async function loadThemePreference(): Promise<Theme> {
  try {
    return (await SecureStore.getItemAsync(THEME_KEY)) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export async function saveThemePreference(theme: Theme): Promise<void> {
  try {
    await SecureStore.setItemAsync(THEME_KEY, theme);
  } catch {
    // The current in-memory theme remains usable when SecureStore is unavailable.
  }
}
