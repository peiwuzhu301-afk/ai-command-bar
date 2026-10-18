// ContextPreview: shows captured clipboard context + char count.
import { useMemo } from "react";
import { truncateChar } from "../utils/text";

interface Props {
  text: string;
  onRemove: () => void;
  onRecapture?: () => void;
  maxContextLength: number;
}

export function ContextPreview({ text, onRemove, onRecapture, maxContextLength }: Props) {
  const chars = text.length;
  const clamped = useMemo(() => truncateChar(text, maxContextLength), [text, maxContextLength]);

  if (!text) {
    return (
      <div className="ctx-empty">
        <span className="dim">尚未捕获上下文。先复制一段文字，再按 ⟳ 加载。</span>
      </div>
    );
  }
  return (
    <div className="ctx">
      <div className="ctx-head">
        <span className="ctx-label">上下文</span>
        <span className="ctx-count">{chars.toLocaleString()} 字</span>
        <button className="ghost small" onClick={onRecapture} title="重新捕获剪贴板">
          ⟳
        </button>
        <button className="ghost small" onClick={onRemove} title="移除上下文">
          移除
        </button>
      </div>
      <pre className="ctx-body">{clamped}</pre>
    </div>
  );
}
