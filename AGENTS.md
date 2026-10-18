# AGENTS.md

本工作区在为 **AI Command Bar** 编写代码。如下约定对所有自动化 agent 适用，无论是否会话延续。

## 项目位置

- 项目路径必须是**纯 ASCII**（避免 `rc.exe` 截断非 ASCII 路径，见「远绕非 ASCII 路径」章节）
- 若用中文路径做用户入口，可用 junction 映射回 ASCII 真实目录，但 **cargo 必须始终在 ASCII 目录内执行**。

## 环境

**PowerShell (5.1) 每次新 shell 必须先：**

```powershell
$env:Path += ";$env:USERPROFILE\.cargo\bin"
$env:RUSTUP_DIST_SERVER="https://mirrors.tuna.tsinghua.edu.cn/rustup"
$env:RUSTUP_UPDATE_ROOT="https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup"
```

| 工具 | 版本 / 位置 |
|------|--------------|
| Rust | `rustc 1.98.1` / `cargo 1.98.1`，TUNA 镜像 |
| Node.js | Windows node.exe（`npm` 安装过 `@tauri-apps/cli`） |
| Python 3.10+ | 仅用于 `tools\gen_icons.py` |
| C++ / MSVC | VS 2022 Community + Win10 SDK 22621 |
| Windows SDK `rc.exe` | 路径随 SDK 安装位置（**仅接受 ASCII 路径 + 正斜杠**，see `远绕非 ASCII 路径` 章节） |

## 模型后端

- OpenAI-compatible（任何自托管/公网端点均支持）
- 默认示例：Base URL `http://127.0.0.1:8000/v1`（本机 vLLM），Model `qwen3.8-27b-fp8`，均在 Settings 中按实际部署修改；API key 只存 OS 凭据管理器，**不写入仓库 / 文档 / 启动逻辑**（首次启动无 key 时由用户在 Settings 填入）
- Rust 端的 `chat/completions` / `chat/completions?stream=true` / `GET /models` 已实现
- 浏览器 dev fallback 在 `src/providers/openai-compatible.ts`，仅开发模式（非 Tauri）触发
- 默认模型已实测**支持 vision**：user 消息可带 `image`（base64 data URL），Rust 端展开成 OpenAI content parts；模型拒图（400/415，错误含 image/vision/multimodal/模态/图像）时 `ai.rs` 自动用本地 OCR 文字带 `imagePath` 重试一次
- **思维链默认必须关闭**：`ai.rs::build_body` 恒带 `chat_template_kwargs: {"enable_thinking": false}`（vLLM 扩展）。该部署会把 thinking 混进 `content`，而长 thinking 被 `max_tokens` 截断时不输出收尾标签 → `strip_thinking` 无法剥离（用户直接看到思维链，且正式答案被思考挤掉）。实测 `enable_thinking=false` 后 `content` 无任何 think 标记、纯答案。非 vLLM 后端若 4xx 拒收该字段，`is_extra_field_rejection` 会去掉它重发一次（三条路径：`ai_chat` / 经典 `ai_stream` / `ai_stream_agent`）；`ai_test_connection` 不带该字段

## 关键约定

