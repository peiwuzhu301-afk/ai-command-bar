# AI Command Bar

A fast, local-first, model-agnostic desktop AI command bar.

> 基于 Tauri 2 + React 18 + TypeScript，使用任意 OpenAI-compatible 模型后端（vLLM / llama.cpp / Ollama / OpenAI / 自建服务等）。默认快捷键 `Alt+Space` 切出 / 收起，本地只在 `app_data_dir` 写 JSON，API Key 走 OS 凭据管理器（Windows Credential Manager / macOS Keychain），不上传任何云端服务。

## 实现规格 (实施范围)

**完整 MVP**（Phase 1–7）：

| Phase | 功能 | 状态 |
|------|------|------|
| 1 | Tauri 2 + React 18 + TS 骨架、无标题边框窗口（680×160，透明，置顶，居中），托盘图标，系统消息事件 | ✅ |
| 2 | OpenAI-compatible provider 抽象、chat + 流式（`ai:chunk:all` 事件）、`testConnection` | ✅ |
| 3 | 剪贴板上下文捕获：默认取系统剪贴板；上限 8000 字符；可清空；可选捕获后恢复原剪贴板 | ✅ |
| 4 | 内置命令：`/ask`、`/explain`、`/rewrite`、`/translate`、`/summarize`、`/code`、`/debug`、`/prompt`、`/note`、`/flashcard`（模式如 rewrite→professional/concise/casual/technical） | ✅ |
| 5 | `/replace` 后一键写回系统剪贴板；Enter 提交可停止/继续 | ✅ |
| 6 | 本地数据：设置、模型、历史（max 500 条）、笔记、自定义命令均持久化为 JSON 文件；supports `clear_history` | ✅ |
| 7 | 自定义命令 CRUD：新建 / 编辑 / 删除，使用与内置命令相同的模板渲染（`{{context}}`、`{{instruction}}`）| ✅ |
| 8 | 截图能力：呼出时自动发现最新截图（多模态随任意命令附着）、`/extract` 本地 OCR 提取文字（Windows Media.Ocr，不调模型）、`/describe` 解释截图、`/solve` 解答截图里的问题；模型拒图时 Rust 端自动 OCR 文字回退 | ✅ |
| 9 | Agent 工具调用（P2）：模型自决调用 6 个只读本地工具（剪贴板 / 截图 OCR / 当前时间 / 前台窗口 / 系统概要 / 最近文档），工具循环 ≤4 轮，步骤行 + 历史记录 🔧 徽标，后端不支持时静默降级 | ✅ |

### 2026-10 增强批次（M1–M7，全部完成 ✅）

| # | 功能 | 说明 |
|---|------|------|
| M1 | 截图自动降采样 | 长边 >2560px 或文件 >3MiB 的图在发送前自动缩到长边 2048 + JPEG 质量 85（省 token / 提速 / 降拒图率）；WinRT 缩放失败自动回退原图 |
| M2 | 剪贴板图片直接附着 | 复制图片 → 呼出窗口出现「🖼 剪贴板图片 W×H」芯片 → 点「附着」进入截图槽，预览 / 模型 / OCR 回退 / 历史全部复用；dismiss 的图不再提示（复制新图重新提示） |
| M3 | agent 工具扩充 3→6 | +`get_foreground_window` / `get_system_info` / `list_recent_documents`，模型能回答「现在什么窗口 / 什么系统 / 最近改过哪些文档」 |
| M4 | 跨屏跟随 | 双屏唤出时窗口落在前台窗口所在显示器（水平居中）；单屏行为不变，前台探测失败则不挪位 |
| M5 | 智能建议 | 输入 ≥20 字且命中报错关键词（error / exception / traceback / panic / segfault / 报错 / 异常…）时，输入行上方出现「⚡ 看起来像报错 · 点击用 /debug 分析」芯片 |
| M6 | 命令面板（Ctrl+K） | 悬浮面板统一搜 命令 / 历史 / 笔记（每类 cap 5），↑↓ + Enter 选中，Esc / 点背景关闭；选命令回填输入行、选历史直接重跑、选笔记跳到编辑器；面板内 Esc 不会隐藏窗口 |
| M7 | 首次引导 + 历史存笔记 | 无历史时结果页显示三步引导 banner（含「去设置 / 测试连接」，首条历史落库后自动消失）；历史记录行可一键「存笔记」（标题 `/<命令> 输入`、正文=输出、标签 历史+命令），存过不再重复 |

## 默认模型配置

