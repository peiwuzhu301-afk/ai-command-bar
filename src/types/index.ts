// Shared domain types for AI Command Bar.

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  /** 当前使用的 preset id（None = 未绑定 preset，直接用 baseUrl/model） */
  activePresetId?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** 图片 data URL（多模态）。Rust 端把它展开成 OpenAI content parts 下发。 */
  image?: string;
  /** 图片本地路径（不上传；模型不支持图片时 Rust 端用它做本地 OCR 回退）。 */
  imagePath?: string;
}

/** Rust 端扫描到的最新截图元信息（camelCase 对应 screenshot.rs 的 ScreenshotMeta）。 */
export interface ScreenshotMeta {
  path: string;
  fileName: string;
  sizeBytes: number;
  modifiedMs: number;
  modifiedIso: string;
  width?: number;
  height?: number;
}

/** 去重/失效用的截图 key：路径+修改时间，新截图出现后 key 变化。 */
export type ScreenshotKey = string;

/** M2：探测到的剪贴板图片（seq 是剪贴板序列号，附着时比对防内容已变）。 */
export interface ClipImageInfo {
  width: number;
  height: number;
  seq: number;
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  stream: boolean;
  /** 启用 agent 工具调用（只读本地工具：剪贴板 / 截图 OCR / 当前时间）。 */
  agent?: boolean;
}

/** Rust agent 循环发出的工具调用进度事件（ai:tool:step 的 payload）。 */
export interface ToolStepEvent {
  phase: "call" | "done";
  name: string;
  /** 工具返回值预览（截断 80 字符）或错误信息。 */
  preview?: string;
  /** 耗时（ms），仅 done 阶段带。 */
  ms?: number;
  /** 本次调用是否成功，仅 done 阶段带。 */
  ok?: boolean;
}

/** 前端聚合的工具步骤（ResultView 步骤行 + 历史统计用）。 */
export interface AgentStep {
  name: string;
  ok: boolean;
  ms?: number;
  preview?: string;
  /** true = 进行中（收到 call、还没收到 done）。 */
  pending?: boolean;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  models?: string[];
  model?: string;
}

export type CommandKind = "builtin" | "custom";

export interface Command {
  id: string;
  name: string; // e.g. "rewrite" (no leading slash)
  description: string;
  promptTemplate: string;
  kind: CommandKind;
  enabled: boolean;
  // Optional sub-modes, e.g. rewrite -> 更通顺/更正式/...
  modes?: string[];
  /**
   * 内容扮演什么角色：
   *  - "target"（默认）：这就是要处理的正文（改写/翻译/总结/解释/调试…）
   *  - "reference"：仅作为回答问题的参考材料（如 /ask）
   *  - "image"：目标是一张截图，截图以多模态图片随消息发给模型（如 /describe）
   */
  contextRole?: "target" | "reference" | "image";
  /** 不走模型，纯本地 OCR 提取文字（如 /extract）。 */
  ocrOnly?: boolean;
  /**
   * 输出语言：
   *  - "zh"（默认）：强制简体中文
   *  - "auto"：由任务决定（翻译命令用，允许输出目标语言）
   */
  outputLanguage?: "zh" | "auto";
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  command: string;
  input: string;
  output: string;
  model: string;
  contextPreview?: string;
  contextLength?: number;
  createdAt: string;
  /** 当时附带的最新截图（重跑时可恢复；文件可能已不存在）。 */
  screenshotPath?: string;
  screenshotName?: string;
  /** agent 路径执行的工具调用次数（0/无 = 经典问答，不显示徽标）。 */
  agentToolCalls?: number;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface AppSettings {
  globalShortcut: string; // e.g. "Alt+Space"
  launchAtStartup: boolean;
  startMinimized: boolean;
  showTrayIcon: boolean;
  autoCaptureSelection: boolean;
  restoreClipboardAfterCapture: boolean;
  maxContextLength: number;
  saveHistory: boolean;
  maxHistoryEntries: number;
  /** 窗口大小自动适配内容（关闭后由用户手动拖拽决定） */
  autoFitWindow: boolean;
  /** 界面缩放：1 = 100% */
  uiScale: number;
  /** 用户手动调整后记住的窗口尺寸（逻辑像素） */
  windowWidth?: number;
  windowHeight?: number;
  /** 请求超时（秒） */
  requestTimeout: number;
  /** 呼出时自动探测最新截图并尝试附着（默认开） */
  screenshotAutoDetect?: boolean;
  /** 自定义截图目录（空 = 自动探测系统默认位置） */
  screenshotDir?: string;
  /** 允许 agent 调用只读本地工具（默认开） */
  agentTools?: boolean;
}

export interface ModelPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 超时（秒） */
  timeout?: number;
}

export type EndpointClass = "local" | "private" | "remote";
