// 截图探测 + OCR + data URL。
// 前端不直接碰本地文件，全部通过 Rust 命令：
//  - latest_screenshot: 扫描截图目录，取 mtime 最新的一张（有时间窗）
//  - ocr_image:       本地 OCR（Windows.Media.Ocr），path -> 文字
//  - screenshot_data_url: 读文件转 base64 data URL（缩略图 + 模型图片共用）
// OCR 结果与 data URL 都按「path|modifiedMs」缓存，同一张图不重复算。
import { ClipImageInfo, ScreenshotKey, ScreenshotMeta } from "../types";
import { TAURI, invoke } from "../lib/tauri";

/** 去重/失效 key：新截图出现后 path 或 mtime 变化，key 即变化。 */
export function shotKey(s: Pick<ScreenshotMeta, "path" | "modifiedMs">): ScreenshotKey {
  return `${s.path}|${s.modifiedMs}`;
}

let pending: Promise<ScreenshotMeta | null> | null = null;

/**
 * 扫描最新截图。maxAgeHours 缺省时自动检测 6h 窗口，手动重扫 24h。
 * 并发调用共享同一个 in-flight 请求。
 */
export function loadLatestScreenshot(
  maxAgeHours?: number,
): Promise<ScreenshotMeta | null> {
  if (!TAURI) return Promise.resolve(null);
  if (pending) return pending;
  const hours = maxAgeHours ?? 6;
  pending = invoke<ScreenshotMeta | null>("latest_screenshot", { maxAgeHours: hours })
    .then((r) => r ?? null)
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  return pending;
}

// ---------- M2：剪贴板图片（附着前探测 / 附着落盘）----------

let pendingClip: Promise<ClipImageInfo | null> | null = null;

/**
 * 探测剪贴板里是否有图：有则返回尺寸 + seq（新鲜度令牌），无则 null（不是错误）。
 * 零写盘。并发调用共享同一个 in-flight 请求。
 */
export function probeClipImage(): Promise<ClipImageInfo | null> {
  if (!TAURI) return Promise.resolve(null);
  if (pendingClip) return pendingClip;
  pendingClip = invoke<ClipImageInfo | null>("probe_clipboard_image")
    .then((r) => r ?? null)
    .catch(() => null)
    .finally(() => {
      pendingClip = null;
    });
  return pendingClip;
}

/** 附着剪贴板图片：Rust 端核对 seq（不一致抛「剪贴板内容已变化…」）→ 落盘返回 ScreenshotMeta。 */
export function saveClipImage(expectedSeq: number): Promise<ScreenshotMeta> {
  return invoke<ScreenshotMeta>("save_clipboard_image", { expectedSeq });
}

// ---------- 本地缓存 ----------

const OCR_CAP = 20;
const ocrCache = new Map<string, { text: string; at: number }>();

/** 本地 OCR 提取文字（带缓存）。失败抛错，交给调用方处理。 */
export async function ocrShot(s: ScreenshotMeta): Promise<string> {
  if (!TAURI) throw new Error("Tauri runtime required");
  const k = shotKey(s);
  const hit = ocrCache.get(k);
  if (hit) return hit.text;
  const text = await invoke<string>("ocr_image", { path: s.path });
  ocrCache.set(k, { text, at: Date.now() });
  if (ocrCache.size > OCR_CAP) evictOldest(ocrCache);
  return text;
}

const URL_CAP = 5;
const dataUrlCache = new Map<string, string>();

/** 截图 data URL（base64）。模型请求与缩略图共用（带缓存）。 */
export async function shotDataUrl(s: ScreenshotMeta): Promise<string> {
  if (!TAURI) throw new Error("Tauri runtime required");
  const k = shotKey(s);
  const hit = dataUrlCache.get(k);
  if (hit) return hit;
  const url = await invoke<string>("screenshot_data_url", { path: s.path });
  dataUrlCache.set(k, url);
  if (dataUrlCache.size > URL_CAP) {
    const first = dataUrlCache.keys().next().value;
    if (first) dataUrlCache.delete(first);
  }
  return url;
}

function evictOldest(m: Map<string, { text: string; at: number }>) {
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, v] of m) {
    if (v.at < oldestAt) {
      oldestAt = v.at;
      oldestKey = key;
    }
  }
  if (oldestKey) m.delete(oldestKey);
}

// ---------- 展示用格式化 ----------

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function agoText(ms: number): string {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}
