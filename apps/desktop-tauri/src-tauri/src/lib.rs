use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write as IoWrite},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows_sys::Win32::{
    UI::Shell::ShellExecuteW,
    UI::WindowsAndMessaging::{
        MessageBoxW, IDNO, IDYES, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
        MB_YESNOCANCEL, SW_SHOWNORMAL,
    },
};

const PORT: u16 = 4317;
const MAX_RESTARTS: usize = 5;
const RESTART_DELAYS_MS: [u64; 5] = [1_000, 2_000, 5_000, 10_000, 30_000];
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const LOG_LIMIT: u64 = 5 * 1024 * 1024;
const LOG_KEEP: usize = 3;
const MB_DEFBUTTON1: u32 = 0x0000_0000;
const MB_DEFBUTTON2: u32 = 0x0000_0100;
const EXISTING_DATA_ROOT: &str = "D:\\App\\hearth-os";
const DEFAULT_CODEX_PATH: &str = "D:\\npm-global\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";

struct ServerConfig {
    root: PathBuf,
    data_dir: PathBuf,
    server: PathBuf,
    web: PathBuf,
    node: PathBuf,
    resources: PathBuf,
    codex: Option<PathBuf>,
    port: u16,
}

struct SupervisorState {
    child: Option<Child>,
    stopping: bool,
}

#[derive(Clone)]
struct Supervisor {
    state: Arc<Mutex<SupervisorState>>,
    config: Arc<ServerConfig>,
    logs: Arc<DesktopLogs>,
}

struct DesktopLogs {
    dir: PathBuf,
    main: RotatingLog,
    server: RotatingLog,
}

