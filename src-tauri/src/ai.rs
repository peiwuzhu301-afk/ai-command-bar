// OpenAI-compatible chat + streaming + connection test + agent (tool loop).
//
// Streaming uses reqwest's byte stream, forwarding SSE "data:" lines to the
// frontend as "ai:chunk:all" events.
//
// Agent path (req.agent == true): the model may request read-only local tools
// (get_clipboard / ocr_screenshot / current_time). Rust loops: run each tool
// locally, append the result as a role="tool" message, and re-ask until the
// model returns a normal answer. Every failure mode falls back to the classic
// single-shot behavior (server rejects tools / image rejected / 5xx / cancel).
// Per-tool progress is pushed to the frontend as "ai:tool:step" events.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// 图片 data URL（data:image/...;base64,...）。有值时该消息按多模态消息
    /// （content = [{type:"text"},{type:"image_url"}]）下发。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    /// 图片本地路径（不上传，只用于模型不支持图片时的本地 OCR 回退）。
    /// 前端 wire 名是 camelCase `imagePath`；alias 兼容旧蛇形写法。
    #[serde(default, alias = "image_path", skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    /// 仅 role="tool" 消息：本条结果对应的 tool call id。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// 仅请求工具调用的 assistant 消息：模型要求的结构化调用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallWire>>,
}

/// 模型返回的结构化工具调用（wire 形式与 OpenAI/vLLM 一致）。
#[derive(Serialize, Deserialize, Clone)]
pub struct ToolCallWire {
    pub id: String,
    /// 固定 "function"。
    pub kind: String,
    pub function: ToolCallFunction,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ToolCallFunction {
    pub name: String,
    /// JSON 编码的函数参数（first batch 固定 "{}"）。
    pub arguments: String,
}

/// 把一条消息序列化成请求体里的 shape。
///  - role="tool"：{"role","tool_call_id","content"}
///  - 带 tool_calls 的 assistant：content 空时为 null（vLLM 已验证该形式）
///  - 带 image 的消息：content 变 part 数组（空文本的 text part 省略）
///  - 其余：content 保持字符串
fn msg_json(m: &ChatMessage) -> Value {
    if m.role == "tool" {
        return json!({
            "role": "tool",
            "tool_call_id": m.tool_call_id,
            "content": m.content,
        });
    }
    if let Some(tcs) = &m.tool_calls {
        let calls: Vec<Value> = tcs
            .iter()
            .map(|tc| {
                json!({
                    "id": tc.id,
                    "type": tc.kind,
                    "function": { "name": tc.function.name, "arguments": tc.function.arguments },
                })
            })
            .collect();
        let content: Value = if m.content.trim().is_empty() {
            Value::Null
        } else {
            Value::String(m.content.clone())
        };
        return json!({ "role": "assistant", "content": content, "tool_calls": calls });
    }
    if let Some(url) = m.image.as_deref().filter(|u| !u.trim().is_empty()) {
        let mut parts: Vec<Value> = Vec::new();
        if !m.content.trim().is_empty() {
            parts.push(json!({ "type": "text", "text": m.content }));
        }
        parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
        return json!({ "role": m.role, "content": parts });
    }
    json!({ "role": m.role, "content": m.content })
}

fn build_body(
    model: &str,
    messages: &[ChatMessage],
    stream: bool,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    tools: Option<&Value>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages.iter().map(msg_json).collect::<Vec<_>>(),
        "stream": stream,
    });
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(t) = tools {
        body["tools"] = t.clone();
    }
    // 关闭该部署（vLLM + Qwen3 chat 模板）的 thinking 块。
    // 不关的话「思考」会混进 content：长思考被 max_tokens 截断时不带收尾标签，
    // strip_thinking 无法剥离 → 用户直接看到思维链，且正式答案被挤出预算。
    // chat_template_kwargs 是 vLLM 扩展字段；非 vLLM 后端若拒收，调用方会
    // 去掉它重发一次（见 drop_thinking_kwargs / is_extra_field_rejection）。
    body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    body
}

/// 去掉「关闭 thinking」的 vLLM 扩展字段（4xx 回退用）。
fn drop_thinking_kwargs(body: &mut Value) -> bool {
    body.as_object_mut()
        .map(|o| o.remove("chat_template_kwargs").is_some())
        .unwrap_or(false)
}

