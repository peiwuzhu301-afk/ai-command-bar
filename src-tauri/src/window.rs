// Window management: show / hide / focus / toggle / resize.
use tauri::{AppHandle, Emitter, Manager};

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

/// M4 跨屏跟随：显示前把窗口挪到「当前前台窗口所在显示器」的工作区内
///（水平居中，y = work top + (work_h − win_h)×0.3），双屏用户不再永远主屏。
/// 前台窗口/尺寸探测失败时不动位置（保持现状），绝不影响显示本身。
fn reposition_to_foreground_monitor(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};

    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return;
        }
        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(fg, &mut r).is_err() {
            return;
        }
        let mon = MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            let work = mi.rcWork;
            let Ok(size) = w.inner_size() else { return };
            let ww = size.width as i32;
            let wh = size.height as i32;
            let work_w = work.right - work.left;
            let work_h = work.bottom - work.top;
            let x = work.left + (work_w - ww) / 2;
            let y = work.top + (work_h - wh) * 3 / 10;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

#[tauri::command]
pub fn toggle_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = main_window(&app) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            reposition_to_foreground_monitor(&w);
            let _ = w.show();
            let _ = w.set_focus();
            // Tell the frontend to (re)capture context + focus the input.
            let _ = app.emit("aibar:focus-command-input", ());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn show_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = main_window(&app) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn focus_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = main_window(&app) {
        let _ = w.set_focus();
    }
    Ok(())
}

/// 调整主窗口尺寸（逻辑像素）。`width` 省略时保持当前宽度。
#[tauri::command]
pub fn set_window_height(
    app: AppHandle,
    height: f64,
    width: Option<f64>,
) -> Result<(), String> {
    if let Some(w) = main_window(&app) {
        let scale = w.scale_factor().unwrap_or(1.0);
        let h = height.clamp(120.0, 2000.0);
        let cur_w = w
            .inner_size()
            .map(|s| s.width as f64 / scale)
            .unwrap_or(680.0);
        let ww = width.unwrap_or(cur_w).clamp(480.0, 2000.0);
        let _ = w.set_size(tauri::LogicalSize::new(ww, h));
    }
    Ok(())
}
