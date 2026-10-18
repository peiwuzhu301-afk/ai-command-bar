// Placeholder owner type — we actually use the tauri store for model config,
// but keep a thin holder for cleanliness. This type isn't surfaced to the
// frontend; it only holds in-process defaults that couldn't be loaded.
pub struct ModelConfigHolder;

impl ModelConfigHolder {
    pub fn load(_store: &crate::store::Store) -> Self {
        ModelConfigHolder
    }
}
