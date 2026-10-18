// CommandInput: a single-line input with Enter/Backspace/Tab handling.
import { useEffect, useRef } from "react";

interface Props {
  value: string;
  running: boolean;
  onChange: (v: string) => void;
  onEnter: () => void;
  onBackspace?: () => void;
  onTab?: () => void;
}

export function CommandInput({ value, running, onChange, onEnter, onBackspace, onTab }: Props) {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <input
      ref={ref}
      className="cmd-input"
      value={value}
      disabled={running}
      placeholder="/explain 解释 · /rewrite 改写 · /translate to zh 翻译…"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onEnter();
        } else if (e.key === "Backspace" && !value) {
          e.preventDefault();
          onBackspace?.();
        } else if (e.key === "Tab") {
          e.preventDefault();
          onTab?.();
        }
      }}
    />
  );
}
