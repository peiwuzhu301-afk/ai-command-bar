// Generic OpenAI-compatible provider abstraction.
// Streaming is delegated to the Rust layer (invoke) when in Tauri,
// with a browser fetch fallback for browser-only dev.
import { ChatMessage, ChatRequest, ConnectionResult, ToolStepEvent } from "../types";
import { TAURI, invoke } from "../lib/tauri";

export interface ModelProvider {
  stream(
    req: ChatRequest,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    /** agent 路径的工具调用进度（ai:tool:step）；经典路径不会触发。 */
    onToolStep?: (ev: ToolStepEvent) => void,
  ): Promise<string>;
  chat(req: ChatRequest): Promise<string>;
  testConnection(req: Pick<ChatRequest, "baseUrl" | "apiKey" | "model"> & { model?: string }): Promise<ConnectionResult>;
}

/**
 * OpenAI-compatible provider.
 * In Tauri, streaming goes through the Rust HTTP layer (better TLS, streams).
 * In browser dev, we use the renderer fetch directly.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  async chat(req: ChatRequest): Promise<string> {
    const full: ChatRequest = { ...req, stream: false } as ChatRequest;
    if (TAURI) {
      return invoke<string>("ai_chat", { req: full });
    }
    return browserChat(full);
  }

  async stream(
    req: ChatRequest,
    onToken: (t: string) => void,
    signal?: AbortSignal,
    onToolStep?: (ev: ToolStepEvent) => void,
  ): Promise<string> {
    const full: ChatRequest = { ...req, stream: true } as ChatRequest;
    if (TAURI) {
      // Rust layer emits 'ai:chunk:all' events and resolves with the full text.
      // Agent 路径额外发 'ai:tool:step' 工具调用进度。
      const { invoke: i } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<string>("ai:chunk:all", (e) => onToken(e.payload));
      let unTool: (() => void) | null = null;
      if (onToolStep) {
        unTool = await listen<ToolStepEvent>("ai:tool:step", (e) => onToolStep(e.payload));
      }
      try {
        return await i<string>("ai_stream", { req: full });
      } finally {
        un();
        unTool?.();
      }
    }
    // dev 浏览器 fallback 不带 tools 字段：agent 循环不生效，等价经典问答。
    return browserStream(full, onToken, signal);
  }

  async testConnection(
    req: Pick<ChatRequest, "baseUrl" | "apiKey" | "model"> & { model?: string },
  ): Promise<ConnectionResult> {
    const started = performance.now();
    try {
      if (TAURI) {
        return await invoke<ConnectionResult>("ai_test_connection", { req });
      }
      return await browserTest(req, started);
    } catch (e: unknown) {
      const latencyMs = Math.round(performance.now() - started);
      return { ok: false, message: friendlyError(e), latencyMs };
    }
  }
}

function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo|network/i.test(msg))
    return "无法连接到模型接口，请检查地址是否正确、模型服务器是否在运行。";
  if (/401|Unauthorized/i.test(msg)) return "认证失败，请检查 API 密钥是否正确。";
  if (/404|Not Found/i.test(msg)) return "接口路径不存在，请检查地址（例如是否带 /v1 后缀）。";
  if (/timeout|timed out/i.test(msg)) return "请求超时，请重试。";
  return `连接错误：${msg}`;
}

// ---------- Browser fallbacks (dev only) ----------

function buildHeaders(apiKey: string) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

/**
 * 前端消息 → OpenAI wire 格式：带 image 的消息展开成 content parts
 * （与 Rust 端 ai.rs::msg_json 行为一致；Tauri 请求由 Rust 侧展开，这里只影响 dev fallback）。
 */
function wireMessages(messages: ChatMessage[]): Array<{
  role: string;
  content: string | Array<Record<string, unknown>>;
}> {
  return messages.map((m) => {
    if (m.image?.trim()) {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content.trim()) parts.push({ type: "text", text: m.content });
      parts.push({ type: "image_url", image_url: { url: m.image } });
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

function chatUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}
function modelsUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/models";
}

async function browserChat(req: ChatRequest): Promise<string> {
  const res = await fetch(chatUrl(req.baseUrl), {
    method: "POST",
    headers: buildHeaders(req.apiKey),
    body: JSON.stringify({
      model: req.model,
      messages: wireMessages(req.messages),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function browserStream(
  req: ChatRequest,
  onToken: (t: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(chatUrl(req.baseUrl), {
    method: "POST",
    headers: buildHeaders(req.apiKey),
    body: JSON.stringify({
      model: req.model,
      messages: wireMessages(req.messages),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) throw new Error(await res.text());
  if (!res.body) throw new Error("No response body for stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          onToken(delta);
        }
      } catch {
        /* ignore partial */
      }
    }
  }
  return full;
}

async function browserTest(
  req: Pick<ChatRequest, "baseUrl" | "apiKey" | "model">,
  started: number,
): Promise<ConnectionResult> {
  // 1) try /models
  try {
    const res = await fetch(modelsUrl(req.baseUrl), {
      headers: buildHeaders(req.apiKey),
    });
    if (res.ok) {
      const data = await res.json();
      const models: string[] = (data.data ?? []).map((m: { id: string }) => m.id);
      return {
        ok: true,
        message: "Connected.",
        latencyMs: Math.round(performance.now() - started),
        models,
        model: req.model,
      };
    }
  } catch {
    /* fall through to a minimal chat call */
  }
  const res = await fetch(chatUrl(req.baseUrl), {
    method: "POST",
    headers: buildHeaders(req.apiKey),
    body: JSON.stringify({
      model: req.model,
      messages: [{ role: "user", content: "Reply with OK only." }],
      stream: false,
      max_tokens: 8,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return {
    ok: true,
    message: "Connected via chat.",
    latencyMs: Math.round(performance.now() - started),
    model: req.model,
    models: data?.model ? [data.model] : [],
  };
}

export const openaiCompatible = new OpenAICompatibleProvider();
