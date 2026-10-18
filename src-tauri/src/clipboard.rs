// Clipboard read/write + optional change-watching (100ms poll) + image attach (M2).
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub struct ClipboardBackend {
    watch_state: Arc<AtomicBool>,
}

impl ClipboardBackend {
    pub fn new(_app: AppHandle) -> Self {
        Self {
            watch_state: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn watch_state(&self) -> Arc<AtomicBool> {
        self.watch_state.clone()
    }
}

#[tauri::command]
pub fn get_clipboard_text(state: State<'_, super::AppState>) -> Result<String, String> {
    match state.app.clipboard().read_text() {
        Ok(text) => Ok(text),
        Err(e) => Err(format!("Failed to read clipboard: {e}")),
    }
}

#[tauri::command]
pub fn set_clipboard_text(state: State<'_, super::AppState>, text: String) -> Result<(), String> {
    state
        .app
        .clipboard()
        .write_text(text)
        .map_err(|e| format!("Failed to write clipboard: {e}"))
}

/// Start or stop the clipboard change watcher.
/// Polls every 100ms; emits "aibar:selection-changed" with the new text
/// only when it differs from the previously emitted value and is non-empty.
#[tauri::command]
pub fn start_clipboard_watch(
    app: AppHandle,
    state: State<'_, super::AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .clipboard
        .watch_state()
        .store(enabled, Ordering::Relaxed);

    if enabled {
        // Spawn a single long-lived watcher; `Once` guarantees it starts once.
        static STARTED: Once = Once::new();
        STARTED.call_once(|| {
            let flag = state.clipboard.watch_state();
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut last: Option<String> = None;
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    if !flag.load(Ordering::Relaxed) {
                        last = None;
                        continue;
                    }
                    // Clipboard read is a short syscall; hop to a blocking
                    // thread so we never stall the async runtime.
                    let app_block = app2.clone();
                    let text =
                        match tauri::async_runtime::spawn_blocking(move || {
                            app_block.clipboard().read_text().ok()
                        })
                        .await
                        {
                            Ok(inner) => inner,
                            Err(_) => continue,
                        };
                    let Some(text) = text else { continue };
                    if !text.is_empty() && last.as_deref() != Some(text.as_str()) {
                        last = Some(text.clone());
                        let _ = app2.emit("aibar:selection-changed", text);
                    }
                }
            });
        });
    }
    Ok(())
}

// ============ M2：剪贴板图片直接附着 ============

/// 探测到的剪贴板图片信息（尺寸 + 剪贴板序列号）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipImageInfo {
    pub width: u32,
    pub height: u32,
    /// GetClipboardSequenceNumber()，新鲜度令牌：save 时再取一次，不一致说明被覆盖。
    pub seq: u32,
}

/// 原始 RGBA 字节上限（≈200MB，约 5000 万像素级）。
const CLIP_MAX_BYTES: u64 = 200 * 1024 * 1024;

fn clip_dir() -> PathBuf {
    std::env::temp_dir().join("aibar")
}

/// 探测：剪贴板里有图就返回尺寸 + seq，否则 None。零写盘。
/// 剪贴板只有文本等「无图」情况不是错误，前端据此不显示芯片。
#[tauri::command]
pub fn probe_clipboard_image(
    state: State<'_, super::AppState>,
) -> Result<Option<ClipImageInfo>, String> {
    // winapi 的 extern 块统一标 unsafe，实际是安全调用。
    let seq = unsafe { winapi::um::winuser::GetClipboardSequenceNumber() };
    if seq == 0 {
        return Ok(None);
    }
    match state.app.clipboard().read_image() {
        Ok(img) if img.width() > 0 && img.height() > 0 => Ok(Some(ClipImageInfo {
            width: img.width(),
            height: img.height(),
            seq,
        })),
        _ => Ok(None),
    }
}

