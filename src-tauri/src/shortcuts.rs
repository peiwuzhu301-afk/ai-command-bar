// Global shortcuts: register + trigger the toggle-window command.
// Uses tauri-plugin-global-shortcut.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub struct Manager {
    app: AppHandle,
    active: Mutex<Option<String>>,
}

impl Manager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            active: Mutex::new(None),
        }
    }

    pub fn register(&self, shortcut: &str) -> Result<(), String> {
        let s = shortcut.to_string();
        let parsed: Shortcut = s
            .parse::<Shortcut>()
            .map_err(|e| format!("Invalid shortcut '{s}': {e}"))?;

        // Unregister any previously active shortcut first.
        let prev = self.active.lock().unwrap().take();
        if let Some(prev) = prev {
            if let Ok(p) = prev.parse::<Shortcut>() {
                let _ = self.app.global_shortcut().unregister(p);
            }
        }

        let app = self.app.clone();
        self.app
            .global_shortcut()
            .on_shortcut(parsed, move |_app, _shortcut, event| match event.state {
                ShortcutState::Pressed => {
                    // M4: route through the shared window command so the
                    // cross-monitor reposition runs before every show.
                    // (Before the fix this duplicated show/hide inline, which
                    // left window::toggle_window — and its M4 reposition —
                    // as dead code that Alt+Space never reached.)
                    let _ = crate::window::toggle_window(app.clone());
                    let _ = app.emit("aibar:toggle-window", ());
                }
                _ => {}
            })
            .map_err(|e| format!("Failed to register shortcut: {e}"))?;
        *self.active.lock().unwrap() = Some(s.clone());
        Ok(())
    }
}