/// 4xx 且错误信息像「不认 chat_template_kwargs 之类的扩展字段」→ 去掉重发一次。
fn is_extra_field_rejection(status: u16, text: &str) -> bool {
    if !(400..=499).contains(&status) {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("chat_template_kwargs") {
        return true;
    }
    ["unrecognized", "unknown", "unexpected", "extra", "additional"]
        .iter()
        .any(|k| lower.contains(k))
}

/// 4xx 错误信息看起来像「模型不支持图片/视觉」时的回退标记。
fn is_image_rejection(status: u16, text: &str) -> bool {
    if !(400..=415).contains(&status) {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    ["image", "vision", "multimodal", "模态", "图像"]
        .iter()
        .any(|k| lower.contains(*k))
}

/// 模型拒绝图片时：把消息里的图片去掉，改用本地 OCR 文本（须有 image_path）。
/// 返回是否真的发生过回退（某条消息原本带了图）。
async fn fallback_image_messages(messages: &mut [ChatMessage]) -> bool {
    let mut any = false;
    for m in messages.iter_mut() {
        if m.image.is_none() {
            continue;
        }
        m.image = None;
        any = true;
        if let Some(path) = m.image_path.take() {
            if let Ok(ocr) = crate::screenshot::ocr_file(Path::new(&path)).await {
                let ocr = ocr.trim();
                if ocr.is_empty() {
                    continue;
                }
                m.content = if m.content.trim().is_empty() {
                    format!("【截图本地 OCR 文本——当前模型不支持图片，已自动附加】\n{ocr}")
                } else {
                    format!(
                        "{}\n\n【截图本地 OCR 文本——当前模型不支持图片，已自动附加】\n{ocr}",
                        m.content.trim()
                    )
                };
            }
        }
    }
    any
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// 请求超时（秒），未传时默认 180s（chat）/ 300s（stream）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    /// 启用 agent 工具调用（只读本地工具：剪贴板 / 截图 OCR / 当前时间）。
    /// 后端不支持 tools 时本次运行自动降级为普通问答，行为不变。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<bool>,
}

fn clamp_timeout_secs(v: Option<u64>, default: u64) -> Duration {
    let raw = v.unwrap_or(default).clamp(30, 600);
    Duration::from_secs(raw)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestRequest {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionResult {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub struct Gateway;

impl Gateway {
    pub fn new(_store: &crate::store::Store) -> Self {
        Gateway
    }
}

/// 判断目标地址是否属于「本机 / 局域网」。
///
/// 这类地址必须直连：Windows 上的系统代理（Clash、V2Ray、公司代理等）
/// 会把请求转发到远端节点，而远端访问不到本地内网 IP，于是返回 502。
/// 注意：reqwest 0.12 在 Windows 上会读取注册表里的系统代理，且**不会**
/// 遵守系统代理设置里的「绕过列表」（ProxyOverride），所以必须在这里显式处理。
fn is_local_target(base_url: &str) -> bool {
    let host = match reqwest::Url::parse(base_url) {
        Ok(u) => u.host_str().unwrap_or("").to_string(),
        Err(_) => return true,
    };
    let h = host.trim_matches(|c| c == '[' || c == ']').to_string();
    if h.is_empty() {
        return true;
    }
    let lower = h.to_ascii_lowercase();
    if lower == "localhost"
        || lower.ends_with(".local")
        || lower.ends_with(".internal")
        || lower.ends_with(".lan")
        || lower.ends_with(".home")
    {
        return true;
    }
    if let Ok(ip) = h.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_private() || v4.is_loopback() || v4.is_link_local()
            }
            std::net::IpAddr::V6(v6) => v6.is_loopback(),
        };
    }
    // 不含点号的主机名（例如内网机器名 "vllm"）也按内网处理。
    !h.contains('.')
}

/// 构造 HTTP 客户端。对局域网/本机地址禁用代理，避免被系统代理转发成 502。
fn client(timeout: Duration, base_url: &str) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10));
    if is_local_target(base_url) {
        builder = builder.no_proxy();
    }
    builder.build().expect("http client build")
}

fn chat_url(base_url: &str) -> String {
    let b = base_url.trim_end_matches('/');
    format!("{b}/chat/completions")
}

fn models_url(base_url: &str) -> String {
    let b = base_url.trim_end_matches('/');
    format!("{b}/models")
}

fn auth(r: reqwest::RequestBuilder, key: &str) -> reqwest::RequestBuilder {
    if !key.trim().is_empty() {
        r.header("Authorization", format!("Bearer {key}"))
    } else {
        r
    }
}

#[tauri::command]
pub async fn ai_chat(req: ChatRequest) -> Result<String, String> {
    let c = client(clamp_timeout_secs(req.timeout, 180), &req.base_url);
    let url = chat_url(&req.base_url);
    let mut messages = req.messages;
    let mut tried_image_fallback = false;
    let mut tried_no_think = false;
    loop {
        let mut body = build_body(
            &req.model,
            &messages,
            false,
            req.temperature,
            req.max_tokens,
            None,
        );
        if tried_no_think {
            drop_thinking_kwargs(&mut body);
        }
        let resp = c
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| friendly(e))?;
        let status = resp.status();
        if status.is_success() {
            let data: Value = resp.json().await.map_err(|e| friendly(e))?;
            let content = data["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            return Ok(content);
        }
        let text = resp.text().await.unwrap_or_default();
        // 模型不支持图片 → 本地 OCR 回退（只尝试一次）。
        if !tried_image_fallback && is_image_rejection(status.as_u16(), &text) {
            if fallback_image_messages(&mut messages).await {
                tried_image_fallback = true;
                continue;
            }
        }
        // 后端不认 chat_template_kwargs → 去掉重发（只尝试一次）。
        if !tried_no_think && is_extra_field_rejection(status.as_u16(), &text) {
            tried_no_think = true;
            continue;
        }
        return Err(user_error(status, &text));
    }
}

use tokio::sync::watch;

/// 全局「停止」信号。
///
/// 同一时刻只允许一个流式请求，所以用单个开关即可：
/// 前端点「停止」时调用 `ai_cancel`，正在进行的流式循环会尽快结束，
/// 并保留已经生成的部分内容（返回 Ok(partial)）。
pub struct CancelState {
    tx: watch::Sender<bool>,
}

