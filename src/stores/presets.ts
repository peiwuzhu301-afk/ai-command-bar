// Model preset store: persists in app_data_dir/model_presets.json
// The "current" preset id is held in ModelConfig (apiKey kept in keyring).
// Each preset: { id, name, baseUrl, model, temperature, maxTokens, timeout }
import { ModelPreset } from "../types";
import { TAURI, invoke } from "../lib/tauri";

const KEY = "aibar.presets.v1";
const LOCAL_KEY = "aibar.model.presets";

export interface PresetState {
  presets: ModelPreset[];
  /** active preset id, or "" if not linked */
  activePresetId: string;
}

function seed(): PresetState {
  return { presets: [], activePresetId: "" };
}

let current: PresetState = seed();
type Listener = (s: PresetState) => void;
const listeners = new Set<Listener>();
function emit() {
  const snap = { ...current, presets: [...current.presets] };
  listeners.forEach((l) => l(snap));
}

export function getPresets(): PresetState {
  return { ...current, presets: [...current.presets] };
}

export async function loadPresets(): Promise<PresetState> {
  if (TAURI) {
    try {
      const r = await invoke<PresetState | null>("load_model_presets");
      if (r) current = r;
    } catch {
      console.warn("load presets failed, using in-memory defaults");
    }
  } else {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) current = JSON.parse(raw);
    } catch {
      current = seed();
    }
  }
  emit();
  return getPresets();
}

async function persist() {
  if (TAURI) {
    try {
      await invoke("save_model_presets", { state: current });
    } catch (e) {
      console.warn("persist presets failed", e);
    }
  } else {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(current));
    } catch {
      /* ignore */
    }
  }
}

export async function addPreset(p: Omit<ModelPreset, "id"> & { id?: string }): Promise<ModelPreset> {
  const next: ModelPreset = {
    id: p.id || `preset-${Date.now().toString(36)}`,
    name: p.name?.trim() || "未命名",
    baseUrl: p.baseUrl,
    model: p.model,
    temperature: p.temperature,
    maxTokens: p.maxTokens,
    timeout: p.timeout,
  };
  // 同名合并：若 name 已存在则覆盖
  const exists = current.presets.find((x) => x.name === next.name);
  if (exists) {
    const idx = current.presets.indexOf(exists);
    current.presets[idx] = { ...exists, ...next, id: exists.id };
  } else {
    current.presets = [...current.presets, next];
  }
  await persist();
  emit();
  return exists ? { ...next, id: exists?.id ?? next.id } : next;
}

export async function removePreset(id: string): Promise<void> {
  current.presets = current.presets.filter((p) => p.id !== id);
  if (current.activePresetId === id) current.activePresetId = "";
  await persist();
  emit();
}

export async function setActivePreset(id: string): Promise<void> {
  current.activePresetId = id;
  await persist();
  emit();
}

export function onPresetsChange(cb: Listener): () => void {
  listeners.add(cb);
  cb({ ...current, presets: [...current.presets] });
  return () => listeners.delete(cb);
}

export { KEY };