- **window**：frameless，680×160，`alwaysOnTop`，`skipTaskbar`，启动隐藏（`setup` 中 `window.hide()`），`Alt+Space` 切换、`Esc` 关闭、`Ctrl+K` 切换命令面板（`src/components/CommandPalette.tsx`，搜命令/历史/笔记；面板内 Esc 有 `stopPropagation`，不会触发窗口隐藏；打开时窗口逻辑高度 <380 会经 `setWindowLogical` 拉高到 460、不收回）。跨屏跟随（M4）：`window.rs::reposition_to_foreground_monitor(w)` 在 `toggle_window` show 前调用——GetForegroundWindow→GetWindowRect→MonitorFromRect(TONEAREST)→GetMonitorInfoW 物理 rcWork 内水平居中、y=top+(work_h−win_h)×3/10；fg 无效（`is_invalid()`）或探测失败**静默不挪位**，绝不影响 show。
- **streaming**：Rust 端 `ai_stream` 通过 `AppHandle.emit("ai:chunk:all", delta)` 通知前端；前端在 `src/providers/openai-compatible.ts::stream` 中 listen + resolve 完整文本。
- **api key**：绝不在 JSON 中存储；Rust `secrets.rs` 用 `keyring` crate（Windows Credential Manager）+ 文件 fallback；前端通过 `invoke("save_api_key", { key })` + `get_api_key`。
- **持久化**：所有 `app_data_dir/<key>.json`；Rust `store.rs` 原子写（tmp + rename）；key: `settings` / `model` / `history`（max 1000）/ `notes` / `custom_commands`（max 500）。
- **自定义命令**：与内置命令同形状，存 `promptTemplate`（Rust JSON 读出来可能是 snake_case `prompt_template` — read 侧兼容两种）。
- **MarkdownView 代码块**：`CodeBlock` 必须渲染 `children` 本身，不能只取字符串 —— `rehype-highlight` 会把代码变成 `<span class="hljs-*">` 元素数组，`typeof children === "string"` 为假时会把代码块渲染成**空框**（流式阶段用纯 `<pre>` 正常、完成后切 MarkdownView 就"消失"）。复制按钮的纯文本另用 `nodeToText(children)` 递归提取。`components.pre` 已改为 fragment，避免 `<pre>` 套 `<pre>`。
- **截图能力**：`latest_screenshot` / `ocr_image` / `screenshot_data_url` 三个 invoke（见 `src-tauri/src/screenshot.rs`）；前端唯一入口是 `src/utils/screenshot.ts`（带内存缓存，勿另起 invoke 直调）。`/extract`（ocrOnly，纯本地 OCR 不走模型）、`/describe`、`/solve` 均为 `contextRole: "image"`；shotActive 时任意命令的 user 消息都带 `image` data URL（语义在 `App.tsx::execute`）。扫描目录顺序：自定义 → Win+Shift+S 临时（SecHealthUI AC/Temp）→ 图片\Screenshots → 桌面；自动 6h / 手动 24h 窗口；文件 ≤50MB、data URL ≤12MB。降采样（M1，同文件 `screenshot.rs`）：`needs_compress(w,h,bytes)` 纯函数（长边>2560 或 >3MiB）为真时 `screenshot_data_url` 走 `spawn_blocking(downscale_blocking)` —— WINRT 同链缩到长边 2048 + JPEG q85，失败回退原字节（小图路径字节级不变）。剪贴板图片附着（M2）：`probe_clipboard_image`（**零写盘**，`clipboard().read_image()` 尺寸 + `GetClipboardSequenceNumber()` 新鲜度令牌 → `ClipImageInfo{width,height,seq}`）与 `save_clipboard_image(expectedSeq)`（seq 不符 → Err「剪贴板内容已变化，请重新复制图片后再附着。」；RGBA → 24-bit top-down BMP 手工编码 → `%TEMP%\aibar\clip-<epochms>.bmp`，顺手清 24h 前旧 clip 文件；该目录**不在**截图扫描目录内，不会被 refreshShot 误捡）；前端唯一入口仍是 `src/utils/screenshot.ts`（`probeClipImage` 带 in-flight 去重/失败→null，`saveClipImage(expectedSeq)`），App 内芯片仅在 `!shotActive` 显示、dismiss 记 seq（同 seq 不再提示，新复制重提）。
- **agent 工具调用（P2）**：工具定义/SSE 累积/循环/回退在 `ai.rs`；后 3 个工具的实现（前台窗口/系统概要/最近文档）在 `src-tauri/src/sysinfo.rs`（纯 Win32，7 个单测）。`ai_stream(app, state, app_state, req)` 第三参 `app_state: tauri::State<'_, AppState>`，`req.agent == Some(true)` 且非 ocrOnly 语义（前端 `/extract` 恒不传 agent）时走 `ai_stream_agent`，否则走经典单轮（经典路径行为不许动）。6 个无参只读工具（`arguments` 恒 `{}`）：`get_clipboard`（`ClipboardExt::clipboard().read_text()`，截 4000 字）/ `ocr_screenshot`（`screenshot::ocr_latest_screenshot(custom_dir 来自 settings.screenshotDir, 6)`）/ `current_time`（`screenshot::local_datetime_str()`）/ `get_foreground_window`（标题+进程名+PID，无前台→「当前在桌面」，截 500 字）/ `get_system_info`（OS/CPU/内存/屏幕一行，截 500 字）/ `list_recent_documents`（桌面/文档/下载，48h/≤50MB/15 条，截 3000 字）；工具体在 `ai.rs::run_tool` 分派，新 3 个直调 `sysinfo::{foreground_window,system_info,recent_documents}`（失败返回 Err → 步骤行 ✗，不炸会话）。`MAX_TOOL_ROUNDS=4`；工具 SSE 用 `ToolCallAccumulator` 按 `index` 累积（name 可能在首片、arguments 分片；id 空兜底 `call_agent_{name}`，arguments 空补 `"{}"`，无名条目丢弃）。每工具两次 `app.emit("ai:tool:step", {phase:"call"|"done", name, preview≤80字, ms, ok})`。**回退矩阵**（均静默）：tools 被拒（`is_tools_rejection`：任意 4xx + 小写含 "tool"/"function_call"）→ 去 `tools` 重发一次；图片拒收 → `fallback_image_messages` OCR 回退（仅一次）；5xx/连接错 `attempt<3` 重试；轮数达上限补占位 tool 消息「（工具调用次数已达上限…）」+ `tools_active=None` 强收尾。消息形状：`assistant{content:null,tool_calls}` + `{role:"tool",tool_call_id,content}`；`msg_json` 四形态别改坏。**坑**：① `build_body` 末参 `tools: Option<&Value>`，**所有**调用点（`ai_chat` / 经典 `ai_stream` / `ai_test_connection`）签名变更时必须同步；② agent 分支**不发** `ai:chunk:all`（`stream_round` 每轮缓冲），末轮 `strip_thinking` 去 think 收尾标签后一次性发——think 收尾标签在源码/注释里必须写 `"<\\think>"` 转义形式，源码中永远不能出现真实的标签 + 换行（会拆断 `//` 行注释）；③ `ChatMessage` 已 `#[serde(rename_all="camelCase")]` + `image_path` 带别名（前端 `imagePath` 不再被静默丢弃），新字段 `tool_call_id`/`tool_calls`。前端链路：`provider.stream(req,onToken,signal,onToolStep?)` 在 Tauri 分支监听 `ai:tool:step`（browser dev fallback 不发 tools，自动降级）；`run.ts` 第 4 参透传；`App.tsx::makeStepTracker` 每次运行建一个（pairing：done 从尾部回填最近一个同名 pending）；Settings `agentTools` 默认 true；历史条目 `agentToolCalls` → `HistoryList` 🔧×N。2026-10 增强批次前端要点：M5 「⚡ 看起来像报错」芯片 = `App.tsx` 的 `errorSuggestion` useMemo（idle + ≥20 字 + 非 `/` 开头 + 关键词正则）→ 点击 `execute(builtinCommand("debug"), "", input)`；M6 面板 = `paletteOpen`/`paletteNote{id,n}`（n 为 nonce，同笔记可重开）+ window `Ctrl+K` listener + mount 即拉 notes（`refreshNotes` 也进了 mount effect）+ `NotesList` 的 `openNoteId/openNoteNonce` 自动 `startEdit`；M7 引导 banner 条件 `!run && history.length===0`（首条历史 `setHistory` 后消失）+ `HistoryList`「存笔记」按钮（`save_note` 标题 `/<cmd> <input 截60>`、标签 `["历史",cmd]`，成功置 `savedIds` 防重复）。单测入口 `cargo test`（28 个 = 基线 12 + M1 2 + M2 4 + M3 7 + 关闭 thinking/字段回退 3）。