impl CancelState {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx }
    }
    /// 新请求开始前清掉上一次的取消标记。
    pub fn reset(&self) {
        let _ = self.tx.send_replace(false);
    }
    /// 用户点击「停止」。
    pub fn cancel(&self) {
        let _ = self.tx.send_replace(true);
    }
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }
}

impl Default for CancelState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn ai_cancel(state: tauri::State<'_, CancelState>) {
    state.cancel();
}

#[tauri::command]
pub async fn ai_stream(
    app: AppHandle,
    state: tauri::State<'_, CancelState>,
    app_state: tauri::State<'_, crate::AppState>,
    req: ChatRequest,
) -> Result<String, String> {
    state.reset();
    let mut cancel = state.subscribe();
    if req.agent == Some(true) {
        // Agent 路径：模型可调用只读本地工具（剪贴板 / 最新截图 OCR / 时间）。
        // 后端不支持 tools 时在 ai_stream_agent 内静默降级为下面的经典路径。
        let store = &app_state.store;
        return ai_stream_agent(app, &mut cancel, store, req).await;
    }
    let c = client(clamp_timeout_secs(req.timeout, 300), &req.base_url);
    let url = chat_url(&req.base_url);
    let mut messages = req.messages;

    // 网络闪断/代理重启时，502/503/504 和连接错误会自动重试（最多 2 次）。
    let mut attempt = 0u32;
    let mut tried_image_fallback = false;
    let mut tried_no_think = false;
    loop {
        // 用户已点「停止」。
        if *cancel.borrow() {
            return Ok(String::new());
        }
        attempt += 1;
        let mut body = build_body(
            &req.model,
            &messages,
            true,
            req.temperature,
            req.max_tokens,
            None,
        );
        if tried_no_think {
            drop_thinking_kwargs(&mut body);
        }
        let send = auth(c.post(&url).json(&body), &req.api_key).send();
        let sent = tokio::select! {
            r = send => r,
            // 请求发出/等待首字节期间点了停止 → 立即结束。
            _ = cancel.changed() => return Ok(String::new()),
        };
        match sent {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return stream_sse(app, resp, &mut cancel).await;
                }
                let text = resp.text().await.unwrap_or_default();
                // 模型不支持图片 → 本地 OCR 回退（只尝试一次）。
                if !tried_image_fallback && is_image_rejection(status.as_u16(), &text) {
                    if fallback_image_messages(&mut messages).await {
                        tried_image_fallback = true;
                        continue;
                    }
                }
                // 后端不认 chat_template_kwargs → 去掉重发（只尝试一次）。
                if !tried_no_think && is_extra_field_rejection(status.as_u16(), &text) {
                    tried_no_think = true;
                    continue;
                }
                let err = user_error(status, &text);
                if is_gateway_status(status.as_u16()) && attempt < 3 {
                    let wait = Duration::from_millis(1500 * attempt as u64);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = cancel.changed() => return Ok(String::new()),
                    }
                    continue;
                }
                return Err(err);
            }
            Err(e) => {
                let is_conn = e.is_connect() || e.is_timeout();
                if is_conn && attempt < 3 {
                    let wait = Duration::from_millis(1200 * attempt as u64);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = cancel.changed() => return Ok(String::new()),
                    }
                    continue;
                }
                return Err(friendly(e));
            }
        }
    }
}

// ============ Agent（工具循环）============
//
// 设计原则：经典路径零改动，agent 只是叠加的增强路径。
//  - 模型不使用工具 → 与普通问答完全一致
//  - 服务端 4xx 拒绝 tools → 本次运行去掉 tools 重发（静默降级）
//  - 模型拒收图片 → 本地 OCR 回退（与经典路径相同，仅一次）
//  - 5xx / 连接错误 → 重试（最多 2 次，与经典路径相同）
//  - 用户点「停止」→ 保留已生成内容
//
// 该后端部署会把模型 thinking 混进 content（think 收尾标签之前是思考），
// 所以 agent 路径每轮先完整缓冲、不边收边发；工具轮丢弃内容，
// 末轮用 strip_thinking 只交付正式答案。

/// Agent 可用的只读本地工具定义。first batch 全部无参数。
fn agent_tools_json() -> Value {
    let empty_params = json!({ "type": "object", "properties": {}, "additionalProperties": false });
    json!([
        { "type": "function", "function": {
            "name": "get_clipboard",
            "description": "读取用户剪贴板中的文本（用户刚复制的内容）。",
            "parameters": empty_params.clone() } },
        { "type": "function", "function": {
            "name": "ocr_screenshot",
            "description": "对系统最近一张截图做本地 OCR，返回图中全部文字。附加截图太小、模糊或需要逐字精确引用时调用。",
            "parameters": empty_params.clone() } },
        { "type": "function", "function": {
            "name": "current_time",
            "description": "获取当前本地日期和时间（含星期）。",
            "parameters": empty_params.clone() } },
        { "type": "function", "function": {
            "name": "get_foreground_window",
            "description": "查看用户当前前台窗口的标题、进程名和 PID（判断用户正在看什么/用什么软件）。",
            "parameters": empty_params.clone() } },
        { "type": "function", "function": {
            "name": "get_system_info",
            "description": "获取本机系统概要：Windows 版本、CPU 型号、内存占用、屏幕分辨率与 DPI。",
            "parameters": empty_params.clone() } },
        { "type": "function", "function": {
            "name": "list_recent_documents",
            "description": "列出桌面/文档/下载文件夹里最近 48 小时修改过的文档（按时间倒序，最多 15 条）。",
            "parameters": empty_params.clone() } },
    ])
}

