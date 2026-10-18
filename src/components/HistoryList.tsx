// HistoryList: prior runs with search / per-item delete / re-run / copy.
import { useCallback, useMemo, useState } from "react";
import { TAURI, invoke } from "../lib/tauri";
import { formatRelativeTime, truncateChar, uid } from "../utils/text";

interface Entry {
  id?: string;
  command?: string;
  input?: string;
  output?: string;
  model?: string;
  contextPreview?: string;
  contextLength?: number;
  createdAt?: string;
  screenshotPath?: string;
  screenshotName?: string;
  agentToolCalls?: number;
}

interface Props {
  entries: Entry[];
  onClear: () => void;
  onChanged: () => void;
  /** 回填输入框 + 切到 result tab */
  onRerun: (e: Entry) => void;
  /** M7：「存笔记」成功后，让父级刷新内存中的笔记（命令面板列表） */
  onNoteSaved?: () => void;
  /** 返回主界面（结果页） */
  onBack?: () => void;
}

export function HistoryList({ entries, onClear, onChanged, onRerun, onNoteSaved, onBack }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // 「清空全部」两步确认：点第一次进入待确认态（4s 后自动撤销），再点才真正清空。
  // 不用 window.confirm —— WebView2/wry 下它不会真正弹窗（直接返回 true）。
  const [confirmClear, setConfirmClear] = useState(false);
  // M7：已「存笔记」的条目 id（本次会话内保留，防止重复点击造出重复笔记）
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => setOpen((cur) => (cur === id ? null : id)), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        (e.command ?? "").toLowerCase().includes(q) ||
        (e.input ?? "").toLowerCase().includes(q) ||
        (e.output ?? "").toLowerCase().includes(q) ||
        (e.model ?? "").toLowerCase().includes(q),
    );
  }, [entries, query]);

  const removeOne = useCallback(
    async (e: Entry) => {
      if (!TAURI || !e.id) return;
      try {
        await invoke("delete_history", { id: e.id });
        onChanged();
      } catch (err) {
        console.error(err);
      }
    },
    [onChanged],
  );

  const copyOutput = useCallback(async (e: Entry) => {
    if (!TAURI || !e.output) return;
    try {
      await invoke("set_clipboard_text", { text: e.output });
    } catch (err) {
      console.error(err);
    }
  }, []);

  // M7：把该条输出存为本地笔记（标题=/<命令> 输入截断，标签=历史+命令）
  const saveToNote = useCallback(
    async (e: Entry) => {
      if (!TAURI || !e.output || !e.id) return;
      try {
        const title = `/${e.command ?? "?"} ${truncateChar(e.input ?? "", 60)}`.trim() || "/历史记录";
        await invoke("save_note", {
          note: {
            id: uid("note-"),
            title,
            content: e.output,
            tags: ["历史", ...(e.command ? [e.command.toLowerCase()] : [])],
            createdAt: new Date().toISOString(),
          },
        });
        setSavedIds((cur) => new Set(cur).add(e.id as string));
        onNoteSaved?.();
      } catch (err) {
        console.error(err);
      }
    },
    [onNoteSaved],
  );

  if (!entries.length) {
    return (
      <div className="history-empty">
        <span className="dim">还没有历史记录。运行一条命令即可开始积累。</span>
      </div>
    );
  }

  return (
    <div className="history">
      <div className="history-head">
        {onBack && (
          <button className="ghost small" onClick={onBack} title="返回主界面">
            ← 返回
          </button>
        )}
        <input
          className="cmd-input history-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索命令 / 输入 / 输出 / 模型…"
          spellCheck={false}
        />
        <div className="spacer" />
        <span className="muted">
          {query ? `${filtered.length} / ${entries.length}` : `${entries.length} 条`}
        </span>
        <button
          className={confirmClear ? "danger" : "ghost danger"}
          title={confirmClear ? "再点一次确认清空（4 秒内有效）" : "清空全部历史（不可恢复）"}
          onClick={() => {
            if (confirmClear) {
              setConfirmClear(false);
              onClear();
            } else {
              setConfirmClear(true);
              window.setTimeout(() => setConfirmClear(false), 4000);
            }
          }}
        >
          {confirmClear ? `确认清空 ${entries.length} 条？` : "清空全部"}
        </button>
      </div>
      <div className="history-list">
        {filtered.length === 0 && (
          <div className="history-empty">
            <span className="dim">没有匹配 "{query}" 的记录。</span>
          </div>
        )}
        {filtered.map((e, i) => (
          <div key={e.id ?? i} className="history-item">
            <button
              className="history-row"
              onClick={() => toggle(e.id ?? String(i))}
              title="展开/收起详情"
            >
              <span className="history-cmd">/{e.command ?? "?"}</span>
              <span className="history-inst muted">{e.input ? ` ${e.input}` : ""}</span>
              <div className="spacer" />
              <span className="dim" style={{ fontSize: 11 }}>
                {e.createdAt ? formatRelativeTime(e.createdAt) : ""}
              </span>
              {e.model && <span className="history-model dim">{e.model}</span>}
              {e.contextLength ? <span className="dim"> 上下文{e.contextLength}字</span> : null}
              {e.agentToolCalls ? (
                <span className="dim" title={`该条由 agent 执行，调用了 ${e.agentToolCalls} 次本地工具`}>{" "}
                  🔧×{e.agentToolCalls}
                </span>
              ) : null}
            </button>
            <div className="history-actions">
              <button className="ghost small" onClick={() => onRerun(e)} title="再次运行">
                运行
              </button>
              <button className="ghost small" onClick={() => void copyOutput(e)} disabled={!e.output} title="复制输出">
                复制
              </button>
              {savedIds.has(e.id ?? "") ? (
                <button className="ghost small" disabled title="已存入笔记">
                  ✓ 已存
                </button>
              ) : (
                <button
                  className="ghost small"
                  onClick={() => void saveToNote(e)}
                  disabled={!e.output}
                  title="把输出存为本地笔记"
                >
                  存笔记
                </button>
              )}
              <button className="ghost small danger" onClick={() => void removeOne(e)} title="删除该条">
                ✕
              </button>
            </div>
            {open === (e.id ?? String(i)) && (
              <div className="history-detail">
                <div className="history-ctx">
                  <span className="dim">上下文（{e.contextLength ?? 0} 字）：</span>
                  <pre>{e.contextPreview ?? "（无）"}{!e.contextPreview ? "（预览不可用）" : ""}</pre>
                </div>
                <pre className="history-output">{e.output ?? "（无输出）"}{!e.output ? "（输出不可用）" : ""}</pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
