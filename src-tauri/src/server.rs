use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, AppHandle};

static SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static SERVER_STDERR: Mutex<Option<std::process::ChildStderr>> = Mutex::new(None);
static WATCHDOG: Mutex<Option<tokio::task::JoinHandle<()>>> = Mutex::new(None);

const MAX_RETRIES: u32 = 3;
const RETRY_BASE_MS: u64 = 800;

/// Write to stderr AND a log file (stderr is invisible on Windows GUI apps).
macro_rules! log {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("{}", msg);
        let temp = std::env::var("TEMP")
            .or_else(|_| std::env::var("TMPDIR"))
            .unwrap_or_default();
        if !temp.is_empty() {
            let log_path = std::path::PathBuf::from(&temp).join("deep-desk.log");
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&log_path) {
                use std::io::Write;
                let _ = writeln!(f, "{}", msg);
            }
        }
    }};
}

/// Retry-aware server start. Returns true if the server is up and healthy.
pub async fn start(app: &AppHandle) {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    // App Store build: use bundled Node.js instead of bun (bun links libicucore — non-public API).
    // Non-App Store: bundled bun first, then system bun, then system node.
    #[cfg(all(target_os = "macos", app_store))]
    let (runtime, server_script) = {
        let node = resource_dir.join(super::NODE_PATH);
        let script = resource_dir.join("server").join("dist").join("server.js");
        if node.exists() {
            (node, script)
        } else {
            log!("[Deep Desk] Bundled Node.js not found, using system node");
            (std::path::PathBuf::from("node"), script)
        }
    };

    #[cfg(not(all(target_os = "macos", app_store)))]
    let (runtime, server_script) = {
        let bundled = resource_dir.join(super::BUN_PATH);
        let bun = if bundled.exists() {
            bundled
        } else {
            log!("[Deep Desk] Bundled bun not found, using system bun");
            std::path::PathBuf::from("bun")
        };
        #[cfg(all(target_os = "windows", target_arch = "x86"))]
        let script = resource_dir.join("server").join("dist").join("server.mjs");
        #[cfg(not(all(target_os = "windows", target_arch = "x86")))]
        let script = resource_dir.join("server").join("src").join("server.ts");
        (bun, script)
    };

    // Ensure runtime binary is executable on macOS
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&runtime) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&runtime, perms);
            }
        }
    }

    // Load env from ~/.deepdesk.env and project .env
    let env = load_env();
    let resource_dir_clone = resource_dir.clone();

    // Retry loop: up to MAX_RETRIES attempts with exponential backoff
    let mut last_detail = String::new();
    for attempt in 1..=MAX_RETRIES {
        if attempt > 1 {
            let delay = RETRY_BASE_MS * (1 << (attempt - 2)); // 0.8s, 1.6s, 3.2s
            log!("[Deep Desk] Retry attempt {}/{} after {}ms", attempt, MAX_RETRIES, delay);
            tokio::time::sleep(Duration::from_millis(delay)).await;
            // Kill any residual process from the previous attempt
            kill_inner();
        }

        let cmd_result = spawn_server(
            &runtime,
            &server_script,
            &resource_dir_clone,
            &env,
        );

        match cmd_result {
            Ok(mut child) => {
                *SERVER_STDERR.lock().unwrap() = child.stderr.take();
                *SERVER_PROCESS.lock().unwrap() = Some(child);
            }
            Err(e) => {
                log!("[Deep Desk] Failed to spawn server (attempt {}): {e}", attempt);
                last_detail = format!("Failed to launch server process: {e}");
                continue;
            }
        };

        // Health check polling
        let health_url = format!("http://localhost:{}/api/health", super::SERVER_PORT);
        let max_wait = if cfg!(debug_assertions) { 20 } else { 15 };
        let mut ready = false;
        let mut exit_status: Option<std::process::ExitStatus> = None;

        for _ in 0..(max_wait * 2) {
            match reqwest::get(&health_url).await {
                Ok(r) if r.status().is_success() => {
                    ready = true;
                    break;
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Some(ref mut child) = *SERVER_PROCESS.lock().unwrap() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        exit_status = Some(status);
                        break;
                    }
                    _ => {}
                }
            }
        }

        if ready {
            // Watchdog: monitor the server process after successful startup
            spawn_watchdog(app.clone());

            if let Some(window) = app.get_webview_window("main") {
                let _: Result<(), tauri::Error> = window.eval(&format!(
                    "window.location.replace('http://localhost:{}')",
                    super::SERVER_PORT
                ));
            }
            return;
        }

        // Collect stderr from this attempt
        last_detail = collect_failure_detail(exit_status, max_wait);
    }

    // All retries exhausted
    log!("[Deep Desk] All {} startup attempts failed. Last error: {}", MAX_RETRIES, last_detail);
    load_fallback(app, &last_detail);
}