## 重生成图标

```powershell
cd <项目根目录>
python tools\gen_icons.py
```

`icon.ico` 为 16/32/48/256 多尺寸 V3 格式；PNG 输出 `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.png`。

不要用 `tools\gen-icons.ps1`（用 `[byte]` 写 `MemoryStream` 有 bug，ICO 输出单独被 rc.exe 判为“not in 3.00 format”）。

## 远绕非 ASCII 路径

`rc.exe`(Win SDK 10.0.10011) 在编译 `.rc` 资源文件时将路径中非 ASCII 字符（如 `项目`）截断为 `C:\Temp\AI` 而不是 `C:\Temp\AI项目`，导致 `resource file ... is not in 3.00 format` 错误。

**因此**：

- 项目真实位置必须是 ASCII 路径
- 中文路径入口即 junction 指回 ASCII 目录
- 永远不要 cargo build 进入带中文的路径；始终在 ASCII 项目目录下 `cd src-tauri` 再 `cargo ...`
- 若需要中文入口：`cmd /c mklink /J "<中文名入口>" "<ASCII 项目目录>"`

## 已知 Tauri 2.11.6 API

以下为本文档写代码时实际验证过的 Rust 端调用，**不要替换成看起来"更熟"的写法**：

- `tauri::menu::MenuItem::with_id(app, id, text, enabled, None::<&str>)` — accelerator 参数 `None::<&str>`（不是 `None::<Accelerator>`）
- `tauri::menu::PredefinedMenuItem::separator(app)` / `::quit(app, Some("Quit"))`
- `tauri::menu::Menu::with_items(app, &[&show, &settings, &sep1, &about, &sep2, &quit])` — `&[&dyn IsMenuItem<Wry>; N]`，**不**是 `Vec<Box<dyn IsMenuItem>>`
- `tauri::tray::TrayIconBuilder`（不再有顶层 `TrayIcon` export）
- `tauri::WebviewWindow::set_size(tauri::PhysicalSize::new(width, height))` + `inner_size()`（不是 `set_height`）
- `tauri::AppHandle` 用 `tauri::Manager` trait 提供 `.path().app_data_dir()`
- 托盘 **无** `app.dialog().message(...)` — 在 `about` 里退路到 `eprintln!`
- `keyring::Entry::new(service, user)` (Keyring 3) — **无** `delete_password`，用 `set_password("")` 代替
- `tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None)` + `app.autolaunch()`（不是 `autolaunch_manager`）
- `tauri_plugin_clipboard_manager::ClipboardExt` trait 需 `use` 才能调 `app.clipboard()`
- `tauri_plugin_global_shortcut::GlobalShortcutExt` trait 需 `use` 才能调 `app.global_shortcut()`
- Rust 端 `ChatRequest` 等已 `#[serde(rename_all = "camelCase")]`，与前端 `baseUrl`/`apiKey`/`maxTokens` 一致

