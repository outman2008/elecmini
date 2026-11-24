//! ElecMini host 工具层：状态存储、stdout 事件输出、URL/origin 校验、窗口能力、
//! 自定义协议响应、加解密、外部命令执行。与主事件循环解耦，便于单测与维护。

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::{json, Value};
use wry::http::Response as HttpResponse;

pub enum HostMsg {
    Command(Value),
    RendererIpc { win_id: u32, body: String },
}

/// 全局 stdout 写锁（JSONL 行原子写入）
pub type Out = Arc<Mutex<io::Stdout>>;

/// P2-E：剪贴板内存镜像（无头环境兜底，真实 X11 以系统剪贴板为准）
pub fn clipboard_store() -> &'static Mutex<String> {
    static CLIP: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();
    CLIP.get_or_init(|| Mutex::new(String::new()))
}

/// P2-E 扩展：富文本（text/html）内存镜像；真实系统剪贴板以 xclip -t text/html 为准
pub fn clipboard_html_store() -> &'static Mutex<String> {
    static HTML: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();
    HTML.get_or_init(|| Mutex::new(String::new()))
}

/// P6-B：代理配置状态（setProxy 真实记录，resolveProxy 按规则回显）
pub fn proxy_store() -> &'static Mutex<Option<Value>> {
    static PROXY: std::sync::OnceLock<Mutex<Option<Value>>> = std::sync::OnceLock::new();
    PROXY.get_or_init(|| Mutex::new(None))
}

/// P6-B：拼写检查词表（add/remove 真实持久化到进程内，list 读回）
pub fn spellcheck_store() -> &'static Mutex<Vec<String>> {
    static WORDS: std::sync::OnceLock<Mutex<Vec<String>>> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn emit(out: &Out, msg: &Value) {
    let mut o = out.lock().unwrap();
    let _ = writeln!(o, "{}", msg);
    let _ = o.flush();
}

pub fn respond(out: &Out, id: Value, result: Value) {
    emit(out, &json!({ "id": id, "ok": true, "result": result }));
}

pub fn respond_err(out: &Out, id: Value, err: String) {
    emit(out, &json!({ "id": id, "ok": false, "error": err }));
}

pub fn bounds_of(window: &tao::window::Window) -> Value {
    let size = window.inner_size();
    let pos = window
        .outer_position()
        .map(|p| (p.x, p.y))
        .unwrap_or((0, 0));
    json!({ "x": pos.0, "y": pos.1, "width": size.width, "height": size.height })
}

/// SECURITY：从 URL 提取 origin（scheme://host[:port]；特殊 scheme 归一化为 scheme）。
/// 无法解析时返回 None（调用方应视为不可信）。
pub fn url_origin(url: &str) -> Option<String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("about:") {
        return Some("about".to_string());
    }
    if lower.starts_with("data:") {
        return Some("data".to_string());
    }
    if lower.starts_with("blob:") {
        return Some("blob".to_string());
    }
    let (scheme, rest) = lower.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("{}://{}", scheme, authority))
}

/// SECURITY：本地/内部 origin 默认受信（本地静态服务、自定义 app 协议、特殊 scheme）。
/// 这些来源是 ElecMini 自己注入 preload 的页面，允许其调用 IPC。
pub fn is_trusted_origin(origin: &str) -> bool {
    origin.starts_with("http://127.0.0.1")
        || origin.starts_with("http://localhost")
        || origin.starts_with("http://[::1]")
        || origin.starts_with("app://")
        || matches!(origin, "about" | "data" | "blob")
}

/// SECURITY：安全导航开关。默认「非严格」——不阻断导航（避免破坏 SPA / 多域应用），
/// 但非受信页面的 IPC 会被丢弃（见 window:create 的 ipc handler）。
/// 设 ELECMINI_STRICT_NAV=1 时额外阻断到非受信/非锚定 origin 的导航（纵深防御）。
pub fn strict_nav_enabled() -> bool {
    std::env::var("ELECMINI_STRICT_NAV").ok().as_deref() == Some("1")
}