/// Spawn the server child process. Returns Ok(child) with the stderr pipe attached.
fn spawn_server(
    runtime: &std::path::Path,
    server_script: &std::path::Path,
    resource_dir: &std::path::Path,
    env: &std::collections::HashMap<String, String>,
) -> std::io::Result<Child> {
    log!("[Deep Desk] Starting server: {:?} {:?}", runtime, server_script);

    let mut cmd = Command::new(runtime);
    // Windows x86: bundled bun binary, no "run" subcommand needed
    #[cfg(all(target_os = "windows", target_arch = "x86"))]
    cmd.arg(server_script);
    // macOS App Store: Node.js runs JS directly, no "run" subcommand
    #[cfg(all(target_os = "macos", app_store))]
    cmd.arg(server_script);
    // All other platforms: bun run <script>
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86"),
        all(target_os = "macos", app_store),
    )))]
    cmd.arg("run").arg(server_script);
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(all(target_os = "macos", app_store))]
    {
        cmd.env("DEEP_DESK_APP_STORE", "1");
        cmd.env("DEEP_DESK_RESOURCES", resource_dir.to_string_lossy().to_string());
        // Read at runtime (not compile-time) to avoid baking the secret into the binary
        if let Ok(secret) = std::env::var("APP_STORE_SHARED_SECRET") {
            if !secret.is_empty() {
                cmd.env("DEEP_DESK_APP_STORE_SHARED_SECRET", secret);
            }
        }
    }

    cmd.current_dir(resource_dir)
        .envs(env)
        .env("NO_COLOR", "1")
        .env("TERM", "xterm-256color")
        .spawn()
}

/// Drain stderr from the failed attempt and build a diagnostic detail string.
fn collect_failure_detail(exit_status: Option<std::process::ExitStatus>, max_wait: u32) -> String {
    let stderr_handle = SERVER_STDERR.lock().unwrap().take();
    let stderr_text = if let Some(mut stderr) = stderr_handle {
        // Non-blocking read: grab whatever is available without blocking
        let mut buf = String::new();
        let mut reader = BufReader::new(&mut stderr);
        // Read line by line until the pipe is drained
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => buf.push_str(&line),
            }
        }
        buf
    } else {
        String::new()
    };

    let mut detail = String::new();
    if let Some(status) = exit_status {
        log!("[Deep Desk] Server exited with {}. stderr: {}", status, stderr_text);
        detail.push_str(&format!(
            "Server process exited with code {}. ",
            status.code().map_or_else(|| "unknown".to_string(), |c| c.to_string())
        ));
    } else {
        log!("[Deep Desk] Server failed to start within {}s. stderr: {}", max_wait, stderr_text);
        detail.push_str(&format!(
            "Server did not respond on port {} within {} seconds. ",
            super::SERVER_PORT, max_wait
        ));
    }
    if !stderr_text.is_empty() {
        let escaped = stderr_text.replace('\\', "\\\\").replace('`', "\\`").replace('$', "\\$");
        detail.push_str(&format!("\\n\\nServer output:\\n{}", escaped));
    }
    detail
}

