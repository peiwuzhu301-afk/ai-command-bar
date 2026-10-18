// Startup: register shortcut, autostart toggles, tray / start-minimized control.
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn set_tray_visibility(app: AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        if app.tray_by_id("main-tray").is_none() {
            super::tray::init_tray(&app)?;
        }
    } else {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = app.remove_tray_by_id("main-tray");
            drop(tray);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn register_global_shortcut(
    app: AppHandle,
    state: State<'_, super::AppState>,
    shortcut: String,
) -> Result<(), String> {
    let _ = app; // Shortcut manager already holds a clone from setup.
    state.shortcuts.register(&shortcut)
}

#[tauri::command]
pub fn enable_autostart(app: AppHandle) -> Result<(), String> {
    app.autolaunch().enable().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn disable_autostart(app: AppHandle) -> Result<(), String> {
    app.autolaunch().disable().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn apply_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    if enable {
        app.autolaunch().enable().map_err(|e| e.to_string())
    } else {
        app.autolaunch().disable().map_err(|e| e.to_string())
    }
}
