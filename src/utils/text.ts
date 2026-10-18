// Small pure-text helpers shared across components.

/** Generate a stable-ish short id without an external dep. */
export function uid(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Fuzzy match: case-insensitive substring, or subsequence with priority for word starts. */
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  // Fast path: substring
  if (t.includes(q)) return true;
  // Fallback: subsequence
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

export function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

/** Leading-key characters in the response we expect — Chinese style truncation-safe. */
export function truncateChar(s: string, max: number): string {
  if (!s || s.length <= max) return s ?? "";
  return s.slice(0, max) + "…";
}

export function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} 天前`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}

/** Detect endpoint class from a base URL: local /private(LAN) / remote. */
export function endpointClass(base: string): "local" | "private" | "remote" {
  if (!base) return "remote";
  let host = "";
  try {
    const u = new URL(base);
    host = u.hostname;
  } catch {
    return "remote";
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  )
    return "local";
  // Private-ish IP heuristics for LAN
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return "private";
  return "remote";
}

/** Parse a keyboard-shortcut string like "Alt+Space" into parts we can display. */
export function displayShortcut(s: string): string {
  return s
    .split("+")
    .map((k) => k.trim())
    .join(" + ");
}

export function isValidShortcutString(s: string): boolean {
  if (!s || !s.trim()) return false;
  const keys = s.split("+").map((k) => k.trim());
  const known = new Set([
    "Alt", "Option", "Ctrl", "Control", "Cmd", "Command", "Shift",
    "Space", "Enter", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
    "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "Comma", "Period", "Slash", "Backslash", "Minus", "Equal",
  ]);
  // Heuristic: at least one key
  return keys.every((k) => /^[A-Za-z0-9]+$/.test(k) || /^[+]+$/.test(k));
}
