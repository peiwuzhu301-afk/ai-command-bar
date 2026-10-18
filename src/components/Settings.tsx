// Settings panel: model config + general settings + shortcut.
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { AppSettings, ModelConfig, ConnectionResult } from "../types";
import { openaiCompatible } from "../providers/openai-compatible";
import { displayShortcut, endpointClass } from "../utils/text";
import { TAURI, invoke } from "../lib/tauri";
import {
  addPreset,
  loadPresets,
  onPresetsChange,
  removePreset,
  setActivePreset,
  type PresetState,
} from "../stores/presets";
import type { ModelPreset } from "../types";

import { ExportImport } from "./ExportImport";

interface Props {
  settings: AppSettings;
  model: ModelConfig;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  onSaveModel: (patch: Partial<ModelConfig>, opts?: { saveKey?: boolean }) => Promise<ModelConfig>;
  onClose: () => void;
}

export function Settings({ settings, model, onSaveSettings, onSaveModel, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState(model.baseUrl);
  const [modelName, setModelName] = useState(model.model);
  const [apiKey, setApiKey] = useState(model.apiKey);
  const [showKey, setShowKey] = useState(false);

  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [testing, setTesting] = useState(false);

  const [shortcut, setShortcut] = useState(settings.globalShortcut);
  const [shortcutStatus, setShortcutStatus] = useState<"idle" | "applying" | "ok" | "err">("idle");

  // ===== 模型预设（M3.1）=====
  const [presets, setPresets] = useState<PresetState>(() => ({ presets: [], activePresetId: "" }));
  const [newPresetName, setNewPresetName] = useState("");
  useEffect(() => {
    void loadPresets();
    return onPresetsChange(setPresets);
  }, []);

  // 从接口测试结果里拉到的可用模型
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);

  // 预设：使用当前已填好的 baseUrl / model / temperature / maxTokens 建一个
  const createPresetFromCurrent = useCallback(async () => {
    if (!newPresetName.trim()) return;
    await addPreset({
      name: newPresetName.trim(),
      baseUrl: baseUrl.trim(),
      model: modelName.trim(),
      temperature: 0.4,
      maxTokens: 2048,
      timeout: settings.requestTimeout ?? 180,
    });
    setNewPresetName("");
  }, [newPresetName, baseUrl, modelName, settings.requestTimeout]);

  const usePreset = useCallback(
    async (p: ModelPreset) => {
      await setActivePreset(p.id);
      await onSaveModel({
        baseUrl: p.baseUrl,
        model: p.model,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        timeout: p.timeout,
        activePresetId: p.id,
      });
      setBaseUrl(p.baseUrl);
      setModelName(p.model);
    },
    [onSaveModel],
  );

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setDiscoveredModels([]);
    // Use the in-memory values first, apply before testing
    const probe = {
      baseUrl,
      apiKey,
      model: modelName,
    };
    try {
      const res = await openaiCompatible.testConnection(probe);
      setTestResult(res);
      if (res.models?.length) {
        setDiscoveredModels(res.models);
      }
    } finally {
      setTesting(false);
    }
  }, [baseUrl, apiKey, modelName]);

  const applyModel = useCallback(async (withKey: boolean) => {
    const patch: Partial<ModelConfig> = {
      baseUrl: baseUrl.trim(),
      model: modelName.trim(),
    };
    if (withKey) patch.apiKey = apiKey;
    await onSaveModel(patch, { saveKey: withKey });
  }, [baseUrl, modelName, apiKey, onSaveModel]);

  useEffect(() => {
    if (!TAURI) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const endpoint = endpointClass(baseUrl);

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>设置</h2>
        <button className="ghost" onClick={onClose} title="关闭（Esc）">✕</button>
      </div>

      <div className="settings-body">
        <section className="section">
          <h3>模型</h3>
          <div className="field">
            <label>接口地址（Base URL）</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8000/v1" />
            <span className="hint">
              类型：<span className={endpoint === "local" ? "ok" : endpoint === "private" ? "accent" : ""}>{endpoint === "local" ? "本机" : endpoint === "private" ? "局域网" : "远程"}</span>
              {" — "}兼容 OpenAI 接口（chat/completions）。
            </span>
          </div>
          <div className="field">
            <label>模型</label>
            <input value={modelName} onChange={(e) => setModelName(e.target.value)} placeholder="qwen3.8-27b-fp8" />
          </div>
          <div className="field">
            <label>API 密钥</label>
            <div className="row gap-8">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…（保存在系统凭据管理器中）"
                className="flex1"
              />
              <button className="ghost" onClick={() => setShowKey((s) => !s)} title="切换可见性">
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <span className="hint">保存在系统凭据库中（Windows 为「凭据管理器」）。</span>
          </div>
          <div className="row gap-8 settings-actions">
            <button
              className="ghost"
              onClick={() => void applyModel(false)}
              disabled={!baseUrl.trim() || !modelName.trim()}
            >
              保存地址 + 模型
            </button>
            <button
              className="primary"
              onClick={() => void applyModel(true)}
              disabled={!baseUrl.trim() || !modelName.trim()}
            >
              保存地址 + 模型 + 密钥
            </button>
            <div className="spacer" />
            <button onClick={testConnection} disabled={testing} title="测试连接">
              {testing ? "测试中…" : "测试连接"}
            </button>
          </div>
          {testResult && (
            <div className={clsx("test-result", testResult.ok ? "ok" : "err")}>
              {testResult.message}
              {typeof testResult.latencyMs === "number" && <span> · {testResult.latencyMs} ms</span>}
              {!testResult.ok && testResult.models?.length === 0 && (
                <div className="dim">提示：请检查接口地址（例如是否带 /v1 后缀）和模型名称。</div>
              )}
              {testResult.models && testResult.models.length > 1 && (
                <div className="dim">
                  服务器上的模型：{testResult.models.slice(0, 5).join("、")}
                  {testResult.models.length > 5 ? `（还有 ${testResult.models.length - 5} 个）` : ""}
                </div>
              )}
            </div>
          )}
          {discoveredModels.length > 0 && (
            <div className="field">
              <label>从服务器选择模型</label>
              <select
                className="flex1"
                value={discoveredModels.includes(modelName) ? modelName : ""}
                onChange={(e) => e.target.value && setModelName(e.target.value)}
              >
                <option value="" disabled>
                  {modelName ? "自定义名称" : "选择模型…"}
                </option>
                {discoveredModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <span className="hint">选定后点「保存地址 + 模型」即可应用。</span>
            </div>
          )}

          <div className="field">
            <label>请求超时（秒）</label>
            <div className="row gap-8">
              <input
                type="number"
                className="w-100"
                min={30}
                max={600}
                step={30}
                value={settings.requestTimeout ?? 180}
                onChange={(e) => {
                  const v = Math.max(30, Math.min(600, Number(e.target.value) || 180));
                  void onSaveSettings({ requestTimeout: v });
                }}
              />
              <span className="hint">30 ~ 600 秒，神经网络内网建议 180。</span>
            </div>
          </div>
        </section>

        <section className="section">
          <h3>模型预设</h3>
          <p className="hint">
            多个模型/接口配置一键切换。API 密钥仍保存在系统凭据库（全局唯一），预设只切换地址与参数。
          </p>
          <div className="row gap-8">
            <input
              className="flex1"
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder="新预设名称（用当前模型配置创建）"
            />
            <button
              className="primary"
              onClick={() => void createPresetFromCurrent()}
              disabled={!newPresetName.trim() || !baseUrl.trim() || !modelName.trim()}
            >
              + 保存为预设
            </button>
          </div>
          {presets.presets.length === 0 ? (
            <div className="dim" style={{ fontSize: 12 }}>
              还没有预设。填好上方模型配置后点「+ 保存为预设」。
            </div>
          ) : (
            presets.presets.map((p) => (
              <div
                key={p.id}
                className="preset-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: presets.activePresetId === p.id ? "rgba(90,140,255,0.10)" : "transparent",
                  border: `1px solid ${
                    presets.activePresetId === p.id ? "rgba(90,140,255,0.35)" : "#1c2536"
                  }`,
                  marginTop: 6,
                }}
              >
                <span style={{ fontWeight: 600, minWidth: 90 }}>{p.name}</span>
                <span className="muted" style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.baseUrl} · {p.model}
                </span>
                {model.activePresetId === p.id && <span className="ok">当前</span>}
                <button className="ghost small" onClick={() => void usePreset(p)}>
                  使用
                </button>
                <button className="ghost small danger" onClick={() => void removePreset(p.id)}>
                  ✕
                </button>
              </div>
            ))
          )}
        </section>

        <section className="section">
          <h3>系统</h3>
          <div className="field">
            <label>全局快捷键</label>
            <div className="row gap-8">
              <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="Alt+Space" className="flex1" />
              <button
                className="primary"
                disabled={shortcutStatus === "applying"}
                onClick={async () => {
                  setShortcutStatus("applying");
                  try {
                    await invoke("register_global_shortcut", { shortcut });
                    await onSaveSettings({ globalShortcut: shortcut });
                    setShortcutStatus("ok");
                  } catch (e) {
                    setShortcutStatus("err");
                    console.error(e);
                  }
                }}
              >
                {shortcutStatus === "applying" ? "…" : "应用"}
              </button>
            </div>
            <span className="hint">
              当前快捷键：<span className="accent">{displayShortcut(settings.globalShortcut)}</span>
              {shortcutStatus === "ok" && <span className="ok"> ✓ 已更新</span>}
              {shortcutStatus === "err" && <span className="err"> ✗ 设置失败</span>}
            </span>
          </div>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.saveHistory}
              onChange={(e) => onSaveSettings({ saveHistory: e.target.checked })}
            />
            保存历史记录
          </label>
          <div className="field">
            <label>历史记录条数上限</label>
            <div className="row gap-8">
              <input
                type="number"
                className="w-100"
                min={100}
                max={1000}
                step={100}
                value={settings.maxHistoryEntries}
                onChange={(e) => {
                  const v = Math.max(100, Math.min(1000, Number(e.target.value) || 500));
                  void onSaveSettings({ maxHistoryEntries: v });
                }}
              />
              <span className="hint">100 ~ 1000 条。</span>
            </div>
          </div>
          <div className="field">
            <label>上下文长度上限（字符）</label>
            <div className="row gap-8">
              <input
                type="number"
                className="w-100"
                min={1000}
                max={64000}
                step={1000}
                value={settings.maxContextLength}
                onChange={(e) => {
                  const v = Math.max(1000, Math.min(64000, Number(e.target.value) || 8000));
                  void onSaveSettings({ maxContextLength: v });
                }}
              />
              <span className="hint">决定送入模型的复制文本截断位置。</span>
            </div>
          </div>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.restoreClipboardAfterCapture}
              onChange={(e) => onSaveSettings({ restoreClipboardAfterCapture: e.target.checked })}
            />
            捕获后恢复剪贴板原内容
          </label>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.autoCaptureSelection}
              onChange={(e) => {
                void onSaveSettings({ autoCaptureSelection: e.target.checked });
                // 实时启停剪贴板监听
                if (TAURI) {
                  void invoke("start_clipboard_watch", { enabled: e.target.checked }).catch(() => {});
                }
              }}
            />
            剪贴板变化时自动更新上下文
          </label>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.launchAtStartup}
              onChange={(e) => {
                void onSaveSettings({ launchAtStartup: e.target.checked });
                if (TAURI) {
                  void invoke("apply_autostart", { enable: e.target.checked }).catch((err) =>
                    console.warn("apply_autostart failed", err),
                  );
                }
              }}
            />
            开机自启动
          </label>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.startMinimized}
              onChange={(e) => onSaveSettings({ startMinimized: e.target.checked })}
            />
            启动时隐藏到后台（通过快捷键呼出）
          </label>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.showTrayIcon}
              onChange={(e) => {
                void onSaveSettings({ showTrayIcon: e.target.checked });
                if (TAURI) {
                  void invoke("set_tray_visibility", { visible: e.target.checked }).catch(
                    (err) => console.warn("set_tray_visibility failed", err),
                  );
                }
              }}
            />
            显示系统托盘图标
          </label>
        </section>

        <section className="section">
          <h3>截图</h3>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.screenshotAutoDetect ?? true}
              onChange={(e) => onSaveSettings({ screenshotAutoDetect: e.target.checked })}
            />
            呼出时自动探测最新截图
          </label>
          <p className="hint">
            按快捷键呼出窗口时后台扫描截图目录，取最近一张。激活后任意命令运行都会把该截图
            （多模态图片）随消息发给模型；若模型不支持图片，后台自动用本地 OCR 的文字回退。
            /extract 则完全本地 OCR 提取文字，不调用模型。
          </p>
          <div className="field">
            <label>自定义截图目录（可选）</label>
            <input
              value={settings.screenshotDir ?? ""}
              onChange={(e) => void onSaveSettings({ screenshotDir: e.target.value.trim() })}
              placeholder="留空 = 自动探测默认位置"
            />
            <span className="hint">
              搜索顺序：自定义目录 → Win+Shift+S 临时目录 → 图片\Screenshots → 桌面。自动探测取 6 小时内最新；
              截图卡片上的 ⟳ 手动重扫放宽到 24 小时。
            </span>
          </div>
        </section>

        <section className="section">
          <h3>Agent</h3>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.agentTools ?? true}
              onChange={(e) => onSaveSettings({ agentTools: e.target.checked })}
            />
            允许模型自动调用本地工具
          </label>
          <p className="hint">
            开启后，模型在问答时可自主调用三个只读本地工具：读取剪贴板、最新截图本地 OCR、
            获取当前时间（每问最多 4 轮）。调用过程以步骤行展示在结果区，历史记录带 🔧 徽标；
            后端不支持工具调用时自动静默降级为普通问答，回答不受影响。
          </p>
        </section>

        <section className="section">
          <h3>窗口</h3>
          <label className="row gap-8 toggle">
            <input
              type="checkbox"
              checked={settings.autoFitWindow}
              onChange={(e) => {
                if (e.target.checked) {
                  // 重新开启自动适配时清掉记住的手动尺寸
                  if (TAURI) void invoke("set_window_height", { height: 170, width: null }).catch(() => {});
                }
                void onSaveSettings({ autoFitWindow: e.target.checked });
              }}
            />
            窗口大小自动适配内容
          </label>
          <span className="hint">
            开启后：空闲时紧凑、出结果时按内容高度自动伸缩（最高到屏幕 92%）。
            手动拖拽窗口边缘会自动关闭此项，并记住你调整后的尺寸。
          </span>
          <div className="field">
            <label>界面缩放</label>
            <div className="row gap-8">
              {[0.9, 1, 1.15, 1.3].map((z) => (
                <button
                  key={z}
                  className={clsx("ghost", Math.abs((settings.uiScale || 1) - z) < 0.001 && "on")}
                  onClick={() => void onSaveSettings({ uiScale: z })}
                >
                  {Math.round(z * 100)}%
                </button>
              ))}
              <button
                className="ghost"
                title="恢复默认窗口大小（宽 680、并重新开启自动适配）"
                onClick={async () => {
                  if (TAURI) {
                    await invoke("set_window_height", { height: 170, width: 680 }).catch(() => {});
                  }
                  await onSaveSettings({ autoFitWindow: true, uiScale: 1, windowWidth: undefined, windowHeight: undefined });
                }}
              >
                恢复默认尺寸
              </button>
            </div>
            <span className="hint">同时放大字号与窗口，适合高分屏或视力需要。</span>
          </div>
        </section>

        <section className="section">
          <h3>数据</h3>
          <ExportImport onImported={() => window.dispatchEvent(new Event("aibar:import-done"))} />
        </section>

        <section className="section">
          <h3>关于</h3>
          <p className="dim">
            AI 命令栏 · 本地优先的桌面 AI 快捷栏 · 无云服务 · 兼容 OpenAI 接口的模型后端。
          </p>
        </section>
      </div>
    </div>
  );
}