## WINRT 本地 OCR（`screenshot.rs`，windows 0.61.3）

凡涉及 WinRT 异步 API 的代码改动，**不要改回 `.await` 风格**，当前编译通过的约束如下：

- **WINRT 对象非 Send**（`StorageFile` 含 `NonNull<c_void>`）。async 里跨 await 持有它们会让 tauri 命令的 future 非 Send → 编译失败。整条 WinRT 链路必须是**同步函数**，由 `ocr_file` / 调用方用 `tokio::task::spawn_blocking` 包一层。
- `IAsyncOperation<T>::get()`（windows-future 0.2.1 `get.rs`)是阻塞等待的固有方法，**无需 import trait**；全链路统一用它。
- `windows-future` 的 `IntoFuture` impl 被 `#[cfg(feature = "std")]` 门控，而 windows 0.61.3 对它是 `default-features = false`。所以 `Cargo.toml` 里**必须**直接依赖 `windows-future = { version = "0.2.1", features = ["std"] }` 做 feature 合并（删除它会导致 `await` 相关 impl 消失）。
- Windows features 名一律**下划线**风格（`Win32_System_Time`、`Foundation`、`Graphics_Imaging`、`Graphics_Imaging_2D`、`Graphics_Imaging_DeviceIndependentResources`、`Media_Ocr`、`Storage_Files`、`System_Threading`）；`Win32_System_Time` 里不含 SYSTEMTIME（那个在 `Foundation`）。
- 已验证调用形态：`GetLocalTime()`（unsafe 零参，返回 `Foundation::SYSTEMTIME`）；`StorageFile::GetFileFromPathAsync` → `.get()` → `OpenAsync(FileAccessMode::Read)` → `.get()`；`BitmapDecoder::CreateAsync(&stream)`（单参）→ `GetSoftwareBitmapAsync()`（零参）→ `OcrEngine::TryCreateFromLanguage(&Language)` / `TryCreateFromUserProfileLanguages()` → `RecognizeAsync(&bitmap)` → `OcrResult::Text()`（同步）。枚举是 newtype struct（`FileAccessMode(pub i32)`）。
- 单测入口：`cargo test`（M1 的 `downscale_big_bmp_to_jpeg` 端到端用例也走这条 WINRT 同步链）。

