// apps/desktop/src-tauri/src/lib.rs  (temporary; replaced in Task 18)
mod daemon;
mod framing;
mod idle;
mod supervisor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running AI Commons");
}
