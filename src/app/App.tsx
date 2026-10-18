// AI Command Bar — main app shell.
//
// Parts:
//  - CommandInput a single-line input where the user types "/explain foo" or
//    plain text for `/ask`.
//  - ContextPreview shows the captured clipboard context with a remove button.
//  - ResultView shows streaming output.
//  - Picker renders when the user types `/` and shows command candidates.
//  - Settings opens as an overlay when the user clicks the gear.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { BUILTIN_COMMANDS, builtinCommand } from "../commands";
import type { AgentStep, ClipImageInfo, Command, ScreenshotMeta, ToolStepEvent } from "../types";
import {
  getModelConfig,
  loadModelConfig,
  onModelConfigChange,
  saveModelConfig,
} from "../stores/modelConfig";
import {
  getSettings,
  loadSettings,
  onSettingsChange,
  saveSettings,
} from "../stores/settings";
import { runCommand } from "../commands/run";
import { openaiCompatible } from "../providers/openai-compatible";
import { truncateChar } from "../utils/text";
import {
  agoText,
  fmtSize,
  loadLatestScreenshot,
  ocrShot,
  probeClipImage,
  saveClipImage,
  shotDataUrl,
  shotKey,
} from "../utils/screenshot";
import { TAURI, invoke } from "../lib/tauri";
import { safeJson, openLogOverlay } from "../utils/logUI";
import { CommandInput } from "../components/CommandInput";
import { ContextPreview } from "../components/ContextPreview";
import { ResultView } from "../components/ResultView";
import { CommandPicker } from "../components/CommandPicker";
import { Settings } from "../components/Settings";
import { HistoryList } from "../components/HistoryList";
import { NotesList } from "../components/NotesList";
import { CustomCommandManager } from "../components/CustomCommandManager";
import { CommandPalette } from "../components/CommandPalette";

type Mode = "idle" | "running" | "done";
type Tab = "result" | "history" | "notes" | "commands" | "settings";

// 一键按钮的中文标签（按命令名取值）
const QUICK_LABELS: Record<string, string> = {
  ask: "提问",
  explain: "解释",
  rewrite: "改写",
  translate: "翻译",
  summarize: "总结",
  code: "代码",
  debug: "调试",
  note: "记笔记",
  prompt: "提示词",
  flashcard: "记忆卡",
  extract: "提取文字",
  describe: "解释截图",
  solve: "解答问题",
};

// 「改写」的常用方向（用户指定：更通顺 / 更正式 / 降重 为主）
const REWRITE_DIRECTIONS = ["更通顺", "更正式", "降重", "更简短", "更口语"];

interface RunState {
  command: Command;
  instruction: string;
  /** 这次运行使用的上下文，用于「重跑」时不丢失。 */
  context: string;
  /** 本次运行开头的时刻（ms），用于计算耗时 / tok·s。 */
  startedAt?: number;
  /** 流式完成（或出错）的时刻（ms）。 */
  doneAt?: number;
  streaming: string;
  final: string;
  error?: string;
  /** agent 路径的工具步骤（ResultView 步骤行展示）。 */
  steps?: AgentStep[];
}

