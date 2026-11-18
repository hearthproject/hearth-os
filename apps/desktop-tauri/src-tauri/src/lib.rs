use serde::Deserialize;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WebviewWindow,
};

struct ServerProcess(Mutex<Option<Child>>);

#[derive(Deserialize)]
struct DesktopConfig {
    root: String,
}

fn local_appdata() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn hearth_home() -> PathBuf {
    local_appdata().join("Hearth")
}

fn log_line(root: &Path, message: &str) {
    let dir = root.join("logs");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("tauri.log"))
    {
        let _ = writeln!(file, "{}", message);
    }
}

fn resolve_data_root() -> PathBuf {
    if let Ok(root) = env::var("HEARTH_ROOT") {
        if !root.trim().is_empty() {
            return PathBuf::from(root);
        }
    }

    let config = hearth_home().join("desktop.json");
    if let Ok(text) = fs::read_to_string(&config) {
        if let Ok(parsed) = serde_json::from_str::<DesktopConfig>(&text) {
            if !parsed.root.trim().is_empty() {
                return PathBuf::from(parsed.root);
            }
        }
    }

    hearth_home()
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resolve_resource(app: &tauri::AppHandle, relative: &str) -> Option<PathBuf> {
    let packaged = app.path().resource_dir().ok()?.join(relative);
    if packaged.exists() {
        return Some(packaged);
    }
    let dev = repo_root().join(relative);
    dev.exists().then_some(dev)
}

fn resolve_server(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(entry) = env::var("HEARTH_SERVER_ENTRY") {
        let path = PathBuf::from(entry);
        if path.exists() {
            return Some(path);
        }
    }
    resolve_resource(app, "server/server.mjs").or_else(|| {
        let dev = repo_root().join("apps/desktop/resources/server/server.mjs");
        dev.exists().then_some(dev)
    })
}

fn resolve_web(app: &tauri::AppHandle) -> PathBuf {
    resolve_resource(app, "web").unwrap_or_else(|| repo_root().join("apps/web/dist"))
}

fn resolve_node(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(path) = env::var("HEARTH_NODE_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return path;
        }
    }
    if let Some(path) = resolve_resource(app, "node.exe") {
        return path;
    }
    PathBuf::from("node")
}

fn spawn_server(
    root: &Path,
    server: &Path,
    web: &Path,
    node: &Path,
) -> Result<Child, String> {
    let data_dir = root.join(".hearth");
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建数据目录 {}: {error}", data_dir.display()))?;

    let port = env::var("HEARTH_PORT").unwrap_or_else(|_| "4317".to_string());
    let mut command = Command::new(node);
    command
        .arg(server)
        .env("HEARTH_ROOT", root)
        .env("HEARTH_DATA_DIR", &data_dir)
        .env("HEARTH_WEB_DIST", web)
        .env("HEARTH_PORT", &port)
        .env("HEARTH_DESKTOP", "1")
        .env("HEARTH_NODE_PATH", node)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本地服务: {error}"))?;

    if let Some(stdout) = child.stdout.take() {
        let root = root.to_path_buf();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log_line(&root, &format!("[server:out] {line}"));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let root = root.to_path_buf();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_line(&root, &format!("[server:err] {line}"));
            }
        });
    }

    Ok(child)
}

fn ready_probe(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &address.parse().expect("loopback address"),
        Duration::from_millis(250),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "GET /api/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"ok\":true")
}

fn show_error(window: &WebviewWindow, message: &str) {
    let script = format!(
        "window.hearthSplash?.fail({})",
        serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string())
    );
    let _ = window.eval(&script);
}

fn wait_for_server(window: WebviewWindow, root: PathBuf, port: u16) {
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        log_line(&root, "[tauri] waiting for local server");
        while Instant::now() < deadline {
            if ready_probe(port) {
                let url = format!("http://127.0.0.1:{port}");
                log_line(&root, &format!("[tauri] server ready at {url}"));
                let _ = window.eval(&format!("window.location.replace({:?})", url));
                let _ = window.show();
                let _ = window.set_focus();
                return;
            }
            thread::sleep(Duration::from_millis(250));
        }
        log_line(&root, "[tauri] server startup timed out");
        let _ = window.show();
        show_error(&window, "本地服务在 30 秒内没有就绪。请查看 logs/tauri.log 与 logs/server.log。");
    });
}

fn stop_server(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ServerProcess>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
        return;
    };
    let pid = child.id();
    if cfg!(windows) {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    } else {
        let _ = child.kill();
    }
    let _ = child.wait();
    let lock = root_lock_path(&resolve_data_root());
    let _ = fs::remove_file(lock);
}

fn root_lock_path(root: &Path) -> PathBuf {
    root.join(".hearth").join("hearth.lock")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let root = resolve_data_root();
            let server = resolve_server(app.handle()).ok_or_else(|| {
                format!(
                    "找不到 server.mjs。请先运行构建脚本，或设置 HEARTH_SERVER_ENTRY。仓库根：{}",
                    repo_root().display()
                )
            })?;
            let web = resolve_web(app.handle());
            let node = resolve_node(app.handle());
            let port = env::var("HEARTH_PORT")
                .ok()
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(4317);

            log_line(
                &root,
                &format!(
                    "[tauri] starting root={} node={} server={} web={} port={port}",
                    root.display(),
                    node.display(),
                    server.display(),
                    web.display()
                ),
            );

            let child = spawn_server(&root, &server, &web, &node)
                .map_err(|message| {
                    log_line(&root, &format!("[tauri] {message}"));
                    message
                })?;
            app.manage(ServerProcess(Mutex::new(Some(child))));

            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "找不到主窗口".to_string())?;
            let _ = window.show();
            wait_for_server(window, root.clone(), port);

            let open = MenuItem::with_id(app, "open", "打开 Hearth", true, None::<&str>)?;
            let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &logs, &quit])?;
            let mut tray = TrayIconBuilder::new().menu(&menu);
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "open" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "logs" => {
                    let root = resolve_data_root();
                    let path = root.join("logs");
                    let _ = fs::create_dir_all(&path);
                    let _ = std::process::Command::new("explorer")
                        .arg(path)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn();
                }
                "quit" => {
                    stop_server(app);
                    app.exit(0);
                }
                _ => {}
            })
            .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Hearth");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_server(app);
        }
    });
}
