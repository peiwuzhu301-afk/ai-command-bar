// Simple JSON-file store under app data.
//
// Keys used:
//   settings         -> AppSettings object
//   model            -> ModelConfig object (no apiKey)
//   history          -> array[HistoryEntry]
//   notes            -> array[Note]
//   custom_commands  -> array[Command]
//
// Each key is persisted as a separate JSON file. Writes are atomic
// (write to .tmp then rename) so a crash mid-write doesn't corrupt data.

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn open(app: &AppHandle) -> Result<Self, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir: {e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(Self { dir })
    }

    fn file_for(&self, key: &str) -> PathBuf {
        // Sanitize: allow safe names only.
        let safe: String = key
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
            .collect();
        self.dir.join(format!("{safe}.json"))
    }

    pub fn get(&self, key: &str) -> Value {
        let path = self.file_for(key);
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| Value::Array(vec![])),
            Err(_) => Value::Array(vec![]),
        }
    }

    pub fn set(&self, key: &str, value: &Value) -> Result<(), String> {
        let path = self.file_for(key);
        let tmp = self.dir.join(format!(".{}.tmp", key));
        let s = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 若一个已存在的条目 ID 出现，原地替换（用于笔记 / 自定义命令的保存更新）。
    /// 若没有该条目，则 push + 裁剪到 max_size。
    pub fn upsert(&self, key: &str, entry: &Value, field: &str, max_size: usize) -> Result<(), String> {
        let mut arr = match self.get(key) {
            Value::Array(v) => v,
            _ => vec![],
        };
        let id = entry.get(field).and_then(|v| v.as_str()).map(String::from);
        match id {
            Some(idv) if !idv.is_empty() => {
                if let Some(pos) = arr.iter().position(|v| {
                    v.get(field).and_then(|x| x.as_str()) == Some(idv.as_str())
                }) {
                    arr[pos] = entry.clone();
                } else {
                    arr.push(entry.clone());
                }
            }
            _ => arr.push(entry.clone()),
        }
        if arr.len() > max_size {
            let drain = arr.len() - max_size.max(1);
            for _ in 0..drain {
                arr.remove(0);
            }
        }
        self.set(key, &Value::Array(arr))
    }

    /// Append an entry to an array-valued store key, trimming to maxSize from the tail.
    pub fn push(&self, key: &str, entry: &Value, max_size: usize) -> Result<(), String> {
        let mut arr = match self.get(key) {
            Value::Array(v) => v,
            _ => vec![],
        };
        arr.push(entry.clone());
        if arr.len() > max_size {
            let drain = arr.len() - max_size.max(1);
            for _ in 0..drain {
                arr.remove(0);
            }
        }
        let arr_value = Value::Array(arr);
        self.set(key, &arr_value)
    }

    pub fn delete(&self, key: &str) -> Result<(), String> {
        let path = self.file_for(key);
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