struct RotatingLog {
    path: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PortStatus {
    Free,
    Hearth,
    Occupied,
}

struct HttpResponse {
    status: u16,
    body: String,
}

struct EnvironmentReport {
    items: Vec<EnvironmentItem>,
    missing: usize,
    warnings: usize,
}

struct EnvironmentItem {
    id: &'static str,
    label: &'static str,
    status: EnvironmentStatus,
    detail: String,
    action: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EnvironmentStatus {
    Ok,
    Warn,
    Missing,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    #[serde(default)]
    version: Option<u32>,
    root: String,
    #[serde(default)]
    data_dir: Option<String>,
    #[serde(default)]
    last_launch_at: Option<String>,
}

#[derive(Deserialize)]
struct LockInfo {
    pid: Option<u32>,
}

#[derive(Deserialize)]
struct HealthBody {
    #[serde(rename = "chatModel")]
    chat_model: Option<ChatModel>,
}

#[derive(Deserialize)]
struct ChatModel {
    configured: Option<bool>,
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn message_box(title: &str, text: &str, style: u32) -> i32 {
    #[cfg(windows)]
    unsafe {
        let caption = wide(title);
        let body = wide(text);
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            style | MB_SETFOREGROUND | MB_TOPMOST,
        )
    }
    #[cfg(not(windows))]
    {
        eprintln!("{title}: {text}");
        let _ = style;
        0
    }
}

fn open_external(url: &str) {
    #[cfg(windows)]
    unsafe {
        let operation = wide("open");
        let file = wide(url);
        let _ = ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
    #[cfg(not(windows))]
    {
        let _ = url;
    }
}

fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn open_directory(path: &Path) {
    let _ = quiet_command("explorer")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn open_helper(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("桌面助手没有打包在当前版本里；请使用带 helper 资源的安装包。".to_string());
    }
    let mut command = Command::new("cmd");
    command.arg("/c").arg(path);
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动桌面助手: {error}"))
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn hearth_home() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Hearth")
}

impl RotatingLog {
    fn new(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        Self { path }
    }

    fn write(&self, line: &str) {
        let text = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        if let Ok(metadata) = fs::metadata(&self.path) {
            if metadata.len() + text.len() as u64 > LOG_LIMIT {
                self.rotate();
            }
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = file.write_all(text.as_bytes());
        }
    }

    fn rotate(&self) {
        for index in (1..LOG_KEEP).rev() {
            let from = sibling(&self.path, &format!(".{index}"));
            if !from.exists() {
                continue;
            }
            let to = sibling(&self.path, &format!(".{}", index + 1));
            if to.exists() {
                let _ = fs::remove_file(&to);
            }
            let _ = fs::rename(&from, &to);
        }
        let first = sibling(&self.path, ".1");
        if first.exists() {
            let _ = fs::remove_file(&first);
        }
        let _ = fs::rename(&self.path, &first);
    }
}

fn create_desktop_logs() -> DesktopLogs {
    let dir = hearth_home().join("logs");
    DesktopLogs {
        dir: dir.clone(),
        main: RotatingLog::new(dir.join("main.log")),
        server: RotatingLog::new(dir.join("server.log")),
    }
}

fn iso_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        remainder / 3600,
        (remainder % 3600) / 60,
        remainder % 60
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + i64::from(month <= 2);
    (year, month, day)
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

fn resources_dev_root() -> PathBuf {
    repo_root()
        .join("apps")
        .join("desktop-tauri")
        .join("src-tauri")
        .join("resources")
}

fn resolve_resources_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(root) = app.path().resource_dir() {
        let nested = root.join("resources");
        if nested.join("server").exists() {
            return Some(strip_verbatim(nested));
        }
        if root.join("server").exists() {
            return Some(strip_verbatim(root));
        }
    }
    let dev = resources_dev_root();
    dev.join("server").exists().then_some(dev)
}

fn resolve_resource(app: &tauri::AppHandle, relative: &str) -> Option<PathBuf> {
    let root = resolve_resources_root(app)?;
    let path = root.join(relative);
    path.exists().then_some(path)
}

fn resolve_server(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(entry) = env::var("HEARTH_SERVER_ENTRY") {
        let path = PathBuf::from(entry);
        if path.exists() {
            return Some(path);
        }
    }
    resolve_resource(app, "server/server.mjs")
}

fn resolve_web(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = resolve_resource(app, "web") {
        return Some(path);
    }
    let dev = repo_root().join("apps").join("web").join("dist");
    dev.exists().then_some(dev)
}

fn resolve_node(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(value) = env::var("HEARTH_NODE_PATH") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }
    if let Some(path) = resolve_resource(app, "node.exe") {
        return Some(path);
    }
    if cfg!(debug_assertions) {
        Some(PathBuf::from("node"))
    } else {
        None
    }
}

fn resolve_codex() -> Option<PathBuf> {
    if let Ok(value) = env::var("HEARTH_CODEX_PATH") {
        let path = PathBuf::from(value);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(output) = quiet_command("where.exe").arg("codex.exe").output() {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let candidate = line.trim();
            if candidate.to_ascii_lowercase().ends_with(".exe") && Path::new(candidate).exists() {
                return Some(PathBuf::from(candidate));
            }
        }
    }
    let fallback = PathBuf::from(DEFAULT_CODEX_PATH);
    fallback.exists().then_some(fallback)
}

fn data_dir_for(root: &Path) -> PathBuf {
    root.join(".hearth")
}

fn has_database(root: &Path) -> bool {
    data_dir_for(root).join("hearth.sqlite").exists()
}

fn read_saved_root(config_path: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(config_path).ok()?;
    let parsed = serde_json::from_str::<DesktopConfig>(&text).ok()?;
    let root = parsed.root.trim();
    if root.is_empty() {
        return None;
    }
    Some(PathBuf::from(root))
}

fn write_desktop_config(root: &Path) {
    let data_dir = data_dir_for(root);
    let config = DesktopConfig {
        version: Some(1),
        root: root.to_string_lossy().to_string(),
        data_dir: Some(data_dir.to_string_lossy().to_string()),
        last_launch_at: Some(iso_now()),
    };
    let text = serde_json::to_string_pretty(&config).unwrap_or_default();
    let dir = hearth_home();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(dir.join("desktop.json"), format!("{text}\n"));
}

fn choose_data_root() -> Option<PathBuf> {
    if let Ok(root) = env::var("HEARTH_ROOT") {
        if !root.trim().is_empty() {
            return Some(PathBuf::from(root));
        }
    }

    let config_path = hearth_home().join("desktop.json");
    let saved = read_saved_root(&config_path);
    if let Some(root) = &saved {
        if has_database(root) {
            write_desktop_config(root);
            return Some(root.clone());
        }
    }

    let existing_root = env::var("HEARTH_EXISTING_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(EXISTING_DATA_ROOT));
    let fresh_root = hearth_home();
    let existing_database = has_database(&existing_root);

    let mut text = String::from(if existing_database {
        "检测到现有 Hearth 数据。"
    } else {
        "没有检测到现有 Hearth 数据库。"
    });
    if let Some(saved) = &saved {
        if !has_database(saved) {
            text.push_str(&format!(
                "\n\n之前选择的数据目录没有找到 hearth.sqlite：{}",
                data_dir_for(saved).display()
            ));
        }
    }
    text.push_str(&format!(
        "\n\n现有数据：{}{}",
        data_dir_for(&existing_root).display(),
        if existing_database {
            "（推荐）"
        } else {
            "（尚未初始化）"
        }
    ));
    text.push_str(&format!(
        "\n新数据目录：{}",
        data_dir_for(&fresh_root).display()
    ));
    text.push_str("\n\n“是”使用现有数据；“否”新建数据目录；“取消”退出。");

    let default = if existing_database {
        MB_DEFBUTTON1
    } else {
        MB_DEFBUTTON2
    };
    let choice = message_box(
        "选择 Hearth 数据目录",
        &text,
        MB_YESNOCANCEL | MB_ICONWARNING | default,
    );
    let root = if choice == IDYES {
        existing_root
    } else if choice == IDNO {
        fresh_root
    } else {
        return None;
    };
    write_desktop_config(&root);
    Some(root)
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from > haystack.len() || needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| index + from)
}

fn decode_chunked(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    let mut position = 0;
    while position < input.len() {
        let Some(end) = find_bytes(input, b"\r\n", position) else {
            break;
        };
        let header = String::from_utf8_lossy(&input[position..end]);
        let size_text = header.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).unwrap_or(0);
        position = end + 2;
        if size == 0 {
            break;
        }
        let data_end = (position + size).min(input.len());
        output.extend_from_slice(&input[position..data_end]);
        position = data_end + 2;
    }
    output
}

