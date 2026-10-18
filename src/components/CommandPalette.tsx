// M6 命令面板（Ctrl+K）：悬浮 overlay，统一搜「命令 / 历史 / 笔记」。
// 交互：搜索框自动聚焦；↑↓ 跨分区移动；Enter 选中；Esc / 点背景 关闭。
// 纯前端 overlay，不改动输入行原有的 `/` 触发 picker。
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import type { Command, Note } from "../types";
import { fuzzyMatch, truncateChar } from "../utils/text";

interface Item {
  key: string;
  section: "命令" | "历史" | "笔记";
  label: string;
  sub?: string;
  action: () => void;
}

interface Props {
  commands: Command[];
  history: Record<string, unknown>[];
  notes: Partial<Note>[];
  onPickCommand: (name: string) => void;
  onPickHistory: (entry: Record<string, unknown>) => void;
  onPickNote: (id: string) => void;
  onClose: () => void;
}

/** 每个分区最多显示几条。 */
const PER_SECTION = 5;

export function CommandPalette({
  commands,
  history,
  notes,
  onPickCommand,
  onPickHistory,
  onPickNote,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Item[] = [];

    // 命令：与 CommandPicker 同款打分（前缀 0 > 包含 1 > 模糊 2）
    commands
      .map((c) => {
        const score = !q
          ? 0
          : c.name.startsWith(q)
            ? 0
            : c.name.includes(q)
              ? 1
              : fuzzyMatch(q, c.name)
                ? 2
                : 99;
        return { c, score };
      })
      .filter((x) => x.score < 99)
      .sort((a, b) => a.score - b.score)
      .slice(0, PER_SECTION)
      .forEach(({ c }) => {
        out.push({
          key: `cmd:${c.id}`,
          section: "命令",
          label: `/${c.name}`,
          sub: c.description,
          action: () => onPickCommand(c.name),
        });
      });

    // 历史：command + input + output 模糊匹配（字段缺失/非字符串时跳过）
    history
      .filter((h) => {
        if (!q) return true;
        const hay = [h.command, h.input, h.output]
          .filter((v): v is string => typeof v === "string")
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, PER_SECTION)
      .forEach((h, i) => {
        const cmd = typeof h.command === "string" ? h.command : "?";
        const input = typeof h.input === "string" ? h.input : "";
        const hid = typeof h.id === "string" ? h.id : `idx-${i}`;
        out.push({
          key: `hist:${hid}`,
          section: "历史",
          label: input ? `/${cmd} ${truncateChar(input, 48)}` : `/${cmd}`,
          sub:
            typeof h.contextPreview === "string" && h.contextPreview
              ? `[上下文] ${truncateChar(h.contextPreview, 40)}`
              : undefined,
          action: () => onPickHistory(h),
        });
      });

    // 笔记：标题 + 正文模糊匹配
    notes
      .filter((n) => n.id)
      .filter((n) => {
        if (!q) return true;
        const hay = `${n.title ?? ""} ${n.content ?? ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, PER_SECTION)
      .forEach((n) => {
        out.push({
          key: `note:${n.id}`,
          section: "笔记",
          label: n.title || "(未命名)",
          sub: n.content ? truncateChar(n.content, 48) : undefined,
          action: () => onPickNote(n.id as string),
        });
      });

    return out;
  }, [query, commands, history, notes, onPickCommand, onPickHistory, onPickNote]);

  // 查询变化后选区回到顶部
  useEffect(() => {
    setSel(0);
  }, [query]);

  // 选中行滚入可见区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, items.length]);

  const pick = (it: Item) => it.action();

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) pick(it);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <input
          className="palette-search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="搜索命令 / 历史 / 笔记…"
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty dim">没有匹配「{query}」的条目。</div>
          )}
          {items.map((it, i) => (
            <div
              key={it.key}
              data-idx={i}
              className={clsx("palette-item", i === sel && "sel")}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(it)}
            >
              <span className="palette-section">{it.section}</span>
              <span className="palette-label">{it.label}</span>
              {it.sub && (
                <span className="palette-sub dim" title={it.sub}>
                  {it.sub}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="palette-foot dim">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
      </div>
    </div>
  );
}