/// 附着：seq 必须与探测时一致（防止「旧尺寸 + 新内容」错配）→
/// 剪贴板图落盘 %TEMP%\aibar\clip-<毫秒戳>.bmp（top-down 24-bit）→ ScreenshotMeta。
/// 落盘后顺手清理 24h 前的旧 clip-*.bmp（best effort）。
#[tauri::command]
pub fn save_clipboard_image(
    state: State<'_, super::AppState>,
    expected_seq: u32,
) -> Result<super::screenshot::ScreenshotMeta, String> {
    let seq = unsafe { winapi::um::winuser::GetClipboardSequenceNumber() };
    if seq == 0 || seq != expected_seq {
        return Err("剪贴板内容已变化，请重新复制图片后再附着。".to_string());
    }
    let img = state
        .app
        .clipboard()
        .read_image()
        .map_err(|e| format!("读取剪贴板图片失败：{e}"))?;
    let w = img.width();
    let h = img.height();
    if w == 0 || h == 0 {
        return Err("剪贴板里没有图片内容".to_string());
    }
    let rgba = img.rgba();
    let raw_bytes = (w as u64) * (h as u64) * 4;
    if raw_bytes > CLIP_MAX_BYTES || rgba.len() as u64 != raw_bytes {
        return Err(format!(
            "剪贴板图片过大（约 {}MB），请缩小后重试。",
            raw_bytes / 1024 / 1024
        ));
    }
    let bytes = encode_bmp_24(w, h, rgba);
    std::fs::create_dir_all(clip_dir())
        .map_err(|e| format!("无法创建临时目录：{e}"))?;
    let now = SystemTime::now();
    let ms = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = clip_dir().join(format!("clip-{ms}.bmp"));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入临时图片失败：{e}"))?;
    clean_old_clip_files(now);
    let md = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    let mtime = md.modified().unwrap_or(now);
    super::screenshot::build_meta(&path, md.len(), mtime)
        .ok_or_else(|| "生成截图元数据失败".to_string())
}

/// arboard 的 RGBA8（row-major、top-down）→ top-down 24-bit BMP
///（14 字节 FILEHEADER + 40 字节 INFOHEADER，行 4 字节对齐，丢弃 alpha）。
/// top-down 用负高度标记，避免翻行。
fn encode_bmp_24(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let stride = ((w as u64) * 3 + 3) & !3;
    let img_size = stride * (h as u64);
    let file_size = 54 + img_size;
    let mut v = vec![0u8; file_size as usize];
    // BITMAPFILEHEADER (14)
    v[0] = b'B';
    v[1] = b'M';
    v[2..6].copy_from_slice(&(file_size as u32).to_le_bytes());
    // v[6..10] reserved = 0
    v[10..14].copy_from_slice(&54u32.to_le_bytes());
    // BITMAPINFOHEADER (40)
    v[14..18].copy_from_slice(&40u32.to_le_bytes());
    v[18..22].copy_from_slice(&(w as i32).to_le_bytes());
    v[22..26].copy_from_slice(&(-(h as i32)).to_le_bytes()); // 负数 = top-down
    v[26..28].copy_from_slice(&1u16.to_le_bytes());
    v[28..30].copy_from_slice(&24u16.to_le_bytes());
    // v[30..34] BI_RGB = 0；v[34..38] 像素区大小
    v[34..38].copy_from_slice(&(img_size as u32).to_le_bytes());
    // v[38..54] 分辨率 / 色表 = 0
    let px = &mut v[54..];
    for y in 0..h as usize {
        let s = y * w as usize * 4;
        let d = y * stride as usize;
        for x in 0..w as usize {
            let si = s + x * 4;
            px[d + x * 3] = rgba[si + 2]; // B
            px[d + x * 3 + 1] = rgba[si + 1]; // G
            px[d + x * 3 + 2] = rgba[si]; // R（A 丢弃）
        }
    }
    v
}

