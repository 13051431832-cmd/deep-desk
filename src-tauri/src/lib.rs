use tauri::Manager;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const BUN_PATH: &str = "binaries/bun-darwin-aarch64/bun";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const BUN_PATH: &str = "binaries/bun-darwin-x64/bun";
#[cfg(target_os = "windows")]
const BUN_PATH: &str = "binaries/bun-windows-x64/bun.exe";

const SERVER_PORT: u16 = 3456;

mod server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                server::start(&handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                server::kill();
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