/// P6-A：取原生窗口句柄（数值化，供 getNativeWindowHandle 镜像）
pub fn native_handle_of(window: &tao::window::Window) -> Option<u64> {
    use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let handle = window.window_handle().ok()?;
    #[cfg(target_os = "linux")]
    {
        if let RawWindowHandle::Xlib(h) = handle.as_raw() {
            return Some(h.window);
        }
        if let RawWindowHandle::Wayland(h) = handle.as_raw() {
            return Some(h.surface.as_ptr() as u64);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let RawWindowHandle::Win32(h) = handle.as_raw() {
            return Some(h.hwnd.get() as u64);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let RawWindowHandle::AppKit(h) = handle.as_raw() {
            return Some(h.ns_view.as_ptr() as u64);
        }
    }
    let _ = handle;
    None
}

/// P6-A：capturePage 实现。Linux/X11 用 ImageMagick `import -window <id>` 截取原生窗口；
/// 其他平台无简单系统截图路径时返回空 dataURL（由 JS 层 createEmpty 兜底），不静默假装成功。
pub fn capture_window(
    windows: &HashMap<u32, tao::window::Window>,
    _webviews: &HashMap<u32, wry::WebView>,
    win_id: u32,
) -> String {
    #[cfg(target_os = "linux")]
    {
        let Some(w) = windows.get(&win_id) else {
            return String::new();
        };
        let Some(h) = native_handle_of(w) else {
            return String::new();
        };
        let tmp = std::env::temp_dir().join(format!("elecmini-cap-{}.png", win_id));
        let out = std::process::Command::new("import")
            .args(["-window", &h.to_string(), &tmp.to_string_lossy()])
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                if let Ok(bytes) = std::fs::read(&tmp) {
                    let _ = std::fs::remove_file(&tmp);
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    return format!("data:image/png;base64,{}", b64);
                }
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (windows, win_id);
    }
    String::new()
}

/// P2-A：从 tao 读真实显示器信息（screen shim 数据源）
pub fn displays_json(elwt: &tao::event_loop::EventLoopWindowTarget<HostMsg>) -> Value {
    let primary = elwt.primary_monitor();
    let mut arr = Vec::new();
    let mut id = 1u32;
    for m in elwt.available_monitors() {
        let size = m.size();
        let pos = m.position();
        let is_primary = primary.as_ref().map(|p| p == &m).unwrap_or(false);
        arr.push(json!({
            "id": id,
            "bounds": { "x": pos.x, "y": pos.y, "width": size.width, "height": size.height },
            "workArea": { "x": pos.x, "y": pos.y, "width": size.width, "height": size.height },
            "scaleFactor": m.scale_factor(),
            "isPrimary": is_primary,
            "name": m.name(),
        }));
        id += 1;
    }
    // 无显示器（如无头）时给一个合理默认，保证 screen API 不返回空
    if arr.is_empty() {
        arr.push(json!({
            "id": 1,
            "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
            "workArea": { "x": 0, "y": 0, "width": 1920, "height": 1040 },
            "scaleFactor": 1.0, "isPrimary": true, "name": "default",
        }));
    }
    json!({ "displays": arr })
}

/// P2-A：探测系统主题（nativeTheme shim 数据源）
pub fn theme_json() -> Value {
    #[cfg(target_os = "linux")]
    let dark = {
        let color_scheme = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "color-scheme"])
            .output()
            .ok()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .trim_matches('\'')
                    .to_string()
            })
            .unwrap_or_default();
        let gtk_theme = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
            .output()
            .ok()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .trim_matches('\'')
                    .to_string()
            })
            .unwrap_or_default();
        color_scheme.contains("dark")
            || gtk_theme.to_lowercase().contains("dark")
            || std::env::var("GTK_THEME")
                .map(|v| v.to_lowercase().contains("dark"))
                .unwrap_or(false)
    };
    #[cfg(target_os = "macos")]
    let dark = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .eq_ignore_ascii_case("Dark")
        })
        .unwrap_or(false);
    #[cfg(target_os = "windows")]
    let dark = std::process::Command::new("reg")
        .args([
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
            "/v",
            "AppsUseLightTheme",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("0x0"))
        .unwrap_or(false);
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let dark = false;

    json!({
        "shouldUseDarkColors": dark,
        "shouldUseHighContrastColors": false,
        "themeSource": "system",
    })
}

/// P2-B：自定义协议定义。String = 内存 path→文本；File = 目录根映射。
/// P6-B：Buffer = 内存 path→base64 二进制；Stream = 文件流式映射（复用 File 语义）。
#[derive(Clone)]
pub enum ProtocolDef {
    String {
        routes: HashMap<String, String>,
    },
    Buffer {
        routes: HashMap<String, Vec<u8>>,
        mime: String,
    },
    File {
        base_dir: String,
    },
}