fn parse_http_response(raw: &[u8]) -> Option<HttpResponse> {
    let split = find_bytes(raw, b"\r\n\r\n", 0)?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.split("\r\n");
    let status = lines.next()?.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    let lower = head.to_ascii_lowercase();
    let chunked = lower
        .lines()
        .any(|line| line.starts_with("transfer-encoding:") && line.contains("chunked"));
    let payload = &raw[split + 4..];
    let body = if chunked {
        decode_chunked(payload)
    } else {
        payload.to_vec()
    };
    Some(HttpResponse {
        status,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn http_request(port: u16, method: &str, path: &str, body: Option<&str>) -> Option<HttpResponse> {
    let address = format!("127.0.0.1:{port}");
    let mut stream = TcpStream::connect_timeout(
        &address.parse().ok()?,
        Duration::from_millis(400),
    )
    .ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let payload = body.unwrap_or("");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    parse_http_response(&raw)
}

fn ready_probe(port: u16) -> bool {
    http_request(port, "GET", "/api/ready", None)
        .map(|response| response.status == 200 && response.body.contains("Hearth"))
        .unwrap_or(false)
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if ready_probe(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }
    false
}

fn port_status(port: u16) -> PortStatus {
    let address = format!("127.0.0.1:{port}");
    if TcpStream::connect_timeout(&address.parse().expect("loopback address"), Duration::from_millis(250))
        .is_err()
    {
        return PortStatus::Free;
    }
    match http_request(port, "GET", "/api/ready", None) {
        Some(response) if response.status == 200 && response.body.contains("Hearth") => {
            PortStatus::Hearth
        }
        _ => PortStatus::Occupied,
    }
}

fn request_shutdown(port: u16) -> bool {
    http_request(port, "POST", "/api/desktop/shutdown", Some("{}"))
        .map(|response| (200..300).contains(&response.status))
        .unwrap_or(false)
}

fn spawn_server(config: &Arc<ServerConfig>, logs: &Arc<DesktopLogs>) -> Result<Child, String> {
    fs::create_dir_all(&config.root)
        .map_err(|error| format!("无法创建数据根目录 {}: {error}", config.root.display()))?;
    fs::create_dir_all(&config.data_dir)
        .map_err(|error| format!("无法创建数据目录 {}: {error}", config.data_dir.display()))?;

    let mut command = Command::new(&config.node);
    command
        .arg(&config.server)
        .env("HEARTH_ROOT", &config.root)
        .env("HEARTH_DATA_DIR", &config.data_dir)
        .env("HEARTH_WEB_DIST", &config.web)
        .env("HEARTH_PORT", config.port.to_string())
        .env("HEARTH_DESKTOP", "1")
        .env("HEARTH_NODE_PATH", &config.node)
        .current_dir(&config.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let pdf_assets = config
        .server
        .parent()
        .map(|parent| parent.join("assets").join("pdfjs"));
    if let Some(path) = pdf_assets {
        if path.exists() {
            command.env("HEARTH_PDF_ASSETS", path);
        }
    }
    if let Some(codex) = &config.codex {
        command.env("HEARTH_CODEX_PATH", codex);
    }

    let existing_path = env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![config.resources.clone()];
    paths.extend(env::split_paths(&existing_path));
    if let Ok(joined) = env::join_paths(paths) {
        command.env("PATH", joined);
    }

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本地服务: {error}"))?;

    if let Some(stdout) = child.stdout.take() {
        let logs = logs.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                logs.server.write(&format!("[stdout] {line}"));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let logs = logs.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                logs.server.write(&format!("[stderr] {line}"));
            }
        });
    }

    Ok(child)
}

fn clear_data_dir_lock(config: &ServerConfig, pid: u32) {
    let path = config.data_dir.join("hearth.lock");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(info) = serde_json::from_str::<LockInfo>(&text) else {
        return;
    };
    if info.pid == Some(pid) {
        let _ = fs::remove_file(&path);
    }
}

impl Supervisor {
    fn new(config: Arc<ServerConfig>, logs: Arc<DesktopLogs>) -> Self {
        Self {
            state: Arc::new(Mutex::new(SupervisorState {
                child: None,
                stopping: false,
            })),
            config,
            logs,
        }
    }

    fn stopping(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.stopping)
            .unwrap_or(true)
    }

    fn start(&self) -> Result<(), String> {
        match port_status(self.config.port) {
            PortStatus::Hearth => {
                return Err("另一个 Hearth 正在运行，请先关闭它，或从托盘退出旧实例。".to_string())
            }
            PortStatus::Occupied => {
                return Err("端口 4317 被占用，请关闭占用该端口的程序后重试。".to_string())
            }
            PortStatus::Free => {}
        }

        let child = spawn_server(&self.config, &self.logs)?;
        if let Ok(mut state) = self.state.lock() {
            state.child = Some(child);
        }

        if !wait_ready(self.config.port, Duration::from_secs(30)) {
            if let Ok(mut state) = self.state.lock() {
                if let Some(mut child) = state.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            return Err("Hearth 服务端在 30 秒内没有就绪。请查看 logs/server.log。".to_string());
        }

        self.logs.main.write("server ready");
        let supervisor = self.clone();
        thread::spawn(move || supervise(supervisor));
        Ok(())
    }

    fn stop(&self) {
        let child = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            if state.stopping {
                return;
            }
            state.stopping = true;
            state.child.take()
        };
        let Some(mut child) = child else {
            return;
        };
        let pid = child.id();
        self.logs.main.write("stopping local server");

        let mut exited = false;
        if request_shutdown(self.config.port) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    exited = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }

        if !exited {
            if cfg!(windows) {
                let _ = quiet_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            } else {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        clear_data_dir_lock(&self.config, pid);
        self.logs.main.write("local server stopped");
    }
}

fn restart_delay(attempt: usize) -> Option<u64> {
    RESTART_DELAYS_MS.get(attempt).copied()
}

fn supervise(supervisor: Supervisor) {
    let mut attempt = 0usize;
    loop {
        loop {
            if supervisor.stopping() {
                return;
            }
            let exited = {
                let Ok(mut state) = supervisor.state.lock() else {
                    return;
                };
                if state.stopping {
                    return;
                }
                match state.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            state.child = None;
                            supervisor
                                .logs
                                .main
                                .write(&format!("server exited status={status}"));
                            true
                        }
                        Ok(None) => false,
                        Err(error) => {
                            supervisor
                                .logs
                                .main
                                .write(&format!("server wait failed: {error}"));
                            false
                        }
                    },
                    None => true,
                }
            };
            if exited {
                break;
            }
            thread::sleep(Duration::from_millis(300));
        }

        let Some(delay) = restart_delay(attempt) else {
            supervisor
                .logs
                .main
                .write("server exceeded restart budget");
            message_box(
                "Hearth 服务端停止",
                &format!("Hearth 服务端连续退出 {MAX_RESTARTS} 次，已停止重启。请查看日志。"),
                MB_OK | MB_ICONWARNING,
            );
            return;
        };
        attempt += 1;
        supervisor.logs.main.write(&format!(
            "server restart attempt={attempt} delay={delay}ms"
        ));

        let deadline = Instant::now() + Duration::from_millis(delay);
        while Instant::now() < deadline {
            if supervisor.stopping() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if supervisor.stopping() {
            return;
        }

        match spawn_server(&supervisor.config, &supervisor.logs) {
            Ok(mut child) => {
                if let Ok(mut state) = supervisor.state.lock() {
                    if state.stopping {
                        drop(state);
                        let _ = child.kill();
                        return;
                    }
                    state.child = Some(child);
                }
                if wait_ready(supervisor.config.port, Duration::from_secs(30)) {
                    supervisor.logs.main.write("server ready after restart");
                    attempt = 0;
                } else {
                    supervisor
                        .logs
                        .main
                        .write("server failed to become ready after restart");
                    if let Ok(mut state) = supervisor.state.lock() {
                        if let Some(mut child) = state.child.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
            Err(error) => {
                supervisor
                    .logs
                    .main
                    .write(&format!("server respawn failed: {error}"));
            }
        }
    }
}

fn run_capture(program: &Path, args: &[&str]) -> (bool, String) {
    let mut command = quiet_command(program);
    command.args(args).stdin(Stdio::null());
    match command.output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            (output.status.success(), text.trim().to_string())
        }
        Err(error) => (false, error.to_string()),
    }
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

fn check_environment(config: &ServerConfig) -> EnvironmentReport {
    let (configured, reachable, model_detail) =
        match http_request(config.port, "GET", "/api/health", None) {
            Some(response) if response.status == 200 => {
                match serde_json::from_str::<HealthBody>(&response.body) {
                    Ok(body) => {
                        let configured = body
                            .chat_model
                            .and_then(|model| model.configured)
                            .unwrap_or(false);
                        (
                            configured,
                            true,
                            if configured {
                                "聊天模型已配置".to_string()
                            } else {
                                "尚未配置聊天模型，聊天不可用（可在界面里设置）".to_string()
                            },
                        )
                    }
                    Err(_) => (
                        false,
                        true,
                        "健康检查返回了无法解析的内容".to_string(),
                    ),
                }
            }
            Some(response) => (
                false,
                false,
                format!("健康检查返回 HTTP {}", response.status),
            ),
            None => (false, false, "无法连接 Hearth 服务".to_string()),
        };

    let git = run_capture(Path::new("git.exe"), &["--version"]);
    let gh = run_capture(Path::new("gh.exe"), &["--version"]);

    let npm_cli = config
        .resources
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    let npm = if npm_cli.exists() {
        let cli = npm_cli.to_string_lossy().to_string();
        run_capture(&config.node, &[cli.as_str(), "--version"])
    } else {
        (false, "未找到内置 npm".to_string())
    };

    let helper = config.resources.join("helper").join("helper.cmd");

    let mut items = Vec::new();
    items.push(EnvironmentItem {
        id: "model",
        label: "聊天模型",
        status: if configured {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Missing
        },
        detail: model_detail.clone(),
        action: "在 Hearth 设置里填写 API Key 和模型名称",
    });
    items.push(EnvironmentItem {
        id: "git",
        label: "Git",
        status: if git.0 {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Missing
        },
        detail: if git.0 {
            first_line(&git.1)
        } else {
            "未找到 git.exe".to_string()
        },
        action: "安装 Git for Windows 后重新启动",
    });
    items.push(EnvironmentItem {
        id: "gh",
        label: "GitHub CLI",
        status: if gh.0 {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Warn
        },
        detail: if gh.0 {
            first_line(&gh.1)
        } else {
            "未找到 gh.exe".to_string()
        },
        action: "需要克隆私有 GitHub 仓库时再安装 gh 并登录",
    });
    items.push(EnvironmentItem {
        id: "codex",
        label: "Codex 执行器",
        status: if config.codex.is_some() {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Warn
        },
        detail: config
            .codex
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "未找到 codex.exe；native 执行器仍可用".to_string()),
        action: "安装 Codex CLI，或在 HEARTH_CODEX_PATH 指向 codex.exe",
    });
    items.push(EnvironmentItem {
        id: "npm",
        label: "npm（托管安装）",
        status: if npm.0 {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Warn
        },
        detail: if npm.0 {
            first_line(&npm.1)
        } else {
            "未找到 npm；托管安装会被禁用".to_string()
        },
        action: "安装 Node.js/npm 后可启用托管安装",
    });
    items.push(EnvironmentItem {
        id: "helper",
        label: "桌面助手",
        status: if helper.exists() {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Warn
        },
        detail: if helper.exists() {
            helper.display().to_string()
        } else {
            "桌面助手未打包；桌面设备配对暂不可用".to_string()
        },
        action: "使用安装包自带助手，或从托盘菜单重新安装",
    });
    items.push(EnvironmentItem {
        id: "port",
        label: "服务端口 4317",
        status: if reachable {
            EnvironmentStatus::Ok
        } else {
            EnvironmentStatus::Warn
        },
        detail: if reachable {
            format!("Hearth 服务正在 127.0.0.1:{} 监听", config.port)
        } else {
            format!("本地服务暂不可用（{model_detail}）")
        },
        action: "关闭占用端口的程序，或退出已有的 Hearth 实例",
    });

    let missing = items
        .iter()
        .filter(|item| item.status == EnvironmentStatus::Missing)
        .count();
    let warnings = items
        .iter()
        .filter(|item| item.status == EnvironmentStatus::Warn)
        .count();
    EnvironmentReport {
        items,
        missing,
        warnings,
    }
}

