// Store-backed commands: settings, model config, history, notes, custom commands.
use serde_json::Value;
use tauri::State;

const MAX_HISTORY: usize = 1000;
const MAX_NOTES: usize = 10_000;
const MAX_CUSTOM: usize = 500;

#[tauri::command]
pub fn load_settings(state: State<'_, super::AppState>) -> Result<Value, String> {
    Ok(load_settings_core(&state.store))
}

#[tauri::command]
pub fn save_settings(state: State<'_, super::AppState>, settings: Value) -> Result<(), String> {
    state.store.set("settings", &settings)
}

#[tauri::command]
pub fn load_model_config(state: State<'_, super::AppState>) -> Result<Value, String> {
    Ok(load_model_core(&state.store))
}

#[tauri::command]
pub fn save_model_config(state: State<'_, super::AppState>, config: Value) -> Result<(), String> {
    state.store.set("model", &config)
}

#[tauri::command]
pub fn list_history(state: State<'_, super::AppState>) -> Result<Vec<Value>, String> {
    Ok(unwrap_array(state.store.get("history")))
}

#[tauri::command]
pub fn save_history(state: State<'_, super::AppState>, entry: Value) -> Result<(), String> {
    state.store.push("history", &entry, MAX_HISTORY)
}

#[tauri::command]
pub fn clear_history(state: State<'_, super::AppState>) -> Result<(), String> {
    state.store.delete("history")
}

#[tauri::command]
pub fn delete_history(state: State<'_, super::AppState>, id: String) -> Result<(), String> {
    let mut arr = unwrap_array(state.store.get("history"));
    arr.retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    state.store.set("history", &Value::Array(arr))
}

#[tauri::command]
pub fn list_notes(state: State<'_, super::AppState>) -> Result<Vec<Value>, String> {
    Ok(unwrap_array(state.store.get("notes")))
}

#[tauri::command]
pub fn save_note(state: State<'_, super::AppState>, note: Value) -> Result<(), String> {
    state.store.upsert("notes", &note, "id", MAX_NOTES)
}

#[tauri::command]
pub fn delete_note(state: State<'_, super::AppState>, id: String) -> Result<(), String> {
    let mut arr = unwrap_array(state.store.get("notes"));
    arr.retain(|n| n.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    state.store.set("notes", &Value::Array(arr))
}

#[tauri::command]
pub fn list_custom_commands(state: State<'_, super::AppState>) -> Result<Vec<Value>, String> {
    Ok(unwrap_array(state.store.get("custom_commands")))
}

#[tauri::command]
pub fn load_model_presets(state: State<'_, super::AppState>) -> Result<Value, String> {
    let v = state.store.get("model_presets");
    // 把旧对象统一成 { presets: [...], activePresetId: "" }
    match v {
        Value::Object(_) => Ok(v),
        _ => Ok(serde_json::json!({ "presets": [], "activePresetId": "" })),
    }
}

#[tauri::command]
pub fn save_model_presets(state: State<'_, super::AppState>, data: Value) -> Result<(), String> {
    // 限 50 个预设：超出部分静默截断
    let mut value = data;
    if let Value::Object(map) = &mut value {
        if map.get("presets").and_then(|v| v.as_array()).map(|a| a.len() > 50) == Some(true) {
            if let Some(Value::Array(arr)) = map.get_mut("presets") {
                arr.truncate(50);
            }
        }
    }
    state.store.set("model_presets", &value)
}

#[tauri::command]
pub fn save_custom_command(
    state: State<'_, super::AppState>,
    cmd: Value,
) -> Result<(), String> {
    state.store.upsert("custom_commands", &cmd, "id", MAX_CUSTOM)
}

#[tauri::command]
pub fn delete_custom_command(
    state: State<'_, super::AppState>,
    id: String,
) -> Result<(), String> {
    let mut arr = unwrap_array(state.store.get("custom_commands"));
    arr.retain(|c| c.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    state.store.set("custom_commands", &Value::Array(arr))
}

pub fn load_settings_core(store: &super::store::Store) -> Value {
    store.get("settings")
}

pub fn load_model_core(store: &super::store::Store) -> Value {
    store.get("model")
}

fn unwrap_array(v: Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a,
        _ => vec![],
    }
}
