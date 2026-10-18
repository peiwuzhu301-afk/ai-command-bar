// Minimal diagnostic helpers shared by the app shell.

export function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return `${v.message}`;
    const s = JSON.stringify(v);
    return s && s.length > 1200 ? s.slice(0, 1200) + "…" : s || String(v);
  } catch {
    return String(v);
  }
}

// 弹出一个简单的日志浮层（一次性，关闭即可）。
export function openLogOverlay(logs: string[], _noop: () => void): void {
  const existing = document.getElementById("aibar-log-overlay");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = "aibar-log-overlay";
  el.style.cssText =
    "position:fixed;left:12px;right:12px;bottom:12px;max-height:55vh;overflow:auto;" +
    "background:#10141c;border:1px solid #2a3550;border-radius:8px;padding:10px 12px;" +
    "font-family:Consolas,monospace;font-size:11px;color:#9fb2d4;z-index:9999;" +
    "box-shadow:0 6px 24px rgba(0,0,0,0.5);white-space:pre-wrap;word-break:break-all;";
  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:space-between;margin-bottom:6px;color:#7db8ff;font-weight:600;";
  header.textContent = "开发日志（点击任意处或按 Esc 关闭）";
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.style.cssText =
    "background:#22304d;color:#cfd8ff;border:1px solid #3a4a6e;border-radius:6px;padding:2px 8px;cursor:pointer;margin-left:auto;";
  close.onclick = () => el.remove();
  header.appendChild(close);
  const body = document.createElement("pre");
  body.style.margin = "0";
  body.textContent = logs.length ? logs.join("\n") : "(尚无日志)";
  el.appendChild(header);
  el.appendChild(body);
  el.onclick = (e) => {
    if (e.target === el) el.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      el.remove();
      window.removeEventListener("keydown", onKey, true);
    }
  };
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(el);
  el.scrollTop = el.scrollHeight;
}