/// 追加进系统提示词的工具说明（仅 agent 路径）。
const AGENT_SYSTEM_NOTE: &str = "\n\n【本地工具】你可以调用以下只读本地工具（均无副作用）：\n- get_clipboard：读取用户当前剪贴板中的文本。\n- ocr_screenshot：对系统最近一张截图做本地 OCR，返回图中全部文字。\n- current_time：获取当前本地日期和时间。\n- get_foreground_window：查看用户当前前台窗口的标题、进程名和 PID。\n- get_system_info：获取本机系统概要（Windows 版本 / CPU / 内存 / 屏幕）。\n- list_recent_documents：列出桌面、文档、下载里最近 48 小时修改过的文档。\n需要时先调用对应工具，再基于返回结果继续回答；不需要时不要调用，直接给出回答。工具均不接受参数，arguments 固定为 {}。";

fn inject_agent_system_note(messages: &mut Vec<ChatMessage>) {
    if let Some(first) = messages.first_mut().filter(|m| m.role == "system") {
        first.content.push_str(AGENT_SYSTEM_NOTE);
    } else {
        messages.insert(
            0,
            ChatMessage {
                role: "system".to_string(),
                content: AGENT_SYSTEM_NOTE.trim_start().to_string(),
                image: None,
                image_path: None,
                tool_call_id: None,
                tool_calls: None,
            },
        );
    }
}

/// 错误信息是否像「服务端不支持 tools」（任意 4xx + 关键词）。
/// 命中后本次运行去掉 tools 重发，静默降级为普通问答。
/// （vLLM/FastAPI 对未知字段可能返回 400 或 422，都算。）
fn is_tools_rejection(status: u16, text: &str) -> bool {
    if !(400..=499).contains(&status) {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    lower.contains("tool") || lower.contains("function_call")
}

/// 该部署的 thinking 混在 content 里（think 收尾标签之前是思考块）。
/// agent 路径只交付正式答案；没有 think 分块时原样返回。
fn strip_thinking(s: &str) -> String {
    const CLOSE: &str = "think>";
    if let Some(pos) = s.rfind(CLOSE) {
        let rest = s[pos + CLOSE.len()..]
            .trim_start_matches(|c: char| c == '\n' || c == '\r' || c == ' ');
        if !rest.trim().is_empty() {
            return rest.to_string();
        }
    }
    s.trim().to_string()
}

/// 按字符截断长文本（工具结果 / 步骤预览用）。
fn clip_chars(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars).collect();
        format!("{cut}…（已截断）")
    }
}

/// 本地执行单个工具。全部只读、无副作用。
async fn run_tool(
    app: &AppHandle,
    store: &crate::store::Store,
    name: &str,
    arguments: &str,
) -> Result<String, String> {
    // first batch 工具均无参数；防御模型乱传。
    let a = arguments.trim();
    if !a.is_empty() && a != "{}" {
        return Err(format!("工具 {name} 暂不接受参数（收到：{a}）"));
    }
    let result = match name {
        "get_clipboard" => {
            let t = app
                .clipboard()
                .read_text()
                .map_err(|e| format!("读取剪贴板失败：{e}"))?;
            Ok(clip_chars(t.trim(), 4000))
        }
        "ocr_screenshot" => {
            let custom = store
                .get("settings")
                .get("screenshotDir")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string());
            crate::screenshot::ocr_latest_screenshot(custom, 6).await
        }
        "current_time" => Ok(crate::screenshot::local_datetime_str()),
        "get_foreground_window" => Ok(clip_chars(
            &crate::sysinfo::foreground_window()
                .map_err(|e| format!("获取前台窗口失败：{e}"))?,
            500,
        )),
        "get_system_info" => Ok(clip_chars(
            &crate::sysinfo::system_info()
                .map_err(|e| format!("获取系统信息失败：{e}"))?,
            300,
        )),
        "list_recent_documents" => Ok(clip_chars(
            &crate::sysinfo::recent_documents()
                .map_err(|e| format!("扫描最近文档失败：{e}"))?,
            3000,
        )),
        other => Err(format!("未知工具：{other}")),
    };
    result.and_then(|t| {
        if t.trim().is_empty() {
            Ok("（工具返回为空）".to_string())
        } else {
            Ok(t)
        }
    })
}

/// 流式累积 tool_calls 增量片段（一个 SSE delta 里 arguments 可能只来一部分，
/// 按 index 分桶拼接；id/name 只在首个片段出现）。
struct ToolCallAccumulator {
    calls: Vec<TcPart>,
}

struct TcPart {
    id: String,
    name: String,
    arguments: String,
}

