// Model configuration (Base URL, Model). API key lives in OS secret store.
import { ModelConfig } from "../types";
import { TAURI, invoke } from "../lib/tauri";

const KEY = "aibar.model.v1";
const DEFAULTS: ModelConfig = {
  provider: "openai-compatible",
  baseUrl: "http://127.0.0.1:8000/v1",
  apiKey: "", // lives in OS secret store; kept in-memory only
  model: "qwen3.8-27b-fp8",
  temperature: 0.4,
  maxTokens: 2048,
  /** 超时单位：秒（Rust clamp 30~600） */
  timeout: 180,
};

let current: ModelConfig = { ...DEFAULTS };

type Listener = (m: ModelConfig) => void;
const listeners = new Set<Listener>();
function emit() {
  const snap = { ...current };
  listeners.forEach((l) => l(snap));
}

export function getModelConfig(): ModelConfig {
  return current;
}

export async function loadModelConfig(): Promise<ModelConfig> {
  if (TAURI) {
    try {
      const r = await invoke<Partial<ModelConfig> | null>("load_model_config");
      if (r) {
        current = { ...DEFAULTS, ...r, apiKey: "" };
        // fetch secret
        try {
          const key = await invoke<string | null>("get_api_key");
          if (key) current = { ...current, apiKey: key };
        } catch {
          /* no key yet */
        }
      }
    } catch {
      current = { ...DEFAULTS };
    }
  } else {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        current = { ...DEFAULTS, ...parsed, apiKey: "" };
      }
    } catch {
      /* ignore */
    }
  }
  emit();
  return current;
}

export async function saveModelConfig(patch: Partial<ModelConfig>, opts?: { saveKey?: boolean }): Promise<ModelConfig> {
  const prev = current;
  // Strip key unless explicitly requested — key gets stored in OS secrets.
  const { apiKey, ...rest } = patch;
  current = { ...current, ...rest };
  if (apiKey !== undefined) {
    if (opts?.saveKey) {
      if (TAURI) {
        try {
          await invoke("save_api_key", { key: apiKey });
          current = { ...current, apiKey };
        } catch (e) {
          console.warn("failed to store api key", e);
        }
      }
    } else {
      current = { ...current, apiKey: "" };
    }
  }
  if (TAURI) {
    try {
      const { apiKey: _drop, ...forStore } = current;
      void _drop;
      await invoke("save_model_config", { config: forStore });
    } catch (e) {
      console.warn("failed to persist model config", e);
    }
  } else {
    try {
      const { apiKey: _drop, ...forStore } = current;
      void _drop;
      localStorage.setItem(KEY, JSON.stringify(forStore));
    } catch {
      /* ignore */
    }
  }
  if (TAURI && !opts?.saveKey) {
    // key unchanged; keep in-memory key
    try {
      const k = await invoke<string | null>("get_api_key").catch(() => null);
      if (k !== null && k !== undefined) current = { ...current, apiKey: k };
      else current = { ...current, apiKey: prev.apiKey };
    } catch {
      /* ignore */
    }
  }
  emit();
  return current;
}

export function onModelConfigChange(cb: Listener): () => void {
  listeners.add(cb);
  cb({ ...current });
  return () => listeners.delete(cb);
}