fn format_environment_report(report: &EnvironmentReport) -> String {
    report
        .items
        .iter()
        .map(|item| {
            let marker = match item.status {
                EnvironmentStatus::Ok => "✓",
                EnvironmentStatus::Warn => "!",
                EnvironmentStatus::Missing => "✗",
            };
            if item.status == EnvironmentStatus::Ok {
                format!("{marker} {}\n  {}", item.label, item.detail)
            } else {
                format!(
                    "{marker} {}\n  {}\n  → {}",
                    item.label, item.detail, item.action
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn environment_summary(report: &EnvironmentReport) -> String {
    if report.missing == 0 && report.warnings == 0 {
        return "环境体检完成：全部就绪。".to_string();
    }
    let mut parts = Vec::new();
    if report.missing > 0 {
        parts.push(format!("{} 项缺失", report.missing));
    }
    if report.warnings > 0 {
        parts.push(format!("{} 项提醒", report.warnings));
    }
    format!("环境体检完成：{}。", parts.join("，"))
}

fn show_environment(config: &ServerConfig) {
    let report = check_environment(config);
    let message = format!(
        "{}\n\n{}",
        environment_summary(&report),
        format_environment_report(&report)
    );
    message_box("Hearth 环境体检", &message, MB_OK | MB_ICONWARNING);
}

fn maybe_show_environment_intro(config: &ServerConfig) {
    if env::var("HEARTH_ENV_SKIP_INTRO").ok().as_deref() == Some("1") {
        return;
    }
    let marker = hearth_home().join("environment-intro-shown");
    if marker.exists() {
        return;
    }
    let report = check_environment(config);
    let model_missing = report
        .items
        .iter()
        .find(|item| item.id == "model")
        .map(|item| item.status == EnvironmentStatus::Missing)
        .unwrap_or(false);
    if model_missing {
        message_box(
            "Hearth 还差一步",
            "还没有配置聊天模型。\n\n应用已经可用，但聊天需要先在界面里填写模型 API Key。你现在也可以先浏览任务和设置。",
            MB_OK | MB_ICONWARNING,
        );
    }
    let _ = fs::create_dir_all(hearth_home());
    let _ = fs::write(&marker, iso_now());
}

fn navigation_allowed(url: &tauri::Url) -> bool {
    let scheme = url.scheme();
    if scheme == "tauri" || scheme == "about" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    if host.eq_ignore_ascii_case("tauri.localhost") {
        return true;
    }
    (host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost"))
        && url.port() == Some(PORT)
}

fn build_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Hearth")
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .visible(true)
        .on_navigation(|url| {
            if navigation_allowed(url) {
                return true;
            }
            if url.scheme() == "http" || url.scheme() == "https" {
                open_external(url.as_str());
            }
            false
        })
        .on_new_window(|url, _features| {
            if url.scheme() == "http" || url.scheme() == "https" {
                open_external(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .build()
        .map_err(|error| format!("无法创建主窗口: {error}"))
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Hearth", true, None::<&str>)?;
    let environment = MenuItem::with_id(app, "environment", "环境体检", true, None::<&str>)?;
    let helper = MenuItem::with_id(app, "helper", "桌面助手", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "数据目录", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "日志目录", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let first = PredefinedMenuItem::separator(app)?;
    let second = PredefinedMenuItem::separator(app)?;
    let third = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open, &first, &environment, &helper, &second, &data, &logs, &third, &quit,
        ],
    )?;

    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Hearth")
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "open" => show_main(app),
        "environment" => {
            let config = app.state::<Supervisor>().config.clone();
            thread::spawn(move || show_environment(&config));
        }
        "helper" => {
            let helper = app
                .state::<Supervisor>()
                .config
                .resources
                .join("helper")
                .join("helper.cmd");
            if let Err(message) = open_helper(&helper) {
                message_box("无法启动桌面助手", &message, MB_OK | MB_ICONWARNING);
            }
        }
        "data" => {
            let root = app.state::<Supervisor>().config.root.clone();
            open_directory(&root);
        }
        "logs" => {
            let dir = app.state::<Supervisor>().logs.dir.clone();
            open_directory(&dir);
        }
        "quit" => {
            if let Some(state) = app.try_state::<Supervisor>() {
                state.stop();
            }
            app.exit(0);
        }
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } = event
        {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let logs = Arc::new(create_desktop_logs());
    logs.main.write("desktop shell starting");

    let Some(root) = choose_data_root() else {
        logs.main.write("data root selection cancelled");
        app.handle().exit(0);
        return Ok(());
    };
    logs.main.write(&format!("data root={}", root.display()));

    let server = resolve_server(app.handle()).ok_or_else(|| {
        let message = format!(
            "找不到 server.mjs。请先运行 npm run tauri:build，或设置 HEARTH_SERVER_ENTRY。仓库根：{}",
            repo_root().display()
        );
        logs.main.write(&message);
        message_box("Hearth 启动失败", &message, MB_OK | MB_ICONWARNING);
        message
    })?;
    let web = resolve_web(app.handle()).ok_or_else(|| {
        let message = "找不到 web 静态资源。请先运行 npm run tauri:build。".to_string();
        logs.main.write(&message);
        message_box("Hearth 启动失败", &message, MB_OK | MB_ICONWARNING);
        message
    })?;
    let node = resolve_node(app.handle()).ok_or_else(|| {
        let message = "找不到内置 node.exe。请先运行 npm run tauri:build。".to_string();
        logs.main.write(&message);
        message_box("Hearth 启动失败", &message, MB_OK | MB_ICONWARNING);
        message
    })?;
    let resources = resolve_resources_root(app.handle()).unwrap_or_else(|| {
        node.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    });

    let config = Arc::new(ServerConfig {
        root: root.clone(),
        data_dir: data_dir_for(&root),
        server: server.clone(),
        web,
        node,
        resources,
        codex: resolve_codex(),
        port: PORT,
    });
    logs.main.write(&format!(
        "server={} node={} codex={}",
        server.display(),
        config.node.display(),
        config
            .codex
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "none".to_string())
    ));

    let window = build_window(app.handle())?;
    let supervisor = Supervisor::new(config, logs.clone());
    app.manage(supervisor.clone());
    create_tray(app.handle())?;
    logs.main.write("tray created");

    if let Some(milliseconds) = env::var("HEARTH_DESKTOP_AUTO_QUIT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
    {
        logs.main
            .write(&format!("auto quit scheduled in {milliseconds}ms"));
        let handle = app.handle().clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(milliseconds));
            if let Some(state) = handle.try_state::<Supervisor>() {
                state.stop();
            }
            handle.exit(0);
        });
    }

    let handle = app.handle().clone();
    let startup = supervisor.clone();
    thread::spawn(move || {
        if let Err(message) = startup.start() {
            startup.logs.main.write(&message);
            message_box("Hearth 启动失败", &message, MB_OK | MB_ICONWARNING);
            let script = format!(
                "window.hearthSplash?.fail({});",
                serde_json::to_string(&message).unwrap_or_else(|_| "\"启动失败\"".to_string())
            );
            let _ = window.eval(&script);
            handle.exit(0);
            return;
        }
        let url = format!("http://127.0.0.1:{}", startup.config.port);
        let script = format!(
            "window.location.replace({});",
            serde_json::to_string(&url).unwrap_or_default()
        );
        if let Err(error) = window.eval(&script) {
            startup.logs.main.write(&format!("navigate failed: {error}"));
        }
        let _ = window.show();
        let _ = window.set_focus();
        maybe_show_environment_intro(&startup.config);
    });

    Ok(())
}

#[tauri::command]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    #[cfg(feature = "updater")]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .invoke_handler(tauri::generate_handler![pick_folder])
        .setup(|app| setup_app(app))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Hearth");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<Supervisor>() {
                state.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(
        label: &'static str,
        status: EnvironmentStatus,
        detail: &'static str,
        action: &'static str,
    ) -> EnvironmentItem {
        EnvironmentItem {
            id: label,
            label,
            status,
            detail: detail.to_string(),
            action,
        }
    }

    #[test]
    fn civil_dates_match_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_776), (2026, 11, 19));
    }

    #[test]
    fn navigation_only_allows_hearth_origins() {
        assert!(navigation_allowed(
            &tauri::Url::parse("http://127.0.0.1:4317/index.html").unwrap()
        ));
        assert!(navigation_allowed(
            &tauri::Url::parse("http://localhost:4317/").unwrap()
        ));
        assert!(navigation_allowed(
            &tauri::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(navigation_allowed(
            &tauri::Url::parse("about:blank").unwrap()
        ));
        assert!(!navigation_allowed(
            &tauri::Url::parse("http://127.0.0.1:4318/").unwrap()
        ));
        assert!(!navigation_allowed(
            &tauri::Url::parse("https://example.com/").unwrap()
        ));
    }

    #[test]
    fn restart_backoff_is_capped_at_five_attempts() {
        assert_eq!(restart_delay(0), Some(1_000));
        assert_eq!(restart_delay(1), Some(2_000));
        assert_eq!(restart_delay(2), Some(5_000));
        assert_eq!(restart_delay(3), Some(10_000));
        assert_eq!(restart_delay(4), Some(30_000));
        assert_eq!(restart_delay(5), None);
    }

    #[test]
    fn environment_report_formats_status_and_summary() {
        let report = EnvironmentReport {
            items: vec![
                item("聊天模型", EnvironmentStatus::Ok, "已配置", ""),
                item("git", EnvironmentStatus::Missing, "未找到", "安装 Git"),
            ],
            missing: 1,
            warnings: 0,
        };
        let text = format_environment_report(&report);
        assert!(text.contains("✓ 聊天模型"));
        assert!(text.contains("✗ git"));
        assert!(text.contains("→ 安装 Git"));
        assert_eq!(environment_summary(&report), "环境体检完成：1 项缺失。");
    }

    #[test]
    fn chunked_body_is_decoded() {
        let body = decode_chunked(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n");
        assert_eq!(body, b"Wikipedia");
    }
}
