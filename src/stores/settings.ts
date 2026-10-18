// Global settings store with localStorage fallback + Tauri persistence via invoke.
import { AppSettings } from "../types";
import { TAURI, invoke } from "../lib/tauri";

const KEY = "aibar.settings.v1";
const DEFAULTS: AppSettings = {
  globalShortcut: "Alt+Space",
  launchAtStartup: true,
  startMinimized: true,
  showTrayIcon: true,
  autoCaptureSelection: true,
  restoreClipboardAfterCapture: true,
  maxContextLength: 8000,
  saveHistory: true,
  maxHistoryEntries: 500,
  autoFitWindow: true,
  uiScale: 1,
  requestTimeout: 180,
  screenshotAutoDetect: true,
  screenshotDir: "",
  agentTools: true,
};

let current: AppSettings = loadInitial();

function loadInitial(): AppSettings {
  if (TAURI) return { ...DEFAULTS }; // filled after load()
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();
function emit() {
  const snapshot = { ...current };
  listeners.forEach((l) => l(snapshot));
}

export function getSettings(): AppSettings {
  return current;
}

export async function loadSettings(): Promise<AppSettings> {
  if (TAURI) {
    try {
      const r = await invoke<Partial<AppSettings> | null>("load_settings");
      if (r) current = { ...DEFAULTS, ...r };
    } catch {
      current = { ...DEFAULTS };
    }
  } else {
    current = loadInitial();
  }
  emit();
  return current;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  current = { ...current, ...patch };
  if (TAURI) {
    try {
      await invoke("save_settings", { settings: current });
    } catch (e) {
      console.warn("failed to persist settings", e);
    }
  } else {
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* ignore */
    }
  }
  emit();
  return current;
}

export function onSettingsChange(cb: Listener): () => void {
  listeners.add(cb);
  cb({ ...current });
  return () => listeners.delete(cb);
}
