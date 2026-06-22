use tauri::Manager;

#[tauri::command]
fn open_external(url: String) {
    open::that(url).ok();
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const BUN_PATH: &str = "binaries/bun-darwin-aarch64/bun";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const BUN_PATH: &str = "binaries/bun-darwin-x64/bun";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const BUN_PATH: &str = "binaries/bun-windows-x64/bun.exe";

// App Store build bundles Node.js instead of bun (bun links libicucore which Apple flags as non-public API).
#[cfg(all(target_os = "macos", target_arch = "aarch64", app_store))]
const NODE_PATH: &str = "binaries/node-darwin-arm64/node";

const SERVER_PORT: u16 = 3456;

mod server;
#[cfg(target_os = "macos")]
mod storekit;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init());
    #[cfg(not(app_store))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .invoke_handler({
            let mut handlers = tauri::generate_handler![
                open_external,
                server::retry_server,
            ];
            #[cfg(target_os = "macos")]
            handlers.extend(tauri::generate_handler![
                storekit::purchase_pro,
                storekit::restore_purchases,
            ]);
            handlers
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            storekit::setup_transaction_observer(&app.handle());
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
                        eprintln!("[tauri] DragDrop received {} path(s): {:?}", paths.len(), paths);
                        let paths_str = serde_json::to_string(&paths).unwrap_or_default();
                        if let Some(wv) = window.app_handle().get_webview_window("main") {
                            let _ = wv.eval(&format!(
                                "window.__tauri_drop && window.__tauri_drop({})",
                                paths_str
                            ));
                        } else {
                            eprintln!("[tauri] DragDrop: webview 'main' not found");
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