/// Spawn a background task that watches the server process; restarts if it dies.
fn spawn_watchdog(app: AppHandle) {
    // Cancel any existing watchdog first
    if let Some(handle) = WATCHDOG.lock().unwrap().take() {
        handle.abort();
    }

    let handle = tokio::task::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let exited = {
                let mut guard = SERVER_PROCESS.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    child.try_wait().ok().flatten().is_some()
                } else {
                    true // No process at all — needs restart
                }
            };

            if exited {
                log!("[Deep Desk] Watchdog: server process exited, restarting...");
                kill_inner();
                start(&app).await;
                return; // start() will spawn a new watchdog
            }
        }
    });

    *WATCHDOG.lock().unwrap() = Some(handle);
}

/// Display an HTML error page when the server can't start.
fn load_fallback(app: &AppHandle, detail: &str) {
    if let Some(window) = app.get_webview_window("main") {
        // Build detail section only if there's useful info
        let detail_html = if detail.is_empty() {
            String::new()
        } else {
            let escaped = detail.replace('\\', "\\\\").replace('`', "\\`").replace('$', "\\$");
            format!(
                r#"<pre style="margin-top:16px;padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#8b949e;font-size:12px;text-align:left;max-width:480px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">{}</pre>"#,
                escaped
            )
        };
        let _: Result<(), tauri::Error> = window.eval(&format!(
            r#"document.body.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;text-align:center;padding:40px;">
              <h1 style="font-size:24px;margin-bottom:16px;">Deep Desk — Server Not Running</h1>
              <p style="color:#8b949e;max-width:420px;">The backend server on localhost:3456 failed to start. Please check your installation.</p>
              {}
              <button onclick="window.__TAURI__ && window.__TAURI__.invoke('retry_server') || location.reload()" style="margin-top:20px;padding:10px 24px;background:#58a6ff;color:#000;border:none;border-radius:6px;font-weight:600;cursor:pointer;">Retry</button>
            </div>`;"#,
            detail_html
        ));
    }
}

/// Kill the server process and all its children. Public API — also cancels watchdog.
pub fn kill() {
    // Cancel watchdog so it doesn't restart while we're killing
    if let Some(handle) = WATCHDOG.lock().unwrap().take() {
        handle.abort();
    }
    kill_inner();
}

/// Kill the process tree without touching the watchdog. Used internally during retries.
fn kill_inner() {
    if let Some(mut child) = SERVER_PROCESS.lock().unwrap().take() {
        log!("[Deep Desk] Stopping server...");
        // Drop the stderr pipe before we wait on the process — avoids deadlock
        SERVER_STDERR.lock().unwrap().take();
        let pid = child.id();
        #[cfg(unix)]
        {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
            for _ in 0..30 {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    _ => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        // Fallback force kill — only if process is still alive
        match child.try_wait() {
            Ok(Some(_)) => { /* already exited after SIGTERM */ }
            Ok(None) => {
                let _ = child.kill();
                // Wait with 5s timeout (avoid blocking forever if process is in D state)
                for _ in 0..50 {
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    }
                }
            }
            Err(_) => { /* process already reaped */ }
        }
        log!("[Deep Desk] Server stopped.");
    }
}

/// Tauri command: retry server startup (called from the fallback page's Retry button).
#[tauri::command]
pub async fn retry_server(app: AppHandle) {
    kill();
    start(&app).await;
}

/// Load environment from ~/.deepdesk.env and ~/.claude/.env.
fn load_env() -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    let env_files: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from(&home).join(".deepdesk.env"),
        std::path::PathBuf::from(&home).join(".claude").join(".env"),
    ];

    for path in env_files {
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if let Some((key, value)) = trimmed.split_once('=') {
                    let v = {
                    let s = value.trim();
                    // Only strip paired quotes, not stray quote characters
                    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2) ||
                       (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2) {
                        s[1..s.len()-1].to_string()
                    } else {
                        s.to_string()
                    }
                };
                    if !key.is_empty() && !v.is_empty() {
                        env.insert(key.to_string(), v);
                    }
                }
            }
        }
    }

    env
}