- **Base URL**: 默认 `http://127.0.0.1:8000/v1`（本机 vLLM 示例；vLLM / llama.cpp / Ollama / OpenAI 等任意 OpenAI-compatible 端点均可，在 Settings 中按实际部署修改）
- **Model**: 默认 `qwen3.8-27b-fp8`（按你部署的模型名修改）
- **API Key**: 不随仓库分发。首次启动在 **Settings → Model** 填入你的 key，点 `Save URL + Model + Key` 一键写入（存入 OS 凭据管理器）

设置页有 `Test connection` 按钮，会返回延迟与服务器 `/models` 列表。

本地部署的多模态模型（如 vLLM 的 `qwen3.8-27b-fp8`）支持 vision 时，截图多模态消息可直接发送。

## 截图功能

- **自动发现**：按 `Alt+Space` 呼出窗口时，后台按 mtime 扫描截图目录，取 6 小时内最新一张（手动 ⟳ 重扫放宽到 24h）。搜索顺序：自定义目录（Settings 可配）→ Win+Shift+S 临时目录（`%LOCALAPPDATA%\Packages\Microsoft.Windows.SecHealthUI_8wekyb3d8bbwe\AC\Temp`）→ 图片\Screenshots → 桌面。
- **附着语义**：发现截图后窗口顶部显示截图卡片（缩略图 + 文件名 + 大小 + 相对时间）。随后运行的**任意命令**都会把该截图（base64 data URL）随 user 消息发给模型；卡片上 ✕ 可摘除（同一张图不再自动附着，截新图仍会自动附着），⟳ 手动重扫。
- **`/extract`（提取文字）**：纯本地 OCR（Windows.Media.Ocr，引擎顺序 zh-CN → en-US → 用户首选语言），**不调用模型**，直接输出识别文字。
- **`/describe`（解释截图）**：按多模态图片发给模型做描述。
- **`/solve`（解题）**：直接解答截图里的问题（代码题 / 报错 / 数学逻辑题）——代码题给完整可运行代码并写明放置位置，报错给一行原因 + 精确修复，数学/逻辑题给关键推导 + 最终答案。
- **拒图回退**：若模型端点不支持图片（400/415 等），Rust 端自动用本地 OCR 文字带 `imagePath` 重试一次，前端无感知。
- **容量**：截图文件 ≤ 50MB，data URL ≤ 12MB；历史条目保存截图路径/文件名（可重跑），OCR 与 data URL 都有前端内存缓存。
- **自动降采样（M1）**：生成 data URL 前检查尺寸 / 体积，长边 >2560px 或文件 >3MiB 时经 WinRT 缩放到长边 2048 + JPEG 质量 85 再发送（省 token、提速、降低小模型拒图率）；缩放失败自动回退原字节，小图路径字节级不变。
- **剪贴板图片附着（M2）**：剪贴板里有图片时（复制图片 / 截图工具的「复制」），呼出窗口出现「🖼 剪贴板图片 W×H」芯片；点「附着」把图片落成 BMP 进入截图槽——之后任意命令自动附带（含 `/extract` OCR、拒图回退、历史记录）。✕ 可 dismiss（同一张图不再提示，复制新图会重新提示）；附着过程中剪贴板被替换会提示「剪贴板内容已变化，请重新复制图片后再附着」。大图自动走上面的降采样。

## Agent 工具调用（P2）

问答类命令（`/extract` 除外）运行时，模型可以**自决**调用 6 个只读本地工具，一问最多 4 轮工具循环（工具均无参数，`arguments` 固定为 `{}`）：

| 工具 | 说明 |
|------|------|
| `get_clipboard` | 读取当前系统剪贴板文本（截 4000 字） |
| `ocr_screenshot` | 对 6 小时内最新截图做本地 OCR（Windows.Media.Ocr，不走模型） |
| `current_time` | 本地时间 `YYYY-MM-DD HH:MM:SS（星期X）` |
| `get_foreground_window` | 当前前台窗口的标题 / 进程名 / PID（无前台窗口 → 「当前在桌面」，截 500 字） |
| `get_system_info` | 本机概要一行：Windows 版本 / CPU 名称 / 内存（用/总）/ 屏幕分辨率 + DPI |
| `list_recent_documents` | 桌面 / 文档 / 下载中 48h 内修改过的文档（28 种扩展名、≤50MB、按 mtime 取 15 条，截 3000 字） |