impl ToolCallAccumulator {
    fn new() -> Self {
        Self { calls: Vec::new() }
    }
    fn feed(&mut self, delta: &Value) {
        let Some(arr) = delta["tool_calls"].as_array() else {
            return;
        };
        for tc in arr {
            let idx = tc["index"].as_u64().unwrap_or(0) as usize;
            while self.calls.len() <= idx {
                self.calls.push(TcPart {
                    id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                });
            }
            if let Some(id) = tc["id"].as_str() {
                if !id.is_empty() {
                    self.calls[idx].id = id.to_string();
                }
            }
            if let Some(n) = tc["function"]["name"].as_str() {
                if !n.is_empty() {
                    self.calls[idx].name = n.to_string();
                }
            }
            if let Some(a) = tc["function"]["arguments"].as_str() {
                self.calls[idx].arguments.push_str(a);
            }
        }
    }
    fn finish(self) -> Vec<ToolCallWire> {
        self.calls
            .into_iter()
            .filter(|c| !c.name.is_empty())
            .map(|c| ToolCallWire {
                id: if c.id.is_empty() {
                    format!("call_agent_{}", c.name)
                } else {
                    c.id
                },
                kind: "function".to_string(),
                function: ToolCallFunction {
                    name: c.name,
                    arguments: if c.arguments.is_empty() {
                        "{}".to_string()
                    } else {
                        c.arguments
                    },
                },
            })
            .collect()
    }
}

enum SseLine {
    Data(Value),
    Done,
    Other,
}

/// 解析一行 SSE；非 data 行 / 解析失败都是 Other，[DONE] 是 Done。
fn parse_sse_line(line: &[u8]) -> SseLine {
    let line_str = String::from_utf8_lossy(line).trim().to_string();
    let Some(payload) = line_str.strip_prefix("data:") else {
        return SseLine::Other;
    };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return SseLine::Done;
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(v) => SseLine::Data(v),
        Err(_) => SseLine::Other,
    }
}

fn apply_delta(v: &Value, content: &mut String, acc: &mut ToolCallAccumulator) {
    let delta = &v["choices"][0]["delta"];
    if let Some(t) = delta["content"].as_str() {
        if !t.is_empty() {
            content.push_str(t);
        }
    }
    acc.feed(delta);
}

/// Agent 单轮：完整读完一次 SSE 流，收集本轮 content + tool_calls。
/// 不向前端 emit（工具轮里模型可能把思考混进 content，要等本轮结束才知道
/// 该轮是「调工具」还是「最终回答」）。取消时返回已收集到的部分。
async fn stream_round(
    resp: reqwest::Response,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(String, Vec<ToolCallWire>), String> {
    use futures::TryStreamExt;
    let mut content = String::new();
    let mut acc = ToolCallAccumulator::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = Box::pin(resp.bytes_stream());

    'outer: loop {
        if *cancel.borrow() {
            return Ok((content, acc.finish()));
        }
        let next = tokio::select! {
            biased;
            _ = cancel.changed() => return Ok((content, acc.finish())),
            c = stream.try_next() => c,
        };
        match next {
            Ok(Some(bytes)) => buf.extend_from_slice(&bytes),
            Ok(None) => break,
            Err(e) => return Err(friendly(e)),
        }
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            match parse_sse_line(&line) {
                SseLine::Done => break 'outer,
                SseLine::Data(v) => apply_delta(&v, &mut content, &mut acc),
                SseLine::Other => {}
            }
        }
    }
    // 防御性：流末尾残留的最后一行（正常情况 [DONE] 已收到）。
    if !buf.is_empty() {
        if let SseLine::Data(v) = parse_sse_line(&buf) {
            apply_delta(&v, &mut content, &mut acc);
        }
    }
    Ok((content, acc.finish()))
}