/// 清理 %TEMP%\aibar 下 24h 前的 clip-*.bmp（best effort，失败静默）。
fn clean_old_clip_files(now: SystemTime) {
    let entries = match std::fs::read_dir(clip_dir()) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let fname = entry.file_name();
        let name = match fname.to_str() {
            Some(n) => n,
            None => continue,
        };
        if !name.starts_with("clip-") || !name.ends_with(".bmp") {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        let Ok(mtime) = md.modified() else { continue };
        if now
            .duration_since(mtime)
            .map(|d| d.as_secs() > 24 * 3600)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{clean_old_clip_files, clip_dir, encode_bmp_24};
    use crate::screenshot::read_dimensions;
    use std::time::SystemTime;

    /// 2×2 RGBA → top-down 24-bit BMP：头字节、stride 对齐、逐像素 BGR 顺序。
    #[test]
    fn encode_bmp_24_header_and_pixels() {
        // 左上红、右上绿、左下蓝、右下白
        let rgba: [u8; 16] = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let v = encode_bmp_24(2, 2, &rgba);
        // w=2 → stride = 6 字节 + 2 填充 = 8
        assert_eq!(v.len(), 54 + 8 * 2);
        assert_eq!(&v[0..2], b"BM");
        assert_eq!(&v[2..6], &70u32.to_le_bytes());
        assert_eq!(&v[10..14], &54u32.to_le_bytes());
        assert_eq!(&v[14..18], &40u32.to_le_bytes());
        assert_eq!(&v[18..22], &2i32.to_le_bytes());
        assert_eq!(&v[22..26], &(-2i32).to_le_bytes()); // top-down
        assert_eq!(&v[26..28], &1u16.to_le_bytes());
        assert_eq!(&v[28..30], &24u16.to_le_bytes());
        assert_eq!(&v[30..34], &0u32.to_le_bytes());
        assert_eq!(&v[34..38], &16u32.to_le_bytes());
        // 顶行：红(0,0,255) 绿(0,255,0) + 2 填充
        assert_eq!(&v[54..62], &[0, 0, 255, 0, 255, 0, 0, 0]);
        // 底行：蓝(255,0,0) 白(255,255,255) + 2 填充
        assert_eq!(&v[62..70], &[255, 0, 0, 255, 255, 255, 0, 0]);
    }

    /// 宽=3 时 stride 9→12：填充必须存在且文件尺寸自洽。
    #[test]
    fn encode_bmp_24_stride_padding() {
        let rgba = vec![0xABu8; 3 * 2 * 4];
        let v = encode_bmp_24(3, 2, &rgba);
        assert_eq!(v.len(), 54 + 12 * 2);
        assert_eq!(&v[34..38], &24u32.to_le_bytes());
    }

    /// 交叉验证：写出的 top-down BMP 能被 read_dimensions 正读（负高度）。
    #[test]
    fn top_down_bmp_readable_by_read_dimensions() {
        let rgba = vec![0x80u8; 4 * 4 * 4];
        let v = encode_bmp_24(4, 4, &rgba);
        let _ = std::fs::create_dir_all(clip_dir());
        let p = clip_dir().join("clip-test-bmp-check.bmp");
        std::fs::write(&p, &v).expect("write");
        let (w, h) = read_dimensions(&p);
        assert_eq!((w, h), (Some(4), Some(4)));
        let _ = std::fs::remove_file(&p);
    }

    /// 清理只动 clip-*.bmp，新鲜文件与非 clip 文件不受影响。
    #[test]
    fn clean_old_keeps_fresh_and_non_clip_files() {
        let dir = clip_dir();
        let _ = std::fs::create_dir_all(&dir);
        let fresh = dir.join("clip-fresh-test.bmp");
        let other = dir.join("clip-notes.txt");
        std::fs::write(&fresh, b"x").expect("write");
        std::fs::write(&other, b"x").expect("write");
        clean_old_clip_files(SystemTime::now());
        assert!(fresh.exists());
        assert!(other.exists());
        let _ = std::fs::remove_file(&fresh);
        let _ = std::fs::remove_file(&other);
    }
}
