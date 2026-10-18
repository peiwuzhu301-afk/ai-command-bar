// System tray: shows the window, opens settings, quits.
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager};
use tauri::tray::TrayIconBuilder;

pub fn init_tray(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "tray-show", "Show", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(app, "tray-settings", "Settings…", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let about = MenuItem::with_id(app, "tray-about", "About AI Command Bar", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit")).map_err(|e| e.to_string())?;

    let items: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 6] =
        [&show, &settings, &sep1, &about, &sep2, &quit];
    let menu = Menu::with_items(app, &items).map_err(|e| e.to_string())?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("AI Command Bar")
        .icon(app.default_window_icon().ok_or("no icon")?.clone())
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "tray-show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "tray-settings" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                use tauri::Emitter;
                let _ = app.emit("aibar:open-settings", ());
            }
            "tray-about" => {
                eprintln!("AI Command Bar v0.1 — local-first, model-agnostic.")
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}
