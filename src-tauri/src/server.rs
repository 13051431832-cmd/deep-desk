use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, AppHandle};

static SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);

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

/// Start the Bun server and wait for it to be ready, then load the webview.
pub async fn start(app: &AppHandle) {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    let bundled = resource_dir.join(super::BUN_PATH);
    let bun = if bundled.exists() {
        bundled
    } else {
        // Free edition: no bundled runtime, use system bun from PATH
        log!("[Deep Desk] Bundled bun not found, using system bun");
        std::path::PathBuf::from("bun")
    };

    // Ensure bun is executable on macOS
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bun) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&bun, perms);
            }
        }
    }

    // Load env from ~/.deepdesk.env and project .env
    let env = load_env();

    // Find the server script — it's in the resource directory
    let server_script = resource_dir.join("server").join("src").join("server.ts");

    log!("[Deep Desk] Starting server: {:?} run {:?}", bun, server_script);

    let _child = match Command::new(&bun)
        .arg("run")
        .arg(&server_script)
        .current_dir(&resource_dir)
        .envs(&env)
        .env("NO_COLOR", "1")
        .env("TERM", "xterm-256color")
        .spawn()
    {
        Ok(c) => {
            *SERVER_PROCESS.lock().unwrap() = Some(c);
        }
        Err(e) => {
            log!("[Deep Desk] Failed to start server: {e}. Bun path: {:?}", bun);
            load_fallback(app);
            return;
        }
    };

    // Wait for health check (poll /api/health, max 15s in production)
    let health_url = format!("http://localhost:{}/api/health", super::SERVER_PORT);
    let max_wait = if cfg!(debug_assertions) { 20 } else { 15 };
    let mut ready = false;
    for _ in 0..(max_wait * 2) {
        match reqwest::get(&health_url).await {
            Ok(r) if r.status().is_success() => {
                ready = true;
                break;
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    if ready {
        // Server is up — load the webview pointing to it
        if let Some(window) = app.get_webview_window("main") {
            let _: Result<(), tauri::Error> = window.eval(&format!(
                "window.location.replace('http://localhost:{}')",
                super::SERVER_PORT
            ));
        }
    } else {
        log!("[Deep Desk] Server failed to start within {}s", max_wait);
        load_fallback(app);
    }
}

/// Display an HTML error page when the server can't start.
fn load_fallback(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _: Result<(), tauri::Error> = window.eval(
            r#"document.body.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;text-align:center;padding:40px;">
              <h1 style="font-size:24px;margin-bottom:16px;">Deep Desk — Server Not Running</h1>
              <p style="color:#8b949e;max-width:420px;">The backend server on localhost:3456 failed to start. Please check your installation.</p>
              <button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#58a6ff;color:#000;border:none;border-radius:6px;font-weight:600;cursor:pointer;">Retry</button>
            </div>`;"#,
        );
    }
}

/// Kill the Bun server process and all its children.
pub fn kill() {
    if let Some(mut child) = SERVER_PROCESS.lock().unwrap().take() {
        log!("[Deep Desk] Stopping server...");
        #[cfg(unix)]
        {
            // SIGTERM the process group — propagates to CCB, node, etc.
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(child.id() as i32),
                nix::sys::signal::Signal::SIGTERM,
            ).ok();
            for _ in 0..30 {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    _ => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        }
        #[cfg(windows)]
        {
            // taskkill /T kills the process tree — bun.exe + CCB + node children.
            // child.kill() alone would only TerminateProcess bun.exe, orphaning subprocesses.
            let pid = child.id();
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        // Fallback force kill (Unix: after SIGTERM grace period; Windows: if taskkill failed)
        let _ = child.kill();
        let _ = child.wait();
        log!("[Deep Desk] Server stopped.");
    }
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
                    let v = value.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !key.is_empty() && !v.is_empty() {
                        env.insert(key.to_string(), v);
                    }
                }
            }
        }
    }

    env
}
