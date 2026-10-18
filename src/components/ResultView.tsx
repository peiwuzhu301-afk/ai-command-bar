// ResultView: shows the current run's streaming output + actions.
// Streaming phase renders plain <pre> (cheap per-token); once the run is
// finished (or errored) it switches to MarkdownView with highlighting.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { formatRelativeTime } from "../utils/text";
import { MarkdownView } from "./MarkdownView";
import type { AgentStep } from "../types";

export interface RunState {
  command: { id: string; name: string; description?: string };
  instruction: string;
  streaming: string;
  final: string;
  error?: string;
  startedAt?: number;
  doneAt?: number;
  /** agent 路径的工具调用步骤。 */
  steps?: AgentStep[];
}

interface Props {
  run: RunState | null;
  running: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onCopy: () => void;
  onReplace: () => void;
  onRetry: () => void;
  onCollapse: () => void;
  /** 仅 reference 类命令(/ask)启用:把当前 instruction 作为 user 消息再追一轮。 */
  onContinue?: () => void;
}

/** Rough token estimate for the stats line. */
function estTokens(s: string): number {
  if (!s) return 0;
  // CJK chars ~1 token each, latin words ~1.3 chars/token on average.
  let cjk = 0;
  let latin = 0;
  for (const ch of s) {
    if (ch.codePointAt(0)! > 0x2e7f) cjk++;
    else latin++;
  }
  return Math.round(cjk + latin / 3.5);
}

/** 工具名的中文标签（agent 路径）。 */
const TOOL_LABELS: Record<string, string> = {
  get_clipboard: "读取剪贴板",
  ocr_screenshot: "截图 OCR",
  current_time: "获取时间",
};

export function ResultView({
  run,
  running,
  expanded,
  onToggleExpand,
  onCopy,
  onReplace,
  onRetry,
  onCollapse,
  onContinue,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // 用户向上滚 → 暂停自动滚动；滚回底部 → 恢复。
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [run?.streaming, run?.steps]);

  // 运行中但模型还没吐出第一个字 → 逐秒显示"已等待 N 秒",避免用户以为卡死。
  const waiting = running && !run?.streaming && !run?.final && !run?.error;
  const [waitSec, setWaitSec] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    const t0 = run?.startedAt ?? Date.now();
    setWaitSec(0);
    const t = window.setInterval(() => {
      setWaitSec(Math.max(0, Math.round((Date.now() - t0) / 1000)));
    }, 400);
    return () => window.clearInterval(t);
  }, [waiting, run?.startedAt]);

  if (!run) {
    return (
      <div className="result-empty">
        <span className="dim">在上方输入命令（如 /explain）并回车，回答会显示在这里。</span>
      </div>
    );
  }

  const shown = run.streaming || run.final || "";
  const hasError = !!run.error;
  const finished = !running && run.doneAt != null;

  // 统计：字符数 / 估算 token / 耗时 / tok·s
  const tokens = estTokens(shown);
  const seconds =
    run.startedAt && run.doneAt ? Math.max(0.05, (run.doneAt - run.startedAt) / 1000) : null;
  const stats = [
    shown && `${shown.length.toLocaleString()} 字`,
    tokens > 0 && `${tokens.toLocaleString()} tok`,
    seconds != null && `${seconds.toFixed(1)} s`,
    seconds != null && tokens > 0 && `${(tokens / seconds).toFixed(1)} tok/s`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="result">
      <div className="result-head">
        <span className="result-cmd">/{run.command.name}</span>
        {run.instruction && <span className="result-inst muted"> {run.instruction}</span>}
        <div className="spacer" />
        {hasError && <span className="err">出错</span>}
        {!hasError && running && <span className="accent">{waiting ? "加载中…" : "生成中…"}</span>}
        <button className="ghost small" onClick={onRetry} title="重新运行">重跑</button>
        <button
          className="ghost small"
          onClick={onToggleExpand}
          title={expanded ? "还原窗口大小" : "放大到接近全屏，方便读完长回答"}
        >
          {expanded ? "还原" : "放大"}
        </button>
        <button className="ghost small" onClick={onCopy} disabled={!shown} title="复制到剪贴板">复制</button>
        <button className="ghost small" onClick={onReplace} disabled={!shown} title="用输出内容替换剪贴板">替换</button>
        {!running && <button className="ghost small" onClick={onCollapse} title="收起窗口">收起</button>}
        {onContinue && !running && (
          <button className="ghost small" onClick={onContinue} title="把当前输入追加为下一轮,保留上下文继续追问">
            继续追问
          </button>
        )}
      </div>
      <div className="result-body" ref={ref} onScroll={onScroll}>
        {run.steps && run.steps.length > 0 && (
          <div className="agent-steps">
            {run.steps.map((s, i) => (
              <div
                key={i}
                className={clsx("agent-step", s.pending ? "pending" : s.ok ? "ok" : "err")}
              >
                <span className="agent-step-icon" aria-hidden>
                  {s.pending ? "⏳" : s.ok ? "✓" : "✗"}
                </span>
                <span className="agent-step-name">{TOOL_LABELS[s.name] ?? s.name}</span>
                <div className="spacer" />
                {s.pending ? (
                  <span className="agent-step-meta dim">运行中…</span>
                ) : (
                  <span className="agent-step-meta dim" title={s.preview ?? ""}>
                    {s.ms != null ? `${s.ms} ms` : ""}
                    {s.preview ? ` · ${s.preview}` : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {hasError ? (
          <>
            <span className="err">{run.error}</span>
            <pre className="log-data">{(() => {
              try { return JSON.stringify((window as unknown as { __aibarLog?: string[] }).__aibarLog ?? [], null, 2); }
              catch { return "(log unavailable)"; }
            })()}</pre>
          </>
        ) : shown ? (
          running ? (
            <pre className="result-text">{shown}</pre>
          ) : (
            <MarkdownView text={shown} />
          )
        ) : waiting ? (
          <div className="result-loading">
            <div className="spinner" aria-hidden />
            <div>
              <div>
                {run.steps && run.steps.length > 0
                  ? `正在调用本地工具…（已等待 ${waitSec} 秒）`
                  : `正在加载…（已等待 ${waitSec} 秒）`}
              </div>
              <div className="dim">
                {run.steps && run.steps.length > 0
                  ? "模型通过工具收集信息中，完成后完整展示回答。"
                  : "带图推理的首字通常要 10~30 秒；出字后会逐字流出，期间可点「停止」或按 Enter 中止。"}
              </div>
            </div>
          </div>
        ) : running ? (
          <span className="dim">等待模型返回…</span>
        ) : (
          <span className="dim">暂无输出。</span>
        )}
      </div>
      <div className="result-foot">
        <span className="dim">
          {run.doneAt ? formatRelativeTime(new Date(run.doneAt).toISOString()) : ""}
        </span>
        {finished && stats && <span className="dim"> · {stats}</span>}
      </div>
    </div>
  );
}
