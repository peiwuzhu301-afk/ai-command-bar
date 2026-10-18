// CommandPicker: fuzzy dropdown when the user is typing a command (/).
import { useMemo } from "react";
import clsx from "clsx";
import { Command } from "../types";
import { fuzzyMatch } from "../utils/text";

interface Props {
  commands: Command[];
  query: string;
  onPick: (cmd: Command) => void;
  onDismiss?: () => void;
  highlightMode?: string;
}

export function CommandPicker({ commands, query, onPick, onDismiss, highlightMode }: Props) {
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return commands;
    return commands
      .map((c) => {
        const score =
          c.name.startsWith(q) ? 0 : c.name.includes(q) ? 1 : fuzzyMatch(q, c.name) ? 2 : 99;
        return { c, score };
      })
      .filter((x) => x.score < 99)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.c);
  }, [commands, query]);

  if (!filtered.length) {
    return (
      <div className="picker picker-empty">
        <span className="dim">没有匹配 "{query}" 的命令。</span>
      </div>
    );
  }

  return (
    <div className="picker">
      {filtered.map((c) => (
        <button
          key={c.id}
          className={clsx("picker-item", c.kind === "custom" && "custom")}
          onClick={() => onPick(c)}
          onMouseDown={(e) => e.preventDefault()}
          title={c.description}
        >
          <span className="picker-name">/{c.name}</span>
          {c.modes?.length ? (
            <span className="picker-modes">
              {c.modes.slice(0, 3).map((m) => (
                <span key={m} className="pill">{m}</span>
              ))}
              {c.modes.length > 3 && <span className="pill">+{c.modes.length - 3}</span>}
            </span>
          ) : null}
          <span className="picker-desc dim">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
