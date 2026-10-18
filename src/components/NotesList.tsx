// NotesList: local notes (CRUD + search) under Notes tab.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TAURI, invoke } from "../lib/tauri";
import { formatRelativeTime, uid } from "../utils/text";
import type { Note } from "../types";

interface Props {
  /** App 在路由进来时调用一次拉笔记 */
  refresh: () => Promise<void>;
  /** M6：命令面板跳转过来的目标笔记 id（null/缺省 = 不自动打开）。 */
  openNoteId?: string | null;
  /** M6：nonce，面板每次选中都递增，同一条笔记也能再次打开编辑器。 */
  openNoteNonce?: number;
  /** 返回主界面（结果页） */
  onBack?: () => void;
}

interface Draft {
  id: string; // 空字符串 = 新建
  title: string;
  content: string;
  tags: string;
  createdAt: string;
}

const EMPTY: Draft = { id: "", title: "", content: "", tags: "", createdAt: "" };

export function NotesList({ refresh, openNoteId, openNoteNonce, onBack }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!TAURI) return;
    try {
      const list = await invoke<Partial<Note>[]>("list_notes");
      const arr = (list ?? []).map((n, i): Note => ({
        id: n.id ?? `note-${i}`,
        title: n.title ?? "(未命名)",
        content: n.content ?? "",
        tags: Array.isArray(n.tags) ? n.tags : [],
        createdAt: n.createdAt ?? new Date().toISOString(),
      }));
      setNotes(arr);
    } catch (e) {
      console.error(e);
      setNotes([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void refresh();
  }, [load, refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [notes, query]);

  const save = useCallback(async () => {
    if (!draft || !draft.title.trim()) return;
    setSaving(true);
    const note: Note = {
      id: draft.id || uid("note-"),
      title: draft.title.trim(),
      content: draft.content,
      tags: draft.tags
        .split(/[,，;；\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
      createdAt: draft.id ? new Date(draft.createdAt).toISOString() : new Date().toISOString(),
    };
    try {
      if (TAURI) await invoke("save_note", { note });
      setDraft(null);
      await load();
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const remove = useCallback(
    async (id: string) => {
      if (!TAURI) return;
      try {
        await invoke("delete_note", { id });
        await load();
      } catch (e) {
        console.error(e);
      }
    },
    [load],
  );

  const startNew = useCallback(() => {
    setDraft({ ...EMPTY, createdAt: new Date().toISOString() });
  }, []);
  const startEdit = useCallback((n: Note) => {
    setDraft({
      id: n.id,
      title: n.title,
      content: n.content,
      tags: n.tags.join(", "),
      createdAt: n.createdAt,
    });
  }, []);

  // M6：命令面板选中某条笔记跳过来 → 列表加载完成后自动打开它的编辑器。
  // nonce 变化会再次触发（同一条笔记可重复从面板打开）。
  const openedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openNoteId || notes.length === 0) return;
    const key = `${openNoteId}:${openNoteNonce ?? 0}`;
    if (openedKeyRef.current === key) return;
    const n = notes.find((x) => x.id === openNoteId);
    if (!n) return;
    openedKeyRef.current = key;
    startEdit(n);
  }, [openNoteId, openNoteNonce, notes, startEdit]);

  const copyNote = useCallback(async (n: Note) => {
    if (!TAURI) return;
    try {
      await invoke("set_clipboard_text", {
        text: `# ${n.title}\n\n${n.content}\n\n${n.tags.length ? `标签: ${n.tags.join(", ")}\n` : ""}`,
      });
    } catch (e) {
      console.error(e);
    }
  }, []);

  return (
    <div className="history" style={{ display: "flex" }}>
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
          placeholder="搜索标题 / 正文 / 标签…"
          spellCheck={false}
        />
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {query ? `${filtered.length} / ${notes.length}` : `${notes.length} 条`}
        </span>
        <button className="primary" onClick={startNew} disabled={!!draft}>
          + 新建
        </button>
        <button className="ghost" onClick={() => void load()} title="重新加载">
          ⟳
        </button>
      </div>

      {draft && (
        <div className="notes-editor">
          <div className="field">
            <label>标题</label>
            <input
              value={draft.title}
              onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
              placeholder="一句话标题"
              autoFocus
            />
          </div>
          <div className="field">
            <label>标签（用逗号分隔，可选）</label>
            <input
              value={draft.tags}
              onChange={(e) => setDraft((d) => (d ? { ...d, tags: e.target.value } : d))}
              placeholder="如：前端, 学习"
            />
          </div>
          <div className="field">
            <label>正文</label>
            <textarea
              rows={12}
              value={draft.content}
              onChange={(e) => setDraft((d) => (d ? { ...d, content: e.target.value } : d))}
              placeholder="正文内容（支持换行，纯文本）"
            />
          </div>
          <div className="row gap-8">
            <button className="primary" onClick={() => void save()} disabled={!draft.title.trim() || saving}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button className="ghost" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="history-list">
        {filtered.length === 0 && (
          <div className="history-empty">
            <span className="dim">{query ? `没有匹配 "${query}" 的笔记。` : "还没有笔记。点「+ 新建」或运行 /note 把上下文整理成笔记。"}</span>
          </div>
        )}
        {filtered.map((n) => (
          <div key={n.id} className="history-item">
            <button className="history-row" onClick={() => startEdit(n)} title="点击编辑">
              <span className="history-cmd" style={{ color: "var(--text)" }}>
                {n.title}
              </span>
              <div className="spacer" />
              {n.createdAt && (
                <span className="dim" style={{ fontSize: 11 }}>
                  {formatRelativeTime(n.createdAt)}
                </span>
              )}
              {n.tags.slice(0, 3).map((t) => (
                <span key={t} className="pill">
                  {t}
                </span>
              ))}
              {n.tags.length > 3 && <span className="pill">+{n.tags.length - 3}</span>}
            </button>
            {n.content && (
              <pre className="ctx-body" style={{ maxHeight: 120 }}>
                {n.content.length > 320 ? n.content.slice(0, 320) + "…" : n.content}
              </pre>
            )}
            <div className="history-actions">
              <button className="ghost small" onClick={() => void copyNote(n)} title="复制为 Markdown">
                复制
              </button>
              <button className="ghost small danger" onClick={() => void remove(n.id)} title="删除">
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
