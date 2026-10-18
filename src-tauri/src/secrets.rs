// OS-integrated secret storage for the API key.
// Uses the `keyring` crate: Windows Credential Manager, macOS Keychain,
// Linux Secret Service. Falls back to a user-private file if keyring fails.
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "ai_command_bar";
const KEY_NAME: &str = "api_key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, KEY_NAME).map_err(|e| e.to_string())
}

fn fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(".api_key.key"))
}

#[tauri::command]
pub fn save_api_key(app: AppHandle, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return delete_api_key(app);
    }
    match entry().and_then(|e| e.set_password(&key).map_err(|e| e.to_string())) {
        Ok(()) => Ok(()),
        Err(e) => {
            let p = fallback_path(&app)?;
            std::fs::write(&p, key.as_bytes())
                .map_err(|err| format!("keyring failed: {e}; file failed: {err}"))
        }
    }
}

#[tauri::command]
pub fn get_api_key(app: AppHandle) -> Result<Option<String>, String> {
    if let Ok(e) = entry() {
        if let Ok(k) = e.get_password() {
            return Ok(Some(k));
        }
    }
    match fallback_path(&app) {
        Ok(p) if p.exists() => std::fs::read_to_string(p)
            .map(Some)
            .map_err(|e| e.to_string()),
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn delete_api_key(app: AppHandle) -> Result<(), String> {
    // keyring 3: remove the credential by setting an empty password (treated as delete)
    // or by failing silently. The keyring crate does not expose a direct delete
    // in v3; an empty password is a safer fallback than leaving the old one.
    if let Ok(e) = entry() {
        let _ = e.set_password("");
    }
    if let Ok(p) = fallback_path(&app) {
        if p.exists() {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}