## 常用命令

```powershell
# 编译 (开发模式; ~1m34s 首编; 缓存后 ~3s)
cd src-tauri   # 在 ASCII 项目目录下
cargo check          # 检查 (CI)
cargo build          # 生成 target\debug\ai-command-bar.exe
# ⚠️ 不要用 cargo build --release 出「可分发 exe」！它绕过 Tauri CLI，产出加载 devUrl
#   (http://localhost) 的二进制：前端报 ERR_CONNECTION_REFUSED、JS 不执行、全局快捷键不注册。
#   要 release exe / 安装包，只能走 CLI：
cd <项目根目录>
npm run tauri build -- --no-bundle       # 只出 target\release\ai-command-bar.exe
npm run tauri build -- --bundles nsis    # 出 exe + NSIS 安装包

# 前端
cd <项目根目录>
npm install
npx tsc --noEmit      # 类型检查
npx vite build        # 打包

# 开发 + 热更新 (Vite :1420 + Tauri 壳)
npm run tauri dev

# 打包 NSIS / MSI（Tauri v2：bundle 用 -b/--bundles，--target 是 rust triple 别混用）
npm run tauri build -- --bundles nsis
```

## 边界

- 不上传任何云端；所有数据在 `app_data_dir`（key: settings/model/history/notes/custom_commands）
- 不集成 OAuth / 远程登录
- **不要用 `window.confirm` / `alert` / `prompt`**：wry 0.55.1 未接管 `ScriptDialogOpening`，实测 WebView2 不弹原生对话框，`confirm()` 直接返回 `true`（确认形同虚设，会静默执行危险操作）。危险操作用**两步 UI 确认**（如 `HistoryList` 的「清空全部」：首次点进待确认态、4s 内再点才执行）或 Tauri dialog 插件。
- 顶部页签（⏱/📝/≡/⚙）语义是**可切换**：点当前高亮页签回到结果页（title「返回主界面」）；`HistoryList`/`NotesList` 另有 `← 返回` 按钮（`onBack` prop）。
- API Key 仅 OS 凭据；前端从内存拿到，存于 React state，**不落 localStorage**
- 流式 SSE 由 Rust 解析并 emit；不在前端直接流式解析 `data:` 行（`openai-compatible.ts::browserStream` 只是 dev fallback）
- 自定义命令与内置命令 **复位字段**：id / name / description / promptTemplate / kind:"custom" / enabled / createdAt