export default function App() {
  const [settings, setSettings] = useState(() => getSettings());
  const [model, setModel] = useState(() => getModelConfig());
  const [context, setContext] = useState("");
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("idle");
  const [tab, setTab] = useState<Tab>("result");
  const [run, setRun] = useState<RunState | null>(null);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [notes, setNotes] = useState<Partial<import("../types").Note>[]>([]);
  const [customCommands, setCustomCommands] = useState<Command[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [noteToast, setNoteToast] = useState<{ id: string; title: string; noteId: string; savedAt: number } | null>(null);
  // M6：命令面板（Ctrl+K）开合 + 面板选中要打开的笔记（nonce 每次选中都变，可重复打开同条）
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteNote, setPaletteNote] = useState<{ id: string; n: number } | null>(null);
  // M7：首次运行引导——连接测试结果（null = 还没测过）
  const [firstTest, setFirstTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [firstTesting, setFirstTesting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Load on mount.
  useEffect(() => {
    loadSettings().then((s) => setSettings(s));
    loadModelConfig().then((m) => setModel(m));
    onSettingsChange(setSettings);
    onModelConfigChange(setModel);
  }, []);

  // Register the global shortcut on startup so Alt+Space works immediately.
  useEffect(() => {
    if (!TAURI) return;
    const s = getSettings();
    const sc = s.globalShortcut || "Alt+Space";
    // 旧实例刚退出时它的 RegisterHotKey 可能尚未释放 → 本次注册失败，
    // 表现为「Alt+Space 唤不出窗口」。这里最多重试 4 次。
    const tryRegister = (attempt: number) => {
      invoke("register_global_shortcut", { shortcut: sc }).catch((e) => {
        if (attempt < 4) {
          window.setTimeout(() => tryRegister(attempt + 1), 500 * (attempt + 1));
        } else {
          console.warn("failed to register global shortcut", e);
        }
      });
    };
    tryRegister(0);
  }, []);

  // Esc hides the window (keyboard-first UX).
  useEffect(() => {
    if (!TAURI) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void invoke("hide_window").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // M6：Ctrl+K 切换命令面板（浏览器 dev 环境同样可用）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 诊断：把所有可疑错误/事件记到 window.__aibarLog，出错时展示在结果区。
  useEffect(() => {
    const w = window as unknown as { __aibarLog?: string[]; __openLog?: () => void };
    if (!w.__aibarLog) w.__aibarLog = [];
    const push = (tag: string, data: unknown) => {
      const line = `[${new Date().toLocaleTimeString()}] ${tag} ${safeJson(data)}`;
      w.__aibarLog!.push(line);
      if (w.__aibarLog!.length > 200) w.__aibarLog = w.__aibarLog!.slice(-200);
    };
    const origError = console.error.bind(console);
    console.error = (...a: unknown[]) => {
      push("console.error", a);
      origError(...(a as []));
    };
    const origWarn = console.warn.bind(console);
    console.warn = (...a: unknown[]) => {
      push("console.warn", a);
      origWarn(...(a as []));
    };
    const onErr = (e: ErrorEvent) => push("window.onerror", { msg: e.message, url: e.filename });
    const onRej = (e: PromiseRejectionEvent) => push("unhandledrejection", e.reason);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    w.__openLog = () => openLogOverlay(w.__aibarLog ?? [], () => void 0);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
      console.error = origError;
      console.warn = origWarn;
    };
  }, []);

  // Capture clipboard on mount and on focus.
  const refreshContext = useCallback(() => {
    if (TAURI) {
      invoke<string>("get_clipboard_text")
        .then((t) => setContext(t ?? ""))
        .catch(() => setContext(""));
    } else {
      navigator.clipboard
        .readText()
        .then((t) => setContext(t ?? ""))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    refreshContext();
  }, [refreshContext]);

  // ============ 最新截图：呼出时自动探测 + 运行时多模态附着 ============
  // 语义：shotActive 时，任意命令运行都会把最新截图随 user 消息发给模型；
  // /extract（ocrOnly）则纯本地 OCR，不走模型。
  const [shot, setShot] = useState<ScreenshotMeta | null>(null);
  const [shotActive, setShotActive] = useState(false);
  const [shotThumbs, setShotThumbs] = useState<Record<string, string>>({});
  const dismissedShotKeyRef = useRef<string | null>(null);

  /** 扫描最新截图。呼出自动探测用 6h 窗口，手动 ⟳ 用 24h 窗口。 */
  const refreshShot = useCallback((manual = false) => {
    if (!TAURI) return;
    if (!manual && !getSettings().screenshotAutoDetect) return;
    void loadLatestScreenshot(manual ? 24 : 6).then((s) => {
      if (!s) return; // 窗口内没有截图：保持现状
      const k = shotKey(s);
      if (k !== dismissedShotKeyRef.current) {
        // 新 key（新截图或重存的图）→ 自动附着；同一张被 ✕ 过的不自动复活
        dismissedShotKeyRef.current = null;
        setShotActive(true);
      }
      setShot((prev) => (prev && shotKey(prev) === k ? prev : s));
      // 预载缩略图（data URL 有缓存，与模型图片共用一份 base64）
      void shotDataUrl(s)
        .then((url) => setShotThumbs((m) => (m[k] ? m : { ...m, [k]: url })))
        .catch(() => {});
    });
  }, []);

  useEffect(() => {
    refreshShot();
  }, [refreshShot]);

  /** 用户手动摘除截图：同 key 不再自动附着，出现新截图后仍会自动附着。 */
  const dismissShot = useCallback(() => {
    if (shot) dismissedShotKeyRef.current = shotKey(shot);
    setShotActive(false);
  }, [shot]);

  /** 当前截图的多模态附着参数；截图文件已删等失败时返回 undefined，命令降级为纯文本。 */
  const attachShotImage = useCallback(
    async (): Promise<{ dataUrl: string; path: string; name: string } | undefined> => {
      if (!shotActive || !shot) return undefined;
      try {
        const dataUrl = await shotDataUrl(shot);
        return { dataUrl, path: shot.path, name: shot.fileName };
      } catch {
        return undefined;
      }
    },
    [shotActive, shot],
  );

  // ============ M2：剪贴板图片附着芯片 ============
  // 剪贴板里留着图片时，在结果页顶部显示「🖼 剪贴板图片 W×H · 附着 / ✕」；
  // 点击「附着」把图片落盘进截图槽（预览 / 模型 / OCR 回退 / 历史全复用）。
  // seq（剪贴板序列号）是新鲜度令牌：dismiss 或附着时记下，同一张图不再提示。
  const [clipImg, setClipImg] = useState<ClipImageInfo | null>(null);
  const [clipErr, setClipErr] = useState<string | null>(null);
  const clipDismissedSeqRef = useRef(0);
  const clipAttachingRef = useRef(false);

  const refreshClipImage = useCallback(() => {
    if (!TAURI) return;
    void probeClipImage().then((info) => {
      if (info && info.seq === clipDismissedSeqRef.current) return; // 同 seq 已 dismiss/消费
      setClipImg(info);
    });
  }, []);

  useEffect(() => {
    refreshClipImage();
  }, [refreshClipImage]);

  /** 摘除芯片：同 seq 不再提示；复制新图（新 seq）仍会提示。 */
  const dismissClipImage = useCallback(() => {
    if (clipImg) clipDismissedSeqRef.current = clipImg.seq;
    setClipImg(null);
    setClipErr(null);
  }, [clipImg]);

  /** 附着：Rust 端再核对一次 seq，防「点击后剪贴板被别人覆盖」。失败仅内联提示。 */
  const attachClipImage = useCallback(async () => {
    if (!clipImg || clipAttachingRef.current) return;
    const seq = clipImg.seq;
    clipDismissedSeqRef.current = seq; // 附着即消费，同图不再提示
    setClipImg(null);
    setClipErr(null);
    clipAttachingRef.current = true;
    try {
      const meta = await saveClipImage(seq);
      const k = shotKey(meta);
      setShot(meta);
      setShotActive(true);
      void shotDataUrl(meta)
        .then((url) => setShotThumbs((m) => (m[k] ? m : { ...m, [k]: url })))
        .catch(() => {});
    } catch (e) {
      setClipErr(e instanceof Error && e.message ? e.message : String(e));
    } finally {
      clipAttachingRef.current = false;
    }
  }, [clipImg]);

  // 附着错误自动淡出（8s）
  useEffect(() => {
    if (!clipErr) return;
    const t = setTimeout(() => setClipErr(null), 8000);
    return () => clearTimeout(t);
  }, [clipErr]);

  // 剪贴板监听：settings.autoCaptureSelection 打开时，Rust 每 100ms 轮询，
  // 文本变化时发 aibar:selection-changed → 自动更新 context。
  useEffect(() => {
    if (!TAURI) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      if (getSettings().autoCaptureSelection) {
        await invoke("start_clipboard_watch", { enabled: true }).catch(() => {});
      }
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<string>("aibar:selection-changed", (e) => {
        setContext(e.payload ?? "");
      });
      if (cancelled) un();
      else unlisten = un;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      if (TAURI) void invoke("start_clipboard_watch", { enabled: false }).catch(() => {});
    };
  }, []);

  // Global shortcut event emitted by Rust after the window is toggled.
  // Refresh clipboard context + detect the latest screenshot.
  useEffect(() => {
    if (!TAURI) return;
    let un: (() => void) | null = null;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("aibar:toggle-window", (e) => {
          void e;
          refreshContext();
          refreshShot();
          refreshClipImage();
        }),
      )
      .then((u) => {
        un = () => u();
      });
    return () => un?.();
  }, [refreshContext, refreshShot, refreshClipImage]);

  // Load custom commands + history.
  const refreshCustom = useCallback(() => {
    if (TAURI) {
      invoke<Record<string, unknown>[]>("list_custom_commands")
        .then((list) => {
          const built: Command[] = list.map((c, i) => {
            const rec = c as unknown as {
              id?: string;
              name?: string;
              description?: string;
              promptTemplate?: string;
              prompt_template?: string;
              enabled?: boolean;
              createdAt?: string;
            };
            return {
              id: rec.id ?? `custom-${i}`,
              name: rec.name ?? "",
              description: rec.description ?? "",
              promptTemplate: rec.promptTemplate ?? rec.prompt_template ?? "",
              kind: "custom" as const,
              enabled: rec.enabled ?? true,
              createdAt: rec.createdAt ?? new Date().toISOString(),
            };
          });
          setCustomCommands(built);
        })
        .catch(() => setCustomCommands([]));
    }
  }, []);

  const refreshHistory = useCallback(() => {
    if (TAURI) {
      invoke<Record<string, unknown>[]>("list_history")
        .then(setHistory)
        .catch(() => setHistory([]));
    }
  }, []);

  const refreshNotes = useCallback(async () => {
    if (TAURI) {
      try {
        const list = await invoke<Partial<import("../types").Note>[]>("list_notes");
        setNotes(list ?? []);
      } catch (e) {
        console.error(e);
      }
    }
  }, []);

  useEffect(() => {
    // mount 时拉一次历史 / 命令 / 笔记（M6：命令面板打开时笔记列表要就绪）
    refreshCustom();
    refreshHistory();
    void refreshNotes();
  }, [refreshCustom, refreshHistory, refreshNotes]);

  // 切到 notes tab 时拉笔记
  useEffect(() => {
    if (tab === "notes") void refreshNotes();
  }, [tab, refreshNotes]);

  // /note 完成后弹 toast
  useEffect(() => {
    if (mode !== "done" || !run?.final || run.command.name !== "note") return;
    // 解析第一行作为标题，其余作为内容
    const lines = run.final.replace(/\r\n/g, "\n").split("\n");
    let title = lines.find((l) => l.trim()) ?? "未命名";
    let content = run.final.trim();
    // 若首行看起来像 heading，则 title = heading，content 保留其余
    const m = run.final.match(/^#\s+(.*)$/m);
    if (m) title = m[1].trim();
    const note = {
      id: crypto.randomUUID?.() ?? `note-${Date.now()}`,
      title: title.slice(0, 80),
      content,
      tags: ["自动生成", "来自/note"],
      createdAt: new Date().toISOString(),
    };
    void invoke("save_note", { note })
      .then(() => {
        setNoteToast({ id: note.id, title: note.title, noteId: note.id, savedAt: Date.now() });
        void refreshNotes();
      })
      .catch((e) => console.error("/note 落地失败", e));
  }, [mode, run?.final, run?.command?.name, refreshNotes]);

  // toast 自动 6 秒消
  useEffect(() => {
    if (!noteToast) return;
    const t = window.setTimeout(() => setNoteToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [noteToast]);

  // M7：首次引导 banner「测试连接」——按当前模型配置走 provider 的 test，结果内联展示
  const runFirstTest = useCallback(async () => {
    setFirstTesting(true);
    setFirstTest(null);
    try {
      const cfg = getModelConfig();
      const res = await openaiCompatible.testConnection(cfg);
      setFirstTest(
        res.ok
          ? { ok: true, msg: `连接成功 · ${res.latencyMs ?? "--"} ms` }
          : { ok: false, msg: res.message },
      );
    } catch (e) {
      setFirstTest({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setFirstTesting(false);
    }
  }, []);

  const rerunHistory = useCallback(
    (e: {
      command?: string;
      input?: string;
      contextPreview?: string;
      screenshotName?: string;
    }) => {
      const cmd = builtinCommand(e.command ?? "") ?? customCommands.find((c) => c.name === e.command);
      if (!cmd) return;
      setTab("result");
      setRun(null);
      setMode("idle");
      setInput(`/${cmd.name} ${e.input ?? ""}`.trim());
      // 若有 contextPreview，最先尝试原样恢复（提示用户这是过去的内容）。
      // 原本附带截图的条目不恢复「[截图] xxx」假文本——附着以本次探测为准。
      if (e.contextPreview && !e.screenshotName) setContext(e.contextPreview);
      // 焦点回到输入框
      setTimeout(() => document.getElementById("cmd-input")?.focus(), 50);
    },
    [customCommands],
  );

  // All commands (builtins + enabled customs).
  const allCommands = useMemo<Command[]>(
    () => [
      ...BUILTIN_COMMANDS.filter((c) => c.enabled),
      ...customCommands.filter((c) => c.enabled),
    ],
    [customCommands],
  );

  // Parser: split input into { command, instruction }.
  const parsed = useMemo(() => {
    const m = input.match(/^\s*(\/[a-z0-9_\-]+)\s*(.*)$/is);
    if (m) {
      const name = m[1].slice(1).toLowerCase();
      const instruction = m[2].trim();
      const command = builtinCommand(name) ?? customCommands.find((c) => c.name === name);
      if (command) return { command, instruction };
    }
    return { command: builtinCommand("ask"), instruction: input.trim() };
  }, [input, customCommands]);

  // M5 智能建议：输入框里像报错（≥20 字、无命令前缀、命中报错关键词）时，
  // 在输入行上方提示「⚡ 看起来像报错 · 点击用 /debug 分析」。纯前端启发式。
  const errorSuggestion = useMemo(() => {
    if (mode !== "idle") return false;
    const t = input.trim();
    if (t.length < 20 || t.startsWith("/")) return false;
    return /error|exception|traceback|panic|segfault|errno|stack ?trace|unhandled|failed|报错|异常|失败/i.test(
      t,
    );
  }, [mode, input]);
  const debugCmd = useMemo(() => builtinCommand("debug"), []);

  const commandName = parsed.command?.name ?? "";
  const modeArg = parsed.command?.modes?.find((mo) =>
    parsed.instruction.toLowerCase().startsWith(mo.toLowerCase()),
  );

  // 运行开始时把窗口拉高，保证结果区有足够显示空间；结束后恢复。
  // 「放大」可进一步铺满屏幕，方便一次读完长回答。
  const [expanded, setExpanded] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const tallMode = run !== null && (mode === "running" || mode === "done");

  // ============ 窗口尺寸：自动适配 + 手动拖拽接管 ============
  // 规则：
  //  - autoFitWindow = true （默认）：程序根据「屏幕/DPI + 内容高度」自动调整窗口
  //  - autoFitWindow = false：用户拖拽过边缘，改为记住其尺寸，程序不再插手
  //
  // 难点：程序自己改尺寸也会触发 onResized，必须和「用户拖拽」区分开。
  // 这里用三重判据：① 刚由程序设置的时间窗内忽略；② 尺寸与程序目标一致则忽略；
  // ③ 启动后短暂宽限期内一律忽略（初始化/首次显示会改尺寸）。
  const suppressResizeUntilRef = useRef(0);
  const lastTargetRef = useRef<{ w: number; h: number } | null>(null);
  const bootAtRef = useRef(Date.now());
  const uiScale = settings.uiScale || 1;

  /** 按「逻辑像素」设置窗口尺寸（null 表示保持当前宽度）。 */
  const setWindowLogical = useCallback((w: number | null, h: number) => {
    if (!TAURI) return;
    suppressResizeUntilRef.current = Date.now() + 1000;
    void invoke("set_window_height", {
      height: Math.round(h),
      width: w == null ? null : Math.round(w),
    })
      .then(async () => {
        // 记录程序设定的实际尺寸，供判据②使用
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          const scale = await win.scaleFactor();
          const s = await win.innerSize();
          lastTargetRef.current = {
            w: Math.round(s.width / scale),
            h: Math.round(s.height / scale),
          };
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
  }, []);

  // M6：打开命令面板时保证窗口够高（空闲态只有 160px 会把面板挤扁）；只拉高、不收回。
  useEffect(() => {
    if (!paletteOpen || !TAURI) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const scale = await win.scaleFactor();
        const s = await win.innerSize();
        if (!cancelled && s.height / scale < 380) setWindowLogical(null, 460);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paletteOpen, setWindowLogical]);

  /** 依据屏幕可用区域与内容高度算出一个合适的目标高度（CSS 像素）。 */
  const idealCssHeight = useCallback((kind: "idle" | "work" | "full" | "content") => {
    const availH = window.screen?.availHeight || 900;
    if (kind === "idle") return 170;
    if (kind === "work") return Math.max(420, Math.min(Math.round(availH * 0.6), 1200));
    if (kind === "full") return Math.max(480, Math.min(Math.round(availH * 0.94), 1600));
    // content
    const app = document.querySelector(".aibar") as HTMLElement | null;
    const body = document.querySelector(".result-body") as HTMLElement | null;
    if (!app || !body) return Math.max(420, Math.min(Math.round(availH * 0.6), 1200));
    const maxH = Math.round(availH * 0.92);
    const chrome = app.clientHeight - body.clientHeight;
    const needed = chrome + body.scrollHeight + 6;
    return Math.max(240, Math.min(needed, maxH));
  }, []);

  // 界面缩放（webview zoom）
  useEffect(() => {
    if (!TAURI) return;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        await getCurrentWebview().setZoom(uiScale);
      } catch {
        /* ignore */
      }
    })();
  }, [uiScale]);

  // 主尺寸逻辑
  useEffect(() => {
    if (!TAURI) return;
    const z = getSettings().uiScale || 1;
    if (expanded) {
      const availW = window.screen?.availWidth || 1200;
      const w = Math.max(680, Math.min(Math.round(availW * 0.55), 1500));
      setWindowLogical(w * z, idealCssHeight("full") * z);
      return;
    }
    if (!settings.autoFitWindow) return; // 用户已接管
    let h = idealCssHeight(tallMode ? "work" : "idle");
    // 截图卡片显示时空闲窗口也要装下卡片 + 上下文 + 快捷行
    if (!tallMode && shotActive) h = Math.max(h, 340);
    setWindowLogical(null, h * z);
  }, [tallMode, expanded, settings.autoFitWindow, uiScale, shotActive, setWindowLogical, idealCssHeight]);

  // 结果生成完成后，按内容高度收紧窗口（读多长就开多大）
  useEffect(() => {
    if (!TAURI || !settings.autoFitWindow || expanded) return;
    if (mode !== "done") return;
    const t = window.setTimeout(() => {
      const z = getSettings().uiScale || 1;
      setWindowLogical(null, idealCssHeight("content") * z);
    }, 200);
    return () => window.clearTimeout(t);
  }, [mode, run?.final, expanded, settings.autoFitWindow, uiScale, setWindowLogical, idealCssHeight]);

  // 用户拖拽边缘 → 记住尺寸并接管（关闭自动适配）
  useEffect(() => {
    if (!TAURI) return;
    let unlisten: (() => void) | null = null;
    let timer: number | null = null;
    let disposed = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const un = await win.onResized((event) => {
          const size = event.payload;
          const now = Date.now();
          // ① 程序刚设置过尺寸 → 忽略
          if (now < suppressResizeUntilRef.current) return;
          // ③ 启动宽限期内 → 忽略（初始化/首次显示会改尺寸）
          if (now - bootAtRef.current < 2500) return;
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            void (async () => {
              try {
                const scale = await win.scaleFactor();
                const w = Math.round(size.width / scale);
                const h = Math.round(size.height / scale);
                // ② 与程序设定目标一致 → 忽略（自己触发的）
                const t = lastTargetRef.current;
                if (t && Math.abs(t.w - w) <= 3 && Math.abs(t.h - h) <= 3) return;
                // 至此判定为「用户拖拽」：记住尺寸并接管
                await saveSettings({
                  autoFitWindow: false,
                  windowWidth: w,
                  windowHeight: h,
                });
              } catch {
                /* ignore */
              }
            })();
          }, 450);
        });
        if (disposed) un();
        else unlisten = un;
      } catch {
        /* ignore */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // 启动时若用户已接管，恢复记住的尺寸
  useEffect(() => {
    if (!TAURI) return;
    if (settings.autoFitWindow) return;
    if (settings.windowWidth && settings.windowHeight) {
      setWindowLogical(settings.windowWidth, settings.windowHeight);
    }
  }, [settings.autoFitWindow, settings.windowWidth, settings.windowHeight, setWindowLogical]);

  // ===== agent 工具步骤跟踪：每次运行建一个 tracker 实例 =====
  // Rust agent 循环发 ai:tool:step（phase: call → done）；这里维护 steps 数组
  //（供 ResultView 步骤行）与调用总次数（供 history agentToolCalls 徽标）。
  const makeStepTracker = () => {
    const stepsLocal: AgentStep[] = [];
    let calls = 0;
    const handle = (ev: ToolStepEvent) => {
      if (ev.phase === "call") {
        calls += 1;
        stepsLocal.push({ name: ev.name, ok: true, pending: true });
      } else {
        // 从尾部回填最近一个同名且未完成的步骤（同名工具多轮调用时保证 1:1 配对）
        for (let i = stepsLocal.length - 1; i >= 0; i--) {
          const s = stepsLocal[i];
          if (s.name === ev.name && s.pending) {
            stepsLocal[i] = {
              name: s.name,
              ok: !!ev.ok,
              ms: ev.ms,
              preview: ev.preview,
              pending: false,
            };
            break;
          }
        }
      }
      const snap = stepsLocal.map((s) => ({ ...s }));
      setRun((r) => (r ? { ...r, steps: snap } : null));
    };
    return { handle, calls: () => calls };
  };

  const execute = useCallback(
    async (cmd: Command, instruction: string, ctx: string) => {
      if (mode === "running") return;
      setTab("result");
      setExpanded(false);
      setMode("running");
      setRun({
        command: cmd,
        instruction,
        context: ctx,
        startedAt: Date.now(),
        streaming: "",
        final: "",
        steps: [],
      });
      // 立即给一个工作高度（首次运行时主尺寸 effect 也会触发，这里是后续运行的补充）
      if (TAURI && getSettings().autoFitWindow) {
        setWindowLogical(null, idealCssHeight("work") * (getSettings().uiScale || 1));
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const modelCfg = getModelConfig();
      // 截图附着语义：
      //  - /extract（ocrOnly）：纯本地 OCR，不走模型
      //  - 其他命令：截图处于附着状态时，把图片随 user 消息发给模型
      //    （rust.rs 端在模型 400 拒图时自动回退本地 OCR 文字，前端无感）
      const shotMeta = (cmd.ocrOnly || shotActive) && shot ? shot : null;
      let full = "";
      try {
        const tracker = makeStepTracker();
        let imageArg: { dataUrl: string; path: string; name: string } | undefined;
        if (cmd.ocrOnly) {
          if (!shot) {
            throw new Error("未找到可用的截图。先截一张图（如 Win+Shift+S），再运行。");
          }
          full = await ocrShot(shot);
        } else {
          imageArg = await attachShotImage();
          full = await runCommand(
            {
              command: cmd,
              instruction,
              context: ctx,
              model: modelCfg,
              maxContextLength: getSettings().maxContextLength,
              image: imageArg,
              // agent 路径：模型可自决调用只读本地工具（剪贴板/截图 OCR/时间），
              // 后端不支持 tools 时 Rust 端静默降级为经典问答。
              agent: getSettings().agentTools ?? true,
            },
            (t) => {
              setRun((r) => (r ? { ...r, streaming: r.streaming + t } : null));
            },
            ctrl.signal,
            tracker.handle,
          );
        }
        setRun((r) =>
          r ? { ...r, streaming: full, final: full, doneAt: Date.now() } : null,
        );
        setMode("done");
        if (getSettings().saveHistory) {
          const entry = {
            id: crypto.randomUUID?.() ?? `${Date.now()}`,
            command: cmd.name,
            input: instruction,
            output: full,
            model: cmd.ocrOnly ? "本地 OCR" : modelCfg.model,
            contextPreview: shotMeta ? `[截图] ${shotMeta.fileName}` : truncateChar(ctx, 240),
            contextLength: ctx.length,
            createdAt: new Date().toISOString(),
            ...(shotMeta
              ? { screenshotPath: shotMeta.path, screenshotName: shotMeta.fileName }
              : {}),
            ...(tracker.calls() ? { agentToolCalls: tracker.calls() } : {}),
          };
          if (TAURI) {
            void invoke("save_history", { entry }).then(refreshHistory).catch(() => {});
            setHistory((h) => [entry, ...h].slice(0, getSettings().maxHistoryEntries));
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setRun((r) =>
          r ? { ...r, streaming: full, final: full, error: msg, doneAt: Date.now() } : null,
        );
        setMode("done");
      } finally {
        abortRef.current = null;
      }
    },
    [mode, shot, shotActive, attachShotImage, refreshHistory, setWindowLogical, idealCssHeight],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    // Tauri 模式下流式请求在 Rust 侧执行，AbortController 无法中断，
    // 需要显式通知后端取消（会保留已生成的部分内容）。
    if (TAURI) {
      void invoke("ai_cancel").catch(() => {});
    }
  }, []);

  const onEnter = useCallback(() => {
    if (mode === "running") {
      stop();
      return;
    }
    if (!parsed.command) return;
    // 无文本时，仅当有附着的截图才允许运行（截图本身就是目标）
    if (!context.trim() && !parsed.instruction && !(shotActive && shot)) return;
    execute(parsed.command, parsed.instruction, context);
  }, [mode, parsed, context, shotActive, shot, execute, stop]);

  const removeContext = useCallback(() => {
    setContext("");
  }, []);

  const saveOpenModel = useCallback(
    async (patch: Parameters<typeof saveModelConfig>[0], opts?: { saveKey?: boolean }) => {
      const m = await saveModelConfig(patch, opts);
      setModel(m);
      return m;
    },
    [],
  );

  const saveOpenSettings = useCallback(
    async (patch: Partial<import("../types").AppSettings>) => {
      const s = await saveSettings(patch);
      setSettings(s);
      return s;
    },
    [],
  );

  const onBackspace = useCallback(() => {
    setInput((v) => v.replace(/\w$/, ""));
  }, []);

  /** 重跑上一次真实参数（而非当前输入框的 parsed）。 */
  const retry = useCallback(() => {
    if (mode === "running") return;
    if (!run) return;
    execute(run.command, run.instruction, run.context);
  }, [mode, run, execute]);

  /** 追问:把当前 instruction(reuse run.instruction 或 input)作为下一轮 user 消息。
   *  只对 reference 类命令启用(/ask 等);重试会替换原上下文。 */
  const conversationRef = useRef<import("../types").ChatMessage[]>([]);

  const onContinueAsQuestion = useCallback(() => {
    if (mode === "running" || !run) return;
    if (run.command.contextRole !== "reference") return;
    const next = conversationRef.current;
    // 把上一轮 assistant 输出 + 用户当前输入再加入
    if (run.final.trim()) next.push({ role: "assistant", content: run.final });
    const question = (input.trim() || run.instruction.trim());
    if (question) next.push({ role: "user", content: question });
    // 归档自己的 conversation 副本,供下次继续
    conversationRef.current = next;
    // 清掉 input 区 + rerun 同一 command,带 conversation
    const ctx = run.context;
    const instruction = input.trim() || run.instruction;
    // 走同一入口 + 侦察:复用 execute,但调整 conversation 注入
    setRun({
      command: run.command,
      instruction,
      context: ctx,
      startedAt: Date.now(),
      streaming: "",
      final: "",
      steps: [],
    });
    setMode("running");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const modelCfg = getModelConfig();
    void (async () => {
      try {
        const tracker = makeStepTracker();
        const full = await runCommand(
          {
            command: run.command!,
            instruction,
            context: ctx,
            model: modelCfg,
            maxContextLength: getSettings().maxContextLength,
            conversation: next,
            image: await attachShotImage(),
            agent: getSettings().agentTools ?? true,
          },
          (t) => setRun((r) => (r ? { ...r, streaming: r.streaming + t } : null)),
          ctrl.signal,
          tracker.handle,
        );
        setRun((r) => (r ? { ...r, streaming: full, final: full, doneAt: Date.now() } : null));
        setMode("done");
        if (getSettings().saveHistory) {
          const entry = {
            id: crypto.randomUUID?.() ?? `${Date.now()}`,
            command: run.command!.name,
            input: instruction,
            output: full,
            model: modelCfg.model,
            contextPreview: truncateChar(ctx, 240),
            contextLength: ctx.length,
            createdAt: new Date().toISOString(),
            ...(tracker.calls() ? { agentToolCalls: tracker.calls() } : {}),
          };
          if (TAURI) void invoke("save_history", { entry }).then(refreshHistory).catch(() => {});
          setHistory((h) => [entry, ...h].slice(0, getSettings().maxHistoryEntries));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setRun((r) => (r ? { ...r, error: msg, doneAt: Date.now() } : null));
        setMode("done");
      } finally {
        abortRef.current = null;
      }
    })();
  }, [mode, run, input, attachShotImage, refreshHistory]);

  const onTab = useCallback(() => {
    // Accept first suggestion if picker visible
    if (pickerVisible && commandName !== "") {
      const match = allCommands.find((c) => c.name === commandName);
      if (match && modeArg) {
        // Move mode into the candidate highlight — trivial, do nothing.
      }
    }
  }, [pickerVisible, commandName, allCommands, modeArg]);

  const focused = pickerVisible;
  void focused;

  return (
    <div className="aibar shell">
      <div className="shell-head" data-tauri-drag-region="deep">
        <div className="brand">
          <span className="logo-dot" />
          AI 命令栏
        </div>
        <div className="head-actions">
          <button
            className={clsx("ghost", tab === "history" && "on")}
            title={tab === "history" ? "返回主界面" : "历史记录"}
            onClick={() => setTab(tab === "history" ? "result" : "history")}
          >
            ⏱
          </button>
          <button
            className={clsx("ghost", tab === "notes" && "on")}
            title={tab === "notes" ? "返回主界面" : "本地笔记"}
            onClick={() => setTab(tab === "notes" ? "result" : "notes")}
          >
            📝
          </button>
          <button
            className={clsx("ghost", tab === "commands" && "on")}
            title={tab === "commands" ? "返回主界面" : "管理命令"}
            onClick={() => setTab(tab === "commands" ? "result" : "commands")}
          >
            ≡
          </button>
          <button
            className={clsx("ghost", tab === "settings" && "on")}
            title={tab === "settings" ? "返回主界面" : "设置"}
            onClick={() => setTab(tab === "settings" ? "result" : "settings")}
          >
            ⚙
          </button>
          <button
            className="ghost"
            title="打开开发者工具（Ctrl+Shift+I）"
            onClick={() => {
              // devtools 只能在 debug 构建里切换；失败时静默忽略。
              void invoke("plugin:window|toggle_devtools")
                .catch(() => {});
            }}
          >
            🐞
          </button>
          <button
            className="ghost"
            title="看底层日志（Ctrl+Shift+L）"
            onClick={() => (window as unknown as { __openLog?: () => void }).__openLog?.()}
          >
            📋
          </button>
          <button
            className="ghost"
            title="重新捕获剪贴板"
            onClick={refreshContext}
            disabled={mode === "running"}
          >
            ⟳
          </button>
          <button
            className="ghost"
            title="隐藏（Esc）"
            onClick={() => {
              if (TAURI) void invoke("hide_window").catch(() => {});
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {tab === "settings" ? (
        <Settings
          settings={settings}
          model={model}
          onClose={() => setTab("result")}
          onSaveSettings={saveOpenSettings}
          onSaveModel={saveOpenModel}
        />
      ) : tab === "history" ? (
        <HistoryList
          entries={history}
          onClear={() => TAURI && invoke("clear_history").then(refreshHistory).catch(() => {})}
          onChanged={refreshHistory}
          onRerun={rerunHistory}
          onNoteSaved={refreshNotes}
          onBack={() => setTab("result")}
        />
      ) : tab === "notes" ? (
        <NotesList
          refresh={refreshNotes}
          openNoteId={paletteNote?.id}
          openNoteNonce={paletteNote?.n}
          onBack={() => setTab("result")}
        />
      ) : tab === "commands" ? (
        <CustomCommandManager
          commands={customCommands}
          onChanged={refreshCustom}
          onClose={() => setTab("result")}
        />
      ) : (
        <div className="shell-body">
          {/* M7：首次运行引导——首条历史落库后（history.length>0）自动消失 */}
          {!run && history.length === 0 && (
            <div className="first-banner">
              <div className="first-title">👋 第一次使用 AI 命令栏</div>
              <div className="first-lines dim">
                <div>
                  ① 输入问题或 <b>/ask</b> <b>/explain</b> 等命令，回车运行
                </div>
                <div>
                  ② 选中文字用 <b>/rewrite</b> <b>/summarize</b>；或 Win+Shift+S 截图后 <b>/describe</b>
                </div>
                <div>
                  ③ <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">K</kbd> 随时打开命令面板（搜
                  命令 / 历史 / 笔记）
                </div>
              </div>
              <div className="first-actions">
                <button className="ghost small" onClick={() => setTab("settings")}>
                  去设置
                </button>
                <button
                  className="ghost small"
                  onClick={() => void runFirstTest()}
                  disabled={firstTesting}
                >
                  {firstTesting ? "测试中…" : "测试连接"}
                </button>
                {firstTest && (
                  <span className={clsx("first-test", firstTest.ok ? "ok" : "err")} title={firstTest.msg}>
                    {firstTest.ok ? "✓ " : "✗ "}
                    {firstTest.msg}
                  </span>
                )}
              </div>
            </div>
          )}
          {shotActive && shot && (
            <div className="shot-card">
              {shotThumbs[shotKey(shot)] ? (
                <img
                  className="shot-thumb"
                  src={shotThumbs[shotKey(shot)]}
                  alt={shot.fileName}
                  draggable={false}
                />
              ) : (
                <div className="shot-thumb shot-thumb-loading dim">…</div>
              )}
              <div className="shot-info">
                <div className="shot-name" title={shot.path}>
                  {shot.fileName}
                </div>
                <div className="shot-meta dim">
                  {fmtSize(shot.sizeBytes)} · {agoText(shot.modifiedMs)}
                  {shot.width && shot.height ? ` · ${shot.width}×${shot.height}` : ""}
                </div>
                <div className="shot-hint dim">下次运行将自动附带这张截图</div>
              </div>
              <div className="shot-actions">
                <button
                  className="ghost small"
                  title="重扫最新截图（24 小时窗口）"
                  disabled={mode === "running"}
                  onClick={() => refreshShot(true)}
                >
                  ⟳
                </button>
                <button
                  className="ghost small"
                  title="摘除截图（同一张图下次不会自动附带；截新图后仍会附着）"
                  onClick={dismissShot}
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {!shotActive && clipImg && (
            <div className="clip-chip" title="剪贴板里有图片，附着后下次运行会发送给模型">
              <span className="clip-chip-label">
                🖼 剪贴板图片 <b>{clipImg.width}×{clipImg.height}</b>
              </span>
              <button
                className="ghost small clip-chip-attach"
                disabled={mode === "running"}
                onClick={() => void attachClipImage()}
              >
                附着
              </button>
              <button
                className="ghost small"
                title="不再提示这张图（复制新图后仍会提示）"
                onClick={dismissClipImage}
              >
                ✕
              </button>
            </div>
          )}
          {clipErr && (
            <div className="clip-chip-err" title={clipErr}>
              {clipErr}
            </div>
          )}

          <ContextPreview
            text={context}
            onRemove={removeContext}
            onRecapture={refreshContext}
            maxContextLength={settings.maxContextLength}
          />

          {/* 一键运行按钮：点一下直接对复制的内容执行对应命令 */}
          <div className="quick-row">
            {BUILTIN_COMMANDS.filter((c) => c.enabled && c.contextRole !== "image").map((c) => (
              <button
                key={c.id}
                className="quick-btn"
                title={
                  c.name === "rewrite"
                    ? "改写这段文字（可选择方向）"
                    : `对复制的内容执行 /${c.name}`
                }
                disabled={mode === "running" || (!context.trim() && !input.trim())}
                onClick={() => {
                  const blur = (document.activeElement as HTMLElement | null)?.blur;
                  blur?.call(document.activeElement as HTMLElement | null);
                  if (c.name === "rewrite") {
                    setRewriteOpen((v) => !v);
                    return;
                  }
                  setRewriteOpen(false);
                  execute(c, "", context);
                }}
              >
                {QUICK_LABELS[c.name] ?? c.name}
              </button>
            ))}
            {shotActive &&
              shot &&
              BUILTIN_COMMANDS.filter((c) => c.enabled && c.contextRole === "image").map((c) => (
                <button
                  key={c.id}
                  className="quick-btn shotty"
                  title={`附带截图 ${shot.fileName} 运行 /${c.name}`}
                  disabled={mode === "running"}
                  onClick={() => {
                    (document.activeElement as HTMLElement | null)?.blur?.();
                    execute(c, "", context);
                  }}
                >
                  {QUICK_LABELS[c.name] ?? c.name}
                </button>
              ))}
            <button
              className="quick-btn ghosty"
              title="清空并手动输入"
              onClick={() => {
                setRun(null);
                setMode("idle");
                document.getElementById("cmd-input")?.focus();
              }}
            >
              手动输入
            </button>
          </div>

          {rewriteOpen && (
            <div className="rewrite-row">
              <span className="dim">改写方向：</span>
              {REWRITE_DIRECTIONS.map((d) => (
                <button
                  key={d}
                  className="quick-btn"
                  disabled={mode === "running" || !context.trim()}
                  onClick={() => {
                    setRewriteOpen(false);
                    const rw = BUILTIN_COMMANDS.find((c) => c.name === "rewrite");
                    if (rw) execute(rw, d, context);
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
          )}

          {pickerVisible && (
            <CommandPicker
              commands={allCommands}
              query={commandName || ""}
              onPick={(c) => {
                setInput((v) => {
                  const m = v.match(/^\s*\/[a-z0-9_\-]*/i);
                  if (!m) return `/${c.name} `;
                  return `${m[0]}${c.name}`;
                });
                setPickerVisible(false);
              }}
              onDismiss={() => setInput((v) => v.replace(/\/$/, ""))}
              highlightMode={modeArg}
            />
          )}

          {errorSuggestion && debugCmd && (
            <div
              className="err-suggest"
              role="button"
              tabIndex={0}
              onClick={() => execute(debugCmd, "", input)}
              onKeyDown={(e) => {
                if (e.key === "Enter") execute(debugCmd, "", input);
              }}
            >
              ⚡ 看起来像报错 · 点击用 /debug 分析
            </div>
          )}

          <div className="input-row">
            <CommandInput
              value={input}
              running={mode === "running"}
              onChange={(v) => {
                setInput(v);
                setPickerVisible(/^\/([a-z0-9_\-]*)$/i.test(v));
              }}
              onEnter={onEnter}
              onBackspace={onBackspace}
              onTab={onTab}
            />
            {mode === "running" ? (
              <button className="danger" onClick={stop}>
                停止
              </button>
            ) : (
              <button
                className="primary"
                onClick={onEnter}
                disabled={!parsed.command}
                title="运行（Enter）"
              >
                运行
              </button>
            )}
          </div>

          <ResultView
            run={run}
            running={mode === "running"}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
            onCollapse={() => {
              setExpanded(false);
              setRun(null);
            }}
            onCopy={() => {
              if (!run?.final) return;
              if (TAURI) {
                void invoke("set_clipboard_text", { text: run.final });
              } else {
                navigator.clipboard.writeText(run.final).catch(() => {});
              }
            }}
            onReplace={() => {
              if (!run?.final) return;
              if (TAURI) {
                void invoke("set_clipboard_text", { text: run.final });
              } else {
                navigator.clipboard.writeText(run.final).catch(() => {});
              }
            }}
            onRetry={retry}
            onContinue={
              run && parsed.command && run.command.contextRole === "reference"
                ? onContinueAsQuestion
                : undefined
            }
          />

          {noteToast && (
            <div className="toast toast-success">
              <span className="dim">已存为笔记：{noteToast.title}</span>
              <div className="spacer" />
              <button className="ghost small" onClick={() => setTab("notes")}>
                查看
              </button>
              <button className="ghost small" onClick={() => setNoteToast(null)}>
                ✕
              </button>
            </div>
          )}

          <div className="foot-hint" data-tauri-drag-region="deep">
            <kbd className="kbd">Enter</kbd> 运行 · <kbd className="kbd">Esc</kbd> 隐藏 ·{" "}
            <kbd className="kbd">Alt</kbd>+<kbd className="kbd">Space</kbd> 呼出 ·{" "}
            <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">K</kbd> 面板 ·{" "}
            <span className="dim">/</span> 输入命令 · <span className="dim">{settings.globalShortcut}</span>
          </div>
        </div>
      )}

      {/* M6：命令面板 overlay（Ctrl+K） */}
      {paletteOpen && (
        <CommandPalette
          commands={allCommands}
          history={history}
          notes={notes}
          onPickCommand={(name) => {
            setInput(`/${name} `);
            setPaletteOpen(false);
            setTimeout(() => document.getElementById("cmd-input")?.focus(), 30);
          }}
          onPickHistory={(entry) => {
            setPaletteOpen(false);
            rerunHistory({
              command: typeof entry.command === "string" ? entry.command : undefined,
              input: typeof entry.input === "string" ? entry.input : undefined,
              contextPreview:
                typeof entry.contextPreview === "string" ? entry.contextPreview : undefined,
              screenshotName:
                typeof entry.screenshotName === "string" ? entry.screenshotName : undefined,
            });
          }}
          onPickNote={(id) => {
            setPaletteNote({ id, n: Date.now() });
            setTab("notes");
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
