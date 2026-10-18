// AI Command Bar — Tauri 2 backend.

mod ai;
mod clipboard;
mod cmd;
mod model_config_holder;
mod screenshot;
mod secrets;
mod shortcuts;
mod startup;
mod store;
mod sysinfo;
mod tray;
mod window;

pub use shortcuts::Manager as ShortcutsManager;

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

pub struct AppState {
    pub store: store::Store,
    pub clipboard: clipboard::ClipboardBackend,
    pub shortcuts: ShortcutsManager,
    pub model: model_config_holder::ModelConfigHolder,
    pub gateway: ai::Gateway,
    pub app: AppHandle,
}

impl AppState {
    pub fn new(app: AppHandle) -> Self {
        let store = store::Store::open(&app).expect("store open failed");
        let clipboard = clipboard::ClipboardBackend::new(app.clone());
        let shortcuts = ShortcutsManager::new(app.clone());
        let model = model_config_holder::ModelConfigHolder::load(&store);
        let gateway = ai::Gateway::new(&store);
        AppState {
            store,
            clipboard,
            shortcuts,
            model,
            gateway,
            app,
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            window::toggle_window,
            window::show_window,
            window::hide_window,
            window::focus_window,
            window::set_window_height,
            clipboard::get_clipboard_text,
            clipboard::set_clipboard_text,
            clipboard::start_clipboard_watch,
            clipboard::probe_clipboard_image,
            clipboard::save_clipboard_image,
            secrets::save_api_key,
            secrets::get_api_key,
            secrets::delete_api_key,
            cmd::load_settings,
            cmd::save_settings,
            cmd::load_model_config,
            cmd::save_model_config,
            ai::ai_chat,
            ai::ai_stream,
            ai::ai_test_connection,
            ai::ai_cancel,
            screenshot::latest_screenshot,
            screenshot::ocr_image,
            screenshot::screenshot_data_url,
            cmd::list_history,
            cmd::save_history,
            cmd::clear_history,
            cmd::delete_history,
            cmd::list_notes,
            cmd::save_note,
            cmd::delete_note,
            cmd::list_custom_commands,
            cmd::save_custom_command,
            cmd::delete_custom_command,
            cmd::load_model_presets,
            cmd::save_model_presets,
            startup::register_global_shortcut,
            startup::enable_autostart,
            startup::disable_autostart,
            startup::set_tray_visibility,
            startup::apply_autostart,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(handle.clone());
            app.manage(state);
            app.manage(ai::CancelState::new());
            // 从已保存的设置决定：自启动 + 显示托盘 + 启动时隐藏。
            // （state 已通过 app.manage 移交，这里用 handle 重新打开同一存储空间）
            let settings_store = store::Store::open(&handle).expect("store re-open failed");
            let settings_value = settings_store.get("settings");
            let show_tray = settings_value
                .get("showTrayIcon")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if show_tray {
                let _ = tray::init_tray(&handle);
            }
            // 自启动
            let launch = settings_value
                .get("launchAtStartup")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if launch {
                let _ = app.autolaunch().enable();
            } else {
                let _ = app.autolaunch().disable();
            }
            // 启动时若 startMinimized != false 都隐藏；显式 false 才显示。
            let start_min = settings_value
                .get("startMinimized")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if start_min {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {});
}