- **过程可见**：Rust 端每次工具执行发 `ai:tool:step` 事件（call → done，含 80 字预览 / 耗时 / 成败），结果区渲染成「⏳ 读取剪贴板… → ✓ 12 ms · 预览」步骤行。
- **历史**：agent 产生的历史条目带 `🔧×N` 徽标（本次工具调用次数）。
- **回退矩阵**（全部静默，不影响回答路径）：后端 4xx（400/422…）且报错像「不支持 tools」→ 去掉 tools 重发一次，降级为经典问答；附截图被模型拒收 → 本地 OCR 文字回退（同截图能力，仅一次）；5xx / 连接错误最多重试 3 次；工具轮数达上限 → 补占位 tool 消息强制收尾。
- **开关**：Settings → Agent →「允许模型自动调用本地工具」（默认开）。`/extract` 恒走纯本地 OCR，不进 agent 循环。
- **消息形状**：工具循环期间消息序列含 `assistant{tool_calls}` 与 `role:"tool"`（带 `tool_call_id`）；前端 `ChatMessage` 兼容 camelCase 字段 `imagePath` / `toolCallId` / `toolCalls`（Rust 端同样接受 snake_case 入参别名）。

## 命令面板（Ctrl+K）

`Ctrl+K`（含 `Cmd+K` 写法，浏览器 dev 环境同样可用）在窗口内弹出底部悬浮面板 + 背景蒙层，统一搜三类条目（每类最多 5 条，搜索框为空时各取前 5 条）：

- **命令**：内置 + 自定义命令，沿输入行 picker 同款打分（前缀 > 包含 > 模糊）；选中后把 `/<命令> ` 回填输入行并聚焦，可直接补指令回车运行。
- **历史**：按 命令名 / 输入 / 输出 模糊匹配；选中即按历史页「运行」同语义重跑（含上下文恢复）。
- **笔记**：按 标题 / 正文 模糊匹配；选中切到笔记页并直接打开该条的编辑器（重复选中同一条也能再次打开）。

键盘：`↑` `↓` 跨分区移动选区、`Enter` 确认、`Esc` 关闭（面板内 Esc 已拦截，**不会**顺带隐藏窗口）；鼠标悬停 / 点击等效，点背景蒙层关闭。窗口高度不足（<380 逻辑 px）时打开面板会自动拉高到 460，不压扁列表。
面板不改变输入行原有的 `/` 触发 picker 行为，两者互不干扰。

## 其他增强（M4 / M5 / M7）

- **跨屏跟随（M4）**：`Alt+Space` 唤出时窗口先定位到**前台窗口所在显示器**的工作区（水平居中、y 取工作区 top + 高度 30%）；单屏 / 前台无效时保持原居中行为不变。
- **智能建议（M5）**：idle 时输入框 ≥20 字、非 `/` 开头、且命中报错关键词（`error` / `exception` / `traceback` / `panic` / `segfault` / `errno` / `stack trace` / `unhandled` / `failed` / 报错 / 异常 / 失败）→ 输入行上方出现「⚡ 看起来像报错 · 点击用 /debug 分析」芯片，点击即以当前输入为上下文跑 `/debug`（输入框保留原文）。普通长文本、已有命令前缀、运行中均不出现。
- **首次运行引导（M7）**：历史记录为空且无运行结果时，结果页顶部显示三步引导 banner（提问命令 / 选中文字+截图 / Ctrl+K），带「去设置」与「测试连接」按钮（测试走 `testConnection`，内联显示 ✓ 延迟 ms / ✗ 错误信息）。跑完第一条命令后自动消失，老用户无感。
- **历史存笔记（M7）**：历史页每行新增「存笔记」按钮——把该条输出存为本地笔记（标题 `/<命令> <输入截 60 字>`、正文=输出、标签 `历史, <命令>`）；成功后按钮变「✓ 已存」（本次会话内保持，防重复点击产生重复笔记），笔记页 / Ctrl+K 面板立即可见。

## 运行 / 构建

```powershell
# 首次
cd ai-command-bar   # 本仓库目录
npm install
cargo build --manifest-path src-tauri\Cargo.toml

# 开发模式
npm run tauri dev

# 生产模式
npm run tauri build
```

**开发服务器**：`http://localhost:1420`，由 Vite 启动（`beforeDevCommand`）。

## 项目布局

