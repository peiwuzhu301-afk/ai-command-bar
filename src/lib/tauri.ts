// Minimal wrapper that detects Tauri runtime vs plain browser.
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

export const TAURI = isTauri();

/** Detect when running in a real Tauri shell. */
export function isDesktop(): boolean {
  return TAURI;
}

export async function onEvent<T>(name: string, cb: (p: T) => void): Promise<UnlistenFn | null> {
  if (!TAURI) {
    console.warn(`[tauri] onEvent skipped (browser): ${name}`);
    cb({} as T);
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(name, (e) => cb(e.payload));
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!TAURI) throw new Error("Tauri runtime required");
  const { invoke: i } = await import("@tauri-apps/api/core");
  return i<T>(cmd, args);
}