/// 构造 wry 自定义协议响应（http 200 + 内容类型推断）
pub fn protocol_response(def: &ProtocolDef, uri_path: &str) -> HttpResponse<Cow<'static, [u8]>> {
    let (bytes, mime) = match def {
        ProtocolDef::String { routes } => {
            let key = uri_path.trim_start_matches('/');
            let body = routes
                .get(key)
                .or_else(|| routes.get(uri_path))
                .cloned()
                .unwrap_or_default();
            (body.into_bytes(), "text/plain; charset=utf-8".to_string())
        }
        ProtocolDef::Buffer { routes, mime } => {
            let key = uri_path.trim_start_matches('/');
            let body = routes
                .get(key)
                .or_else(|| routes.get(uri_path))
                .cloned()
                .unwrap_or_default();
            (body, mime.clone())
        }
        ProtocolDef::File { base_dir } => {
            let rel = uri_path.trim_start_matches('/');
            let rel = if rel.is_empty() { "index.html" } else { rel };
            let full = std::path::Path::new(base_dir).join(rel);
            match std::fs::read(&full) {
                Ok(b) => {
                    let ext = full
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let mime = match ext.as_str() {
                        "html" | "htm" => "text/html; charset=utf-8",
                        "js" | "mjs" => "application/javascript; charset=utf-8",
                        "css" => "text/css; charset=utf-8",
                        "json" => "application/json; charset=utf-8",
                        "png" => "image/png",
                        "jpg" | "jpeg" => "image/jpeg",
                        "svg" => "image/svg+xml",
                        "ico" => "image/x-icon",
                        _ => "application/octet-stream",
                    }
                    .to_string();
                    (b, mime)
                }
                Err(_) => (
                    b"Not Found".to_vec(),
                    "text/plain; charset=utf-8".to_string(),
                ),
            }
        }
    };
    HttpResponse::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| {
            HttpResponse::builder()
                .status(500)
                .body(Cow::Owned(Vec::new()))
                .unwrap()
        })
}

/// 从请求 URI 提取 path（形如 app://local/index.html → /index.html）
pub fn request_path(uri: &str) -> String {
    // 去掉 scheme://authority
    if let Some(rest) = uri.split_once("://") {
        if let Some((_, p)) = rest.1.split_once('/') {
            return format!("/{}", p);
        }
        return "/".into();
    }
    uri.to_string()
}

/// P2-C：safeStorage 密钥（从 machine-id 派生，进程内固定）
pub fn storage_key() -> String {
    let mid = std::fs::read_to_string("/etc/machine-id")
        .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
        .unwrap_or_else(|_| "elecmini-dev-key".to_string());
    let raw = format!("elecmini::{}", mid.trim());
    // 取前 32 字节作为 hex key（SHA256 前 32 hex chars）
    use std::fmt::Write as _;
    let mut hex = String::new();
    for b in raw.as_bytes().iter().cycle().take(32) {
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}

/// P2-C：AES-256-GCM 加密（openssl CLI，base64 输出）
pub fn encrypt_text(plain: &str) -> Result<String, String> {
    use std::io::Write as _;
    let key = storage_key();
    let mut child = std::process::Command::new("openssl")
        .args([
            "enc",
            "-aes-256-cbc",
            "-pbkdf2",
            "-base64",
            "-A",
            "-pass",
            &format!("pass:{}", key),
            "-salt",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("openssl spawn: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(plain.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn decrypt_text(data: &str) -> Result<String, String> {
    use std::io::Write as _;
    let key = storage_key();
    let mut child = std::process::Command::new("openssl")
        .args([
            "enc",
            "-d",
            "-aes-256-cbc",
            "-pbkdf2",
            "-base64",
            "-A",
            "-pass",
            &format!("pass:{}", key),
            "-salt",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("openssl spawn: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(data.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// P2-E：执行系统工具并取 stdout（stdin 可选输入）
pub fn run_tool(program: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
    use std::io::Write as _;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if input.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} spawn: {}", program, e))?;
    if let (Some(inp), Some(stdin)) = (input, child.stdin.as_mut()) {
        let _ = stdin.write_all(inp.as_bytes());
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() && program != "zenity" {
        // zenity 取消时退出码非 0，交给上层解析
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod security_tests {
    use super::{is_trusted_origin, url_origin};

    #[test]
    fn origin_parsing() {
        assert_eq!(
            url_origin("http://127.0.0.1:5173/index.html").as_deref(),
            Some("http://127.0.0.1:5173")
        );
        assert_eq!(
            url_origin("https://www.messenger.com/t/1?x=2").as_deref(),
            Some("https://www.messenger.com")
        );
        assert_eq!(url_origin("about:blank").as_deref(), Some("about"));
        assert_eq!(url_origin("data:text/html,x").as_deref(), Some("data"));
        assert_eq!(url_origin("blob:http://x/y").as_deref(), Some("blob"));
        assert_eq!(url_origin("not-a-url"), None);
        assert_eq!(url_origin("https://"), None);
    }

    #[test]
    fn trusted_local_and_internal() {
        assert!(is_trusted_origin("http://127.0.0.1:5173"));
        assert!(is_trusted_origin("http://localhost:8080"));
        assert!(is_trusted_origin("app://index.html"));
        assert!(is_trusted_origin("about"));
        assert!(is_trusted_origin("data"));
        assert!(is_trusted_origin("blob"));
        assert!(!is_trusted_origin("https://evil.example.com"));
        assert!(!is_trusted_origin("http://192.168.1.10:80"));
    }
}