```
.
├── index.html
├── src/
│   ├── main.tsx                  # React bootstrap
│   ├── styles.css                # 基础变量 / 按钮 / 输入字段
│   ├── app.css                   # shell / picker / result / settings / history
│   ├── types/index.ts            # 共享 TS 类型 (ModelConfig / Command / HistoryEntry / AppSettings …)
│   ├── lib/tauri.ts              # isTauri / invoke / onEvent 包装
│   ├── stores/
│   │   ├── modelConfig.ts        # Model Config + keyring 桥接
│   │   └── settings.ts           # AppSettings 持久化
│   ├── providers/
│   │   └── openai-compatible.ts  # chat/stream/testConnection + 浏览器 fallback
│   ├── commands/
│   │   ├── index.ts              # 内置命令数组 + 模板
│   │   └── run.ts                # 模板渲染 + 消息构造 + 流式包装
│   ├── utils/text.ts             # displayShortcut / endpointClass / truncateChar
│   ├── utils/screenshot.ts       # 最新截图探测 / 本地 OCR / data URL（均带内存缓存）
│   ├── components/
│   │   ├── CommandInput.tsx
│   │   ├── ContextPreview.tsx
│   │   ├── ResultView.tsx
│   │   ├── CommandPicker.tsx
│   │   ├── Settings.tsx
│   │   ├── HistoryList.tsx
│   │   ├── NotesList.tsx
│   │   ├── CommandPalette.tsx      # M6 Ctrl+K 命令面板（命令/历史/笔记）
│   │   └── CustomCommandManager.tsx
│   └── app/App.tsx               # shell + tabs + run/stop/copy/replace 逻辑
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── resources/icon.ico + 32/128/256 png
│   └── src/
│       ├── main.rs               # tauri::Builder + invoke_handler
│       ├── ai.rs                 # ai_chat / ai_stream / ai_test_connection (SSE) + 拒图 OCR 回退 + 6 工具 agent 循环
│       ├── screenshot.rs         # latest_screenshot / ocr / screenshot_data_url（WinRT Media.Ocr 本地 OCR + M1 大图降采样）
│       ├── clipboard.rs          # get/set_clipboard_text + M2 剪贴板图片 probe/save（24-bit BMP 编码，%TEMP%\aibar）
│       ├── sysinfo.rs            # M3 agent 工具：前台窗口 / 系统概要 / 最近文档（纯 Win32）
│       ├── cmd.rs                # settings / model / history / notes / custom_cmds
│       ├── secrets.rs            # keyring (api_key) + 文件 fallback
│       ├── shortcuts.rs          # 全局快捷键 unregister/register
│       ├── startup.rs            # register_global_shortcut / enable+disable_autostart
│       ├── store.rs              # JSON 文件原子写 (app_data_dir)
│       ├── tray.rs               # Show / Settings… / Quit
│       ├── window.rs             # show/hide/focus/toggle/set_height + M4 跨屏跟随（前台显示器定位）
│       └── model_config_holder.rs
└── tools/
    ├── gen_icons.ps1             # 旧尝试 (已知有 bug; Prefer Python)
    └── gen_icons.py              # 生成 icon.ico + 32/128/256 PNG
```

## 构建环境（Windows）

开发环境使用 Windows，PowerShell 5.1。

**每个新 shell（PowerShell）开始执行前**：

```powershell
$env:Path += ";$env:USERPROFILE\.cargo\bin"
$env:RUSTUP_DIST_SERVER="https://mirrors.tuna.tsinghua.edu.cn/rustup"
$env:RUSTUP_UPDATE_ROOT="https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup"
```

**注意**：

- 项目路径须为**纯 ASCII**：Windows SDK 的 `rc.exe` 在路径含非 ASCII 字符（如中文）时会截断路径，报 `resource file ... is not in 3.00 format`。若必须用中文目录名，可用 `mklink /J` 建 junction 指回 ASCII 真实目录，且 `cargo` 始终从 ASCII 目录运行。
- 仅 `tools\gen_icons.py` 需要 Python 3.10+（用来重生成 `icon.ico` 与 PNG）。

## 测试

- `tsc --noEmit` + `vite build` 通过（含截图功能与 2026-10 增强批次回归）。
- `cargo check` 通过（0 errors / 0 warnings）。
- `cargo test` 25/25 通过（screenshot 扫描 + 降采样、clipboard BMP 编码/对齐/清理、ai 多模态与 agent 工具解析、sysinfo 前台窗口/系统概要/最近文档）。
- **运行时 smoke test**：`Alt+Space` 切换窗口、`/explain <文本>` 流式返回、`Replace` 写回剪贴板、Settings **Test connection** 返回模型列表；截图功能：截一张图 → 呼出窗口自动出现截图卡片 → 点「解释截图」/「提取文字」验证多模态与本地 OCR。
- **2026-10 增强批次 smoke**：① 复制图片 → 呼出 → 「🖼 剪贴板图片」芯片 → 附着 → `/ask` 描述图片（M2）；② `/ask 现在什么窗口`，步骤行出现 `get_foreground_window`（M3）；③ 粘贴一段 ≥20 字的报错日志 → 「⚡ 看起来像报错」芯片 → 点击跑 `/debug`（M5）；④ `Ctrl+K` 面板：命令 / 历史 / 笔记三类各选中一次 + `Esc` 关闭不隐藏窗口（M6）；⑤ 历史记录「存笔记」→ 笔记页 / 面板可见，按钮变「✓ 已存」（M7）；⑥ 清掉历史可见引导 banner + 测试连接（M7）；⑦ 双屏环境唤出走前台屏（M4，单屏验证位置无明显偏移即可）。