/// Agent 路径：模型每回一次 tool_calls，就本地执行（只读）→ 结果回填 → 再问，
/// 直到拿到正式回答。工具轮数上限 MAX_TOOL_ROUNDS，超过后占位回填并去掉 tools 收尾。
async fn ai_stream_agent(
    app: AppHandle,
    cancel: &mut watch::Receiver<bool>,
    store: &crate::store::Store,
    req: ChatRequest,
) -> Result<String, String> {
    const MAX_TOOL_ROUNDS: u32 = 4;
    let c = client(clamp_timeout_secs(req.timeout, 300), &req.base_url);
    let url = chat_url(&req.base_url);
    let tools = agent_tools_json();
    let mut messages = req.messages;
    inject_agent_system_note(&mut messages);
    let mut tools_active: Option<Value> = Some(tools);
    let mut tried_image_fallback = false;
    let mut tried_no_think = false;
    let mut attempt = 0u32;
    let mut tool_rounds = 0u32;

    loop {
        if *cancel.borrow() {
            return Ok(String::new());
        }
        attempt += 1;
        let mut body = build_body(
            &req.model,
            &messages,
            true,
            req.temperature,
            req.max_tokens,
            tools_active.as_ref(),
        );
        if tried_no_think {
            drop_thinking_kwargs(&mut body);
        }
        let send = auth(c.post(&url).json(&body), &req.api_key).send();
        let sent = tokio::select! {
            r = send => r,
            _ = cancel.changed() => return Ok(String::new()),
        };
        match sent {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let (content, tool_calls) = stream_round(resp, cancel).await?;
                    if tool_calls.is_empty() {
                        // 最终回答（剥离 thinking 块）。
                        return Ok(strip_thinking(&content));
                    }
                    // 一轮工具调用：先回填 assistant 消息（带 tool_calls），
                    // 再逐个回填 tool 结果消息，然后继续循环。
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: String::new(),
                        image: None,
                        image_path: None,
                        tool_call_id: None,
                        tool_calls: Some(tool_calls.clone()),
                    });
                    if tool_rounds >= MAX_TOOL_ROUNDS {
                        // 到上限：占位结果保持格式一致，去掉 tools 让下一轮强制作答。
                        for tc in &tool_calls {
                            messages.push(ChatMessage {
                                role: "tool".to_string(),
                                content: "（工具调用次数已达上限，未提供结果）".to_string(),
                                image: None,
                                image_path: None,
                                tool_call_id: Some(tc.id.clone()),
                                tool_calls: None,
                            });
                        }
                        tools_active = None;
                        continue;
                    }
                    tool_rounds += 1;
                    for tc in &tool_calls {
                        let _ = app.emit(
                            "ai:tool:step",
                            json!({
                                "phase": "call",
                                "name": tc.function.name,
                                "preview": "",
                                "ms": 0,
                                "ok": true,
                            }),
                        );
                        if *cancel.borrow() {
                            return Ok(String::new());
                        }
                        let t0 = Instant::now();
                        let res =
                            run_tool(&app, store, &tc.function.name, &tc.function.arguments).await;
                        let ms = t0.elapsed().as_millis() as u64;
                        let (ok, preview) = match &res {
                            Ok(t) => (true, clip_chars(t, 80)),
                            Err(e) => (false, e.clone()),
                        };
                        let _ = app.emit(
                            "ai:tool:step",
                            json!({
                                "phase": "done",
                                "name": tc.function.name,
                                "preview": preview,
                                "ms": ms,
                                "ok": ok,
                            }),
                        );
                        let text = res.unwrap_or_else(|e| format!("（工具调用失败：{e}）"));
                        messages.push(ChatMessage {
                            role: "tool".to_string(),
                            content: text,
                            image: None,
                            image_path: None,
                            tool_call_id: Some(tc.id.clone()),
                            tool_calls: None,
                        });
                    }
                    continue;
                }
                let text = resp.text().await.unwrap_or_default();
                // 模型拒收图片 → 本地 OCR 回退（仅一次，与经典路径相同）。
                if !tried_image_fallback && is_image_rejection(status.as_u16(), &text) {
                    if fallback_image_messages(&mut messages).await {
                        tried_image_fallback = true;
                        continue;
                    }
                }
                // 服务端不支持 tools → 静默降级：去掉 tools 按普通问答继续。
                if tools_active.is_some() && is_tools_rejection(status.as_u16(), &text) {
                    tools_active = None;
                    continue;
                }
                // 后端不认 chat_template_kwargs → 去掉重发（仅一次）。
                if !tried_no_think && is_extra_field_rejection(status.as_u16(), &text) {
                    tried_no_think = true;
                    continue;
                }
                let err = user_error(status, &text);
                if is_gateway_status(status.as_u16()) && attempt < 3 {
                    let wait = Duration::from_millis(1500 * attempt as u64);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = cancel.changed() => return Ok(String::new()),
                    }
                    continue;
                }
                return Err(err);
            }
            Err(e) => {
                let is_conn = e.is_connect() || e.is_timeout();
                if is_conn && attempt < 3 {
                    let wait = Duration::from_millis(1200 * attempt as u64);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = cancel.changed() => return Ok(String::new()),
                    }
                    continue;
                }
                return Err(friendly(e));
            }
        }
    }
}

fn is_gateway_status(code: u16) -> bool {
    matches!(code, 502 | 503 | 504)
}

async fn stream_sse(
    app: AppHandle,
    resp: reqwest::Response,
    cancel: &mut watch::Receiver<bool>,
) -> Result<String, String> {
    use futures::TryStreamExt;
    let mut full = String::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = Box::pin(resp.bytes_stream());

    loop {
        // 已点「停止」→ 保留已生成内容，正常结束。
        if *cancel.borrow() {
            return Ok(full);
        }
        let next = tokio::select! {
            biased;
            _ = cancel.changed() => return Ok(full),
            c = stream.try_next() => c,
        };
        match next {
            Ok(Some(bytes)) => { buf.extend_from_slice(&bytes); }
            Ok(None) => break,
            Err(e) => return Err(friendly(e)),
        }
        // Process complete lines, keep the partial one in buf.
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let line_str = String::from_utf8_lossy(&line).trim().to_string();
            if line_str.starts_with("data:") {
                let payload = line_str.trim_start_matches("data:").trim();
                if payload == "[DONE]" {
                    return Ok(full);
                }
                if let Ok(parsed) = serde_json::from_str::<Value>(payload) {
                    if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
                        if !delta.is_empty() {
                            full.push_str(delta);
                            let _ = app.emit("ai:chunk:all", delta);
                        }
                    }
                }
            }
        }
    }
    // Flush any remaining partial line.
    if !buf.is_empty() {
        let line_str = String::from_utf8_lossy(&buf).trim().to_string();
        if line_str.starts_with("data:") {
            let payload = line_str.trim_start_matches("data:").trim();
            if let Ok(parsed) = serde_json::from_str::<Value>(payload) {
                if let Some(delta) = parsed["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        full.push_str(delta);
                    }
                }
            }
        }
    }
    Ok(full)
}

