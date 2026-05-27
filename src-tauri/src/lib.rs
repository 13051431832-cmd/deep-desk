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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                server::start(&handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Destroyed => {
                    server::kill();
                    window.app_handle().exit(0);
                }
                tauri::WindowEvent::DragDrop(e) => {
                    if let tauri::DragDropEvent::Drop { paths, .. } = e {
                        let paths_str = serde_json::to_string(&paths).unwrap_or_default();
                        if let Some(wv) = window.app_handle().get_webview_window("main") {
                            let _ = wv.eval(&format!(
                                "window.__tauri_drop && window.__tauri_drop({})",
                                paths_str
                            ));
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