#[tauri::command]
pub async fn ai_test_connection(req: TestRequest) -> ConnectionResult {
    let started = Instant::now();
    let c = client(Duration::from_secs(20), &req.base_url);

    // 1) try GET /models
    let url = models_url(&req.base_url);
    if let Ok(resp) = auth(c.get(&url), &req.api_key).send().await {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<Value>().await {
                let models: Vec<String> = data["data"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m["id"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                return ConnectionResult {
                    ok: true,
                    message: "连接成功。".to_string(),
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    models: Some(models),
                    model: Some(req.model),
                };
            }
        }
    }

    // 2) minimal chat fallback
    let chat_url = chat_url(&req.base_url);
    let body = json!({
        "model": req.model,
        "stream": false,
        "max_tokens": 8,
        "messages": [ { "role": "user", "content": "Reply with OK only." } ]
    });
    if let Ok(resp) = auth(c.post(&chat_url).json(&body), &req.api_key)
        .send()
        .await
    {
        if resp.status().is_success() {
            return ConnectionResult {
                ok: true,
                message: "连接成功（通过对话接口验证）。".to_string(),
                latency_ms: Some(started.elapsed().as_millis() as u64),
                model: Some(req.model),
                models: None,
            };
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return ConnectionResult {
                ok: false,
                message: user_error(status, &text),
                latency_ms: Some(started.elapsed().as_millis() as u64),
                models: None,
                model: Some(req.model),
            };
        }
    }

    ConnectionResult {
        ok: false,
        message: "无法连接到模型接口。".to_string(),
        latency_ms: Some(started.elapsed().as_millis() as u64),
        models: None,
        model: Some(req.model),
    }
}

fn friendly(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "请求超时，请确认服务器可达且响应不慢。"
    } else if e.is_connect() {
        "无法连接到模型接口，请检查地址是否正确、模型服务器是否在运行。"
    } else if e.is_request() {
        "请求失败，请检查地址和模型名称是否正确。"
    } else {
        return format!("HTTP 错误：{e}");
    }
    .to_string()
}

fn user_error(status: reqwest::StatusCode, text: &str) -> String {
    let base = match status.as_u16() {
        401 | 403 => "认证失败，请检查 API 密钥是否正确。",
        404 => "接口或模型不存在，请检查地址（例如 /v1 后缀）和模型名称。",
        429 => "请求过于频繁或超出配额，请稍后再试。",
        _ => &format!("服务器返回 HTTP {}。", status.as_u16()),
    };
    let detail: String = text.replace(['\r', '\n'], " ").chars().take(240).collect();
    format!("{base} 详情：{detail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_targets_bypass_proxy() {
        // 内网 IP 示例：必须直连（不走代理）
        assert!(is_local_target("http://10.0.0.5:8000/v1"));
        assert!(is_local_target("http://192.168.1.10:8000/v1"));
        assert!(is_local_target("http://172.20.5.5:8000/v1"));
        assert!(is_local_target("http://127.0.0.1:8000/v1"));
        assert!(is_local_target("http://localhost:8000/v1"));
        assert!(is_local_target("http://vllm:8000/v1"));
        assert!(is_local_target("http://model-server.local:8000/v1"));
    }

    #[test]
    fn public_targets_keep_proxy_capable() {
        assert!(!is_local_target("https://api.openai.com/v1"));
        assert!(!is_local_target("https://api.deepseek.com/v1"));
        assert!(!is_local_target("https://8.8.8.8:8000/v1"));
    }

    // ===== agent（工具循环）=====

    #[test]
    fn tool_call_accumulator_assembles_fragments() {
        let mut acc = ToolCallAccumulator::new();
        acc.feed(&json!({ "content": "thinking..." }));
        acc.feed(&json!({ "tool_calls": [ { "id": "call_1", "type": "function", "index": 0, "function": { "name": "current_time", "arguments": "" } } ] }));
        acc.feed(&json!({ "tool_calls": [ { "index": 0, "function": { "arguments": "{}" } } ] }));
        let v = acc.finish();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "call_1");
        assert_eq!(v[0].kind, "function");
        assert_eq!(v[0].function.name, "current_time");
        assert_eq!(v[0].function.arguments, "{}");
    }

    #[test]
    fn tool_call_accumulator_ignores_call_without_name() {
        let mut acc = ToolCallAccumulator::new();
        acc.feed(&json!({ "tool_calls": [ { "index": 0, "function": { "arguments": "{}" } } ] }));
        assert!(acc.finish().is_empty());
    }

    #[test]
    fn tool_call_accumulator_handles_multiple_calls() {
        let mut acc = ToolCallAccumulator::new();
        acc.feed(&json!({ "tool_calls": [
            { "id": "c0", "index": 0, "function": { "name": "get_clipboard" } },
            { "id": "c1", "index": 1, "function": { "name": "ocr_screenshot" } },
        ] }));
        let v = acc.finish();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].function.name, "get_clipboard");
        assert_eq!(v[1].id, "c1");
        assert_eq!(v[1].function.name, "ocr_screenshot");
        assert_eq!(v[1].function.arguments, "{}"); // 缺省补 "{}"
    }

    // 该部署的 think 收尾标签在字面量里写作 <\think>，
    // 这里用 \u{3c} / \\ / \u{3e} 转义拼出来，避免源码里出现生标签。
    const THOUGHT_CLOSE: &str = "\u{3c}\\think\u{3e}";

    #[test]
    fn strip_thinking_keeps_answer_only() {
        let s = format!("thinking text\n{THOUGHT_CLOSE}\n\n答案正文");
        assert_eq!(strip_thinking(&s), "答案正文");
        // 无 think 分块 → 原样（trim）
        assert_eq!(strip_thinking("  普通回答  "), "普通回答");
        // 只有思考块 → 回退返回原文 trim
        let s2 = format!("only thinking\n{THOUGHT_CLOSE}");
        assert_eq!(strip_thinking(&s2), s2.trim());
    }

    #[test]
    fn tools_rejection_detection() {
        assert!(is_tools_rejection(
            400,
            "BadRequestError: model does not support tools"
        ));
        assert!(is_tools_rejection(422, "unexpected field: tools in request"));
        assert!(!is_tools_rejection(400, "Invalid image format"));
        assert!(!is_tools_rejection(500, "internal error mentioning tools"));
    }

    #[test]
    fn body_disables_thinking_by_default() {
        let b = build_body("qwen3.8-27b-fp8", &[], true, None, None, None);
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], json!(false));
    }

    #[test]
    fn extra_field_rejection_detection() {
        assert!(is_extra_field_rejection(
            400,
            "Unrecognized request argument supplied: chat_template_kwargs"
        ));
        assert!(is_extra_field_rejection(
            422,
            "unexpected field: chat_template_kwargs"
        ));
        assert!(!is_extra_field_rejection(400, "Invalid image format"));
        assert!(!is_extra_field_rejection(500, "unknown internal error"));
    }

    #[test]
    fn drop_thinking_kwargs_removes_field_once() {
        let mut b = json!({ "model": "m", "chat_template_kwargs": { "enable_thinking": false } });
        assert!(drop_thinking_kwargs(&mut b));
        assert!(b.get("chat_template_kwargs").is_none());
        assert!(!drop_thinking_kwargs(&mut b));
    }

    #[test]
    fn clip_chars_cuts_by_char_not_bytes() {
        // 2 个 CJK 字符 > 1 字符上限，且不会在字节中间切坏
        assert_eq!(clip_chars("今天周五", 1), "今…（已截断）");
        assert_eq!(clip_chars("ok", 10), "ok");
    }

    #[test]
    fn sse_line_parsing() {
        assert!(matches!(
            parse_sse_line(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n"),
            SseLine::Data(_)
        ));
        assert!(matches!(parse_sse_line(b"data: [DONE]\n"), SseLine::Done));
        assert!(matches!(parse_sse_line(b": keep-alive\n"), SseLine::Other));
        assert!(matches!(parse_sse_line(b"event: done\n"), SseLine::Other));
        assert!(matches!(
            parse_sse_line(b"data: not-json\n"),
            SseLine::Other
        ));
    }

    #[test]
    fn msg_json_tool_shapes() {
        let tool_msg = ChatMessage {
            role: "tool".to_string(),
            content: "abc".to_string(),
            image: None,
            image_path: None,
            tool_call_id: Some("call_1".to_string()),
            tool_calls: None,
        };
        let v = msg_json(&tool_msg);
        assert_eq!(v["role"], json!("tool"));
        assert_eq!(v["tool_call_id"], json!("call_1"));
        assert_eq!(v["content"], json!("abc"));

        let asst = ChatMessage {
            role: "assistant".to_string(),
            content: String::new(),
            image: None,
            image_path: None,
            tool_call_id: None,
            tool_calls: Some(vec![ToolCallWire {
                id: "c1".to_string(),
                kind: "function".to_string(),
                function: ToolCallFunction {
                    name: "current_time".to_string(),
                    arguments: "{}".to_string(),
                },
            }]),
        };
        let v = msg_json(&asst);
        assert!(v["content"].is_null());
        assert_eq!(v["tool_calls"][0]["id"], json!("c1"));
        assert_eq!(v["tool_calls"][0]["type"], json!("function"));
        assert_eq!(
            v["tool_calls"][0]["function"]["name"],
            json!("current_time")
        );
        assert_eq!(
            v["tool_calls"][0]["function"]["arguments"],
            json!("{}")
        );
    }

    #[test]
    fn msg_json_plain_and_image_unchanged() {
        let plain = ChatMessage {
            role: "user".to_string(),
            content: "你好".to_string(),
            image: None,
            image_path: None,
            tool_call_id: None,
            tool_calls: None,
        };
        let v = msg_json(&plain);
        assert_eq!(v["role"], json!("user"));
        assert_eq!(v["content"], json!("你好"));

        let img = ChatMessage {
            role: "user".to_string(),
            content: "看看这张图".to_string(),
            image: Some("data:image/png;base64,AAA".to_string()),
            image_path: Some("C:\\tmp\\x.png".to_string()),
            tool_call_id: None,
            tool_calls: None,
        };
        let v = msg_json(&img);
        assert_eq!(v["content"][0]["type"], json!("text"));
        assert_eq!(v["content"][1]["type"], json!("image_url"));
    }
}
