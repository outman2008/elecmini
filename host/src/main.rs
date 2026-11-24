//! ElecMini P1 — Native host（window server）
//!
//! 从 P0 spike 升级为真正的 B2 宿主：
//!   - stdin（JSONL）：接收 Node sidecar 的命令（window:create/loadUrl/close、app:quit、
//!     ipc:reply、web:send 等），经 EventLoopProxy 投递到 tao 主线程执行
//!   - stdout（JSONL）：event（host:ready / window:event / ipc:invoke / ipc:send）+ response
//!   - WebView ipc_handler：renderer 经 window.ipc.postMessage 发消息 → proxy → 主线程
//!     → stdout 事件 → Node ipcMain → ipc:reply 命令 → evaluate_script 回 renderer
//!
//! 所有 stdout 写入经全局 Mutex 保证 JSONL 行原子性；stderr 用于诊断日志。

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, Mutex};

mod s4;

use serde_json::{json, Value};
use wry::http::{Request as HttpRequest, Response as HttpResponse};
use tao::{
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
use wry::{PageLoadEvent, WebView};

/// 主线程消息：Node 命令 / renderer IPC
enum HostMsg {
    Command(Value),
    RendererIpc { win_id: u32, body: String },
}

/// 全局 stdout 写锁（JSONL 行原子写入）
type Out = Arc<Mutex<io::Stdout>>;

/// P2-E：剪贴板内存镜像（无头环境兜底，真实 X11 以系统剪贴板为准）
fn clipboard_store() -> &'static Mutex<String> {
    static CLIP: std::sync::OnceLock<Mutex<String>> = std::sync::OnceLock::new();
    CLIP.get_or_init(|| Mutex::new(String::new()))
}

fn emit(out: &Out, msg: &Value) {
    let mut o = out.lock().unwrap();
    let _ = writeln!(o, "{}", msg);
    let _ = o.flush();
}

fn respond(out: &Out, id: Value, result: Value) {
    emit(out, &json!({ "id": id, "ok": true, "result": result }));
}

fn respond_err(out: &Out, id: Value, err: String) {
    emit(out, &json!({ "id": id, "ok": false, "error": err }));
}

fn bounds_of(window: &tao::window::Window) -> Value {
    let size = window.inner_size();
    let pos = window.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
    json!({ "x": pos.0, "y": pos.1, "width": size.width, "height": size.height })
}

/// P2-A：从 tao 读真实显示器信息（screen shim 数据源）
fn displays_json(
    elwt: &tao::event_loop::EventLoopWindowTarget<HostMsg>,
) -> Value {
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
fn theme_json() -> Value {
    #[cfg(target_os = "linux")]
    let dark = {
        let color_scheme = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "color-scheme"])
            .output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().trim_matches('\'').to_string())
            .unwrap_or_default();
        let gtk_theme = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
            .output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().trim_matches('\'').to_string())
            .unwrap_or_default();
        color_scheme.contains("dark") || gtk_theme.to_lowercase().contains("dark")
            || std::env::var("GTK_THEME").map(|v| v.to_lowercase().contains("dark")).unwrap_or(false)
    };
    #[cfg(target_os = "macos")]
    let dark = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("Dark"))
        .unwrap_or(false);
    #[cfg(target_os = "windows")]
    let dark = std::process::Command::new("reg")
        .args(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"])
        .output().ok()
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
#[derive(Clone)]
enum ProtocolDef {
    String { routes: HashMap<String, String> },
    File { base_dir: String },
}

/// 构造 wry 自定义协议响应（http 200 + 内容类型推断）
fn protocol_response(def: &ProtocolDef, uri_path: &str) -> HttpResponse<Cow<'static, [u8]>> {
    let (bytes, mime) = match def {
        ProtocolDef::String { routes } => {
            let key = uri_path.trim_start_matches('/');
            let body = routes.get(key)
                .or_else(|| routes.get(uri_path))
                .cloned()
                .unwrap_or_default();
            (body.into_bytes(), "text/plain; charset=utf-8".to_string())
        }
        ProtocolDef::File { base_dir } => {
            let rel = uri_path.trim_start_matches('/');
            let rel = if rel.is_empty() { "index.html" } else { rel };
            let full = std::path::Path::new(base_dir).join(rel);
            match std::fs::read(&full) {
                Ok(b) => {
                    let ext = full.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    let mime = match ext.as_str() {
                        "html" | "htm" => "text/html; charset=utf-8",
                        "js" | "mjs" => "application/javascript; charset=utf-8",
                        "css" => "text/css; charset=utf-8",
                        "json" => "application/json; charset=utf-8",
                        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
                        "svg" => "image/svg+xml", "ico" => "image/x-icon",
                        _ => "application/octet-stream",
                    }.to_string();
                    (b, mime)
                }
                Err(_) => (b"Not Found".to_vec(), "text/plain; charset=utf-8".to_string()),
            }
        }
    };
    HttpResponse::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| HttpResponse::builder().status(500).body(Cow::Owned(Vec::new())).unwrap())
}

/// 从请求 URI 提取 path（形如 app://local/index.html → /index.html）
fn request_path(uri: &str) -> String {
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
fn storage_key() -> String {
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
fn encrypt_text(plain: &str) -> Result<String, String> {
    use std::io::Write as _;
    let key = storage_key();
    let mut child = std::process::Command::new("openssl")
        .args(["enc", "-aes-256-cbc", "-pbkdf2", "-base64", "-A", "-pass", &format!("pass:{}", key), "-salt"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().map_err(|e| format!("openssl spawn: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(plain.as_bytes()); }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn decrypt_text(data: &str) -> Result<String, String> {
    use std::io::Write as _;
    let key = storage_key();
    let mut child = std::process::Command::new("openssl")
        .args(["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-base64", "-A", "-pass", &format!("pass:{}", key), "-salt"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn().map_err(|e| format!("openssl spawn: {}", e))?;
    if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(data.as_bytes()); }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// P2-E：执行系统工具并取 stdout（stdin 可选输入）
fn run_tool(program: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
    use std::io::Write as _;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if input.is_some() { cmd.stdin(std::process::Stdio::piped()); }
    let mut child = cmd.spawn().map_err(|e| format!("{} spawn: {}", program, e))?;
    if let (Some(inp), Some(stdin)) = (input, child.stdin.as_mut()) { let _ = stdin.write_all(inp.as_bytes()); }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() && program != "zenity" { // zenity 取消时退出码非 0，交给上层解析
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn main() {
    let boot_start = std::time::Instant::now();
    let out: Out = Arc::new(Mutex::new(io::stdout()));

    // ---- 门禁（P1：Linux L0/L3；测试注入 ELECMINI_GATE=block → L3） ----
    if std::env::var("ELECMINI_GATE").unwrap_or_default() == "block" {
        eprintln!("[ELECMINI:L3] 系统 WebView 版本过低，拒绝启动（不白屏）。");
        std::process::exit(3);
    }

    let event_loop: EventLoop<HostMsg> = EventLoopBuilder::<HostMsg>::with_user_event().build();
    let proxy: EventLoopProxy<HostMsg> = event_loop.create_proxy();

    // ---- stdin 读线程：Node 命令 → proxy ----
    let proxy_stdin = proxy.clone();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    match serde_json::from_str::<Value>(l.trim()) {
                        Ok(v) => { let _ = proxy_stdin.send_event(HostMsg::Command(v)); }
                        Err(e) => eprintln!("[HOST] bad JSON from node: {} | {}", e, l.trim()),
                    }
                }
                Ok(_) => {}
                Err(e) => { eprintln!("[HOST] stdin read error: {}", e); break; }
            }
        }
        eprintln!("[HOST] stdin closed (node exited)");
    });

    // ---- 主线程状态 ----
    let mut webviews: HashMap<u32, WebView> = HashMap::new();
    let mut windows: HashMap<u32, tao::window::Window> = HashMap::new();
    let mut init_script: String = String::new();
    let mut quitting = false;
    let mut protocols: HashMap<String, ProtocolDef> = HashMap::new(); // P2-B
    let s4state: Arc<Mutex<s4::S4State>> = Arc::new(Mutex::new(s4::S4State::default())); // S4

    event_loop.run(move |event, elwt, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                eprintln!("[HOST] event loop init, boot={:?}", boot_start.elapsed());
                emit(&out, &json!({ "event": "host:ready", "engine": "wry/tao", "bootMs": boot_start.elapsed().as_millis() }));
            }

            // ---- Node 命令 ----
            Event::UserEvent(msg) => match msg {
                HostMsg::Command(v) => {
                    let id = v.get("id").cloned().unwrap_or(json!(null));
                    let method = v.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                    let params = v.get("params").cloned().unwrap_or(json!({}));
                    let notify = v.get("notify").and_then(Value::as_bool).unwrap_or(false);

                    match method.as_str() {
                        "host:initScript" => {
                            init_script = params.get("script").and_then(Value::as_str).unwrap_or("").to_string();
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        // P2-A：真实显示器 + 系统主题探测
                        "sys:displays" => {
                            let d = displays_json(elwt);
                            if !notify { respond(&out, id, d); }
                        }
                        "sys:theme" => {
                            let t = theme_json();
                            // 主题变化需推送（nativeTheme.on('updated')），这里返回当前值由 JS 缓存
                            if !notify { respond(&out, id, t); }
                        }

                        // P2-B：注册自定义协议（app:// 等）
                        "protocol:register" => {
                            let scheme = params.get("scheme").and_then(Value::as_str).unwrap_or("").to_string();
                            let kind = params.get("kind").and_then(Value::as_str).unwrap_or("string");
                            let def = if kind == "file" {
                                ProtocolDef::File {
                                    base_dir: params.get("baseDir").and_then(Value::as_str).unwrap_or("").to_string(),
                                }
                            } else {
                                let mut routes = HashMap::new();
                                if let Some(map) = params.get("routes").and_then(Value::as_object) {
                                    for (k, v) in map {
                                        if let Some(s) = v.as_str() { routes.insert(k.clone(), s.to_string()); }
                                    }
                                }
                                ProtocolDef::String { routes }
                            };
                            protocols.insert(scheme.clone(), def);
                            if !notify { respond(&out, id, json!({ "ok": true, "scheme": scheme })); }
                        }

                        // ===== P2-C：safeStorage 真实加密 =====
                        "safeStorage:isAvailable" => {
                            let ok = std::process::Command::new("openssl").arg("version").output().is_ok();
                            if !notify { respond(&out, id, json!({ "available": ok })); }
                        }
                        "safeStorage:encrypt" => {
                            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
                            let r = match encrypt_text(text) {
                                Ok(data) => json!({ "ok": true, "data": data }),
                                Err(e) => json!({ "ok": false, "error": e }),
                            };
                            if !notify { respond(&out, id, r); }
                        }
                        "safeStorage:decrypt" => {
                            let data = params.get("data").and_then(Value::as_str).unwrap_or("");
                            let r = match decrypt_text(data) {
                                Ok(text) => json!({ "ok": true, "text": text }),
                                Err(e) => json!({ "ok": false, "error": e }),
                            };
                            if !notify { respond(&out, id, r); }
                        }

                        // ===== P2-E：clipboard（xclip）/ dialog（zenity） =====
                        "shell:writeClipboard" => {
                            let text = params.get("text").and_then(Value::as_str).unwrap_or("");
                            // xclip 写入会 fork 后台进程常驻提供 selection；stdout/stderr 重定向 null，
                            // spawn 后写入 stdin 立即返回（不 wait，避免等 pipe EOF 卡死）。
                            use std::io::Write as _;
                            if let Ok(mut child) = std::process::Command::new("xclip")
                                .args(["-selection", "clipboard"])
                                .stdin(std::process::Stdio::piped())
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null())
                                .spawn()
                            {
                                if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(text.as_bytes()); }
                                drop(child.stdin.take()); // 关闭 pipe 触发 xclip 读取完成
                            }
                            // host 内存镜像：无头/无 owner 时 read 立即可得
                            clipboard_store().lock().unwrap().clone_from(&text.to_string());
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "shell:readClipboard" => {
                            // 优先读系统剪贴板（超时保护），失败/空则回退内存镜像
                            let sys = run_tool("timeout", &["1", "xclip", "-selection", "clipboard", "-o"], None).unwrap_or_default();
                            let text = if sys.trim().is_empty() {
                                clipboard_store().lock().unwrap().clone()
                            } else { sys };
                            if !notify { respond(&out, id, json!({ "text": text })); }
                        }
                        "dialog:showOpen" | "dialog:showSave" => {
                            let opts = params.get("options").cloned().unwrap_or(json!({}));
                            let title = opts.get("title").and_then(Value::as_str).unwrap_or("选择文件");
                            let multi = opts.get("properties").and_then(Value::as_array)
                                .map(|a| a.iter().any(|v| v.as_str() == Some("multiSelections"))).unwrap_or(false);
                            let is_save = method == "dialog:showSave";
                            // 自动测试：不弹真实对话框，返回由 ELECMINI_TEST_FILE 注入的确定性结果
                            let autotest = std::env::var("ELECMINI_AUTOTEST").is_ok();
                            let r = if autotest {
                                std::env::var("ELECMINI_TEST_FILE").unwrap_or_default()
                            } else {
                                let mut args = vec!["--file-selection"];
                                if is_save { args.push("--save"); }
                                if multi { args.push("--multiple"); }
                                args.push("--title"); args.push(title);
                                run_tool("zenity", &args, None).unwrap_or_default()
                            };
                            let paths: Vec<&str> = r.lines().filter(|l| !l.trim().is_empty()).collect();
                            let result = if is_save {
                                json!({ "canceled": paths.is_empty(), "filePath": paths.first().copied() })
                            } else {
                                json!({ "canceled": paths.is_empty(), "filePaths": paths })
                            };
                            if !notify { respond(&out, id, result); }
                        }
                        "dialog:showMessageBox" => {
                            let autotest = std::env::var("ELECMINI_AUTOTEST").is_ok();
                            if !autotest {
                                let opts = params.get("options").cloned().unwrap_or(json!({}));
                                let msg = opts.get("message").and_then(Value::as_str).unwrap_or("");
                                let kind = opts.get("type").and_then(Value::as_str).unwrap_or("info");
                                let flag = match kind { "error" => "--error", "warning" => "--warning", "question" => "--question", _ => "--info" };
                                let _ = run_tool("zenity", &[flag, "--text", msg, "--title", "ElecMini"], None);
                            }
                            if !notify { respond(&out, id, json!({ "response": 0 })); }
                        }
                        "dialog:showError" => {
                            if std::env::var("ELECMINI_AUTOTEST").is_err() {
                                let title = params.get("title").and_then(Value::as_str).unwrap_or("错误");
                                let content = params.get("content").and_then(Value::as_str).unwrap_or("");
                                let _ = run_tool("zenity", &["--error", "--text", content, "--title", title], None);
                            }
                            if !notify { respond(&out, id, json!({})); }
                        }

                        // ===== P2-D：Tray / globalShortcut（平台能力探测，无头环境明确降级）=====
                        "tray:create" | "tray:setImage" | "tray:setTitle" | "tray:setTooltip"
                        | "tray:setContextMenu" | "tray:popup" | "tray:destroy" => {
                            // tao 0.34 无内置 TrayIcon；tray-icon crate 需 GTK app indicator，
                            // 无头 Xvfb 下不可用 → 返回明确降级原因（不静默失败）
                            let ok = false;
                            if !notify {
                                respond(&out, id, json!({ "ok": ok, "reason": "Tray 需 tray-icon/GTK appindicator，当前平台不可用（P2 降级）", "method": method }));
                            }
                        }
                        "globalShortcut:register" | "globalShortcut:unregister" | "globalShortcut:unregisterAll" => {
                            // global-hotkey crate 未引入（编译成本 + Xvfb 无全局热键）→ 明确降级
                            if !notify {
                                respond(&out, id, json!({ "ok": false, "reason": "globalShortcut 需 global-hotkey crate，当前构建未启用（P2 降级）" }));
                            }
                        }

                        // ===== P2-F：powerMonitor / systemPreferences / session =====
                        "powerMonitor:getIdleTime" => {
                            // X11 用 xset q 解析 idle 秒数，简化为 0（无头无真实空闲事件）
                            if !notify { respond(&out, id, json!({ "seconds": 0 })); }
                        }
                        "powerMonitor:onBattery" => {
                            let on_battery = std::fs::read_to_string("/sys/class/power_supply/BAT0/status")
                                .map(|s| s.trim() == "Discharging").unwrap_or(false);
                            if !notify { respond(&out, id, json!({ "onBattery": on_battery })); }
                        }
                        "systemPreferences:getUserDefault" => {
                            if !notify { respond(&out, id, json!({ "value": null })); }
                        }
                        "systemPreferences:setUserDefault" => {
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        // ===== S4：Windows WebView2 专属能力 =====
                        "s4:capabilities" => {
                            if !notify { respond(&out, id, s4::capabilities()); }
                        }
                        "webRequest:subscribe" => {
                            // Windows 注册 WebResourceRequested 规则；其他平台明确降级
                            let r = s4::subscribe_request(&s4state, &params);
                            if !notify { respond(&out, id, r); }
                        }
                        "webRequest:decision" => { /* best-effort, no response */ }
                        "cdp:sendCommand" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let cmd_id = params.get("id").cloned().unwrap_or(json!(null));
                            let method = params.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                            let cmd_params = params.get("params").cloned().unwrap_or(json!({}));
                            let accepted = webviews.get(&win_id).and_then(|w| {
                                s4::cdp_send(w, out.clone(), cmd_id.clone(), method.clone(), cmd_params.clone()).ok()
                            }).is_some();
                            if !accepted {
                                emit(&out, &json!({
                                    "event": "cdp:result", "id": cmd_id, "ok": false,
                                    "error": "CDP 不可用：目标窗口不存在或平台不支持（S4 仅 Windows WebView2）"
                                }));
                            }
                            if !notify { respond(&out, id, json!({ "accepted": accepted })); }
                        }
                        "cdp:subscribe" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let event_name = params.get("eventName").and_then(Value::as_str).unwrap_or("").to_string();
                            let ok = webviews.get(&win_id).and_then(|w| {
                                s4::cdp_subscribe(w, out.clone(), &s4state, win_id, event_name.clone()).ok()
                            }).is_some();
                            if !notify { respond(&out, id, json!({ "ok": ok, "eventName": event_name })); }
                        }
                        "web:openDevTools" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let ok = webviews.get(&win_id).and_then(|w| s4::open_devtools(w).ok()).is_some();
                            if !notify { respond(&out, id, json!({ "ok": ok })); }
                        }
                        "web:closeDevTools" => {
                            // WebView2 无独立关闭 API；DevTools 窗口由用户关闭
                            if !notify { respond(&out, id, json!({ "ok": false, "reason": "WebView2 DevTools 需用户手动关闭" })); }
                        }
                        "session:clearCache" | "session:setProxy" | "session:resolveProxy" => {
                            if !notify { respond(&out, id, json!({ "ok": true, "proxy": "DIRECT" })); }
                        }

                        "window:create" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let width = params.get("width").and_then(Value::as_u64).unwrap_or(900) as u32;
                            let height = params.get("height").and_then(Value::as_u64).unwrap_or(640) as u32;
                            let title = params.get("title").and_then(Value::as_str).unwrap_or("ElecMini");

                            let window = WindowBuilder::new()
                                .with_title(title)
                                .with_inner_size(tao::dpi::LogicalSize::new(width, height))
                                .build(elwt)
                                .expect("failed to build window");
                            let real_bounds = bounds_of(&window);

                            let p = proxy.clone();
                            let out_page = out.clone();
                            let mut builder = wry::WebViewBuilder::new();
                            if !init_script.is_empty() {
                                builder = builder.with_initialization_script(init_script.clone());
                            }
                            // 默认 HTML：目标应用 loadUrl 会替换；先给空白页避免闪烁
                            builder = builder.with_html("<!doctype html><html><body></body></html>");
                            // P2-B：应用已注册的自定义协议（JS protocol.register* 下发）
                            for (scheme, def) in &protocols {
                                let d = def.clone();
                                let s = scheme.clone();
                                builder = builder.with_custom_protocol(s, move |_id: wry::WebViewId, req: HttpRequest<Vec<u8>>| {
                                    protocol_response(&d, &request_path(&req.uri().to_string()))
                                });
                            }
                            let webview = builder
                                .with_ipc_handler(move |req: wry::http::Request<String>| {
                                    let _ = p.send_event(HostMsg::RendererIpc {
                                        win_id,
                                        body: req.body().clone(),
                                    });
                                })
                                .with_on_page_load_handler(move |evt: PageLoadEvent, url: String| {
                                    if matches!(evt, PageLoadEvent::Finished) {
                                        emit(&out_page, &json!({
                                            "event": "web:did-finish-load", "winId": win_id,
                                            "payload": { "url": url }
                                        }));
                                    }
                                })
                                .build(&window)
                                .expect("failed to build webview");

                            // S4：在首次导航前安装 WebView2 请求拦截钩子（Windows 生效）
                            if let Err(e) = s4::install_request_hook(&webview, out.clone(), s4state.clone(), win_id) {
                                eprintln!("[S4] WebResourceRequested 未安装：{}", e);
                            }
                            webviews.insert(win_id, webview);
                            windows.insert(win_id, window);

                            // 回推真实 bounds（同步 API 状态镜像来源）
                            emit(&out, &json!({
                                "event": "window:event", "winId": win_id,
                                "type": "bounds", "payload": { "bounds": real_bounds }
                            }));
                            emit(&out, &json!({
                                "event": "window:event", "winId": win_id,
                                "type": "ready-to-show", "payload": {}
                            }));
                            if !notify { respond(&out, id, real_bounds); }
                        }

                        "window:loadUrl" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let url = params.get("url").and_then(Value::as_str).unwrap_or("").to_string();
                            let ok = webviews.get(&win_id).and_then(|w| w.load_url(&url).ok()).is_some();
                            if let Some(w) = windows.get(&win_id) {
                                emit(&out, &json!({
                                    "event": "window:event", "winId": win_id,
                                    "type": "url", "payload": { "url": url.clone() }
                                }));
                                let _ = w; // 保持借用清晰
                            }
                            if !notify { respond(&out, id, json!({ "loaded": ok, "url": url })); }
                        }

                        "window:setTitle" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let title = params.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                            if let Some(w) = windows.get(&win_id) {
                                w.set_title(&title);
                                emit(&out, &json!({
                                    "event": "window:event", "winId": win_id,
                                    "type": "title", "payload": { "title": title.clone() }
                                }));
                            }
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        "window:setSize" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let w = params.get("width").and_then(Value::as_u64).unwrap_or(900) as u32;
                            let h = params.get("height").and_then(Value::as_u64).unwrap_or(640) as u32;
                            if let Some(win) = windows.get(&win_id) {
                                // set_inner_size 后不立即读 bounds（WM 尚未完成 resize，会读到旧值）；
                                // 真实尺寸由 WindowEvent::Resized 回推。
                                win.set_inner_size(tao::dpi::LogicalSize::new(w, h));
                            }
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        "window:show" | "window:focus" | "window:hide" | "window:maximize" | "window:minimize" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            if let Some(w) = windows.get(&win_id) {
                                match method.as_str() {
                                    "window:show" => w.set_visible(true),
                                    "window:focus" => w.set_focus(),
                                    "window:hide" => w.set_visible(false),
                                    "window:maximize" => w.set_maximized(true),
                                    "window:minimize" => w.set_minimized(true),
                                    _ => {}
                                }
                            }
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        "window:close" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            // tao 无同步 close()：隐藏窗口并主动发 close 事件；无窗口时退出
                            if let Some(w) = windows.get(&win_id) {
                                w.set_visible(false);
                                windows.remove(&win_id);
                                webviews.remove(&win_id);
                                emit(&out, &json!({
                                    "event": "window:event", "winId": win_id,
                                    "type": "close", "payload": {}
                                }));
                                if windows.is_empty() { *control_flow = ControlFlow::Exit; }
                            }
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        "window:ensure" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let exists = webviews.contains_key(&win_id);
                            if !notify { respond(&out, id, json!({ "exists": exists })); }
                        }

                        // ipcMain 处理结果回传 → renderer
                        "ipc:reply" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let msg_id = params.get("msgId").and_then(Value::as_str).unwrap_or("");
                            let ok = params.get("ok").and_then(Value::as_bool).unwrap_or(false);
                            let result = params.get("result").cloned().unwrap_or(json!(null));
                            let script = format!(
                                "window.__elecminiIpcReply({}, {}, {});",
                                serde_json::to_string(msg_id).unwrap_or_else(|_| "\"\"".into()),
                                ok,
                                serde_json::to_string(&result).unwrap_or_else(|_| "null".into())
                            );
                            if let Some(wv) = webviews.get(&win_id) { let _ = wv.evaluate_script(&script); }
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        // webContents.send → renderer 事件推送
                        "web:send" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let channel = params.get("channel").and_then(Value::as_str).unwrap_or("");
                            let payload = params.get("payload").cloned().unwrap_or(json!(null));
                            let script = format!(
                                "window.__elecminiIpcPush({}, {});",
                                serde_json::to_string(channel).unwrap_or_else(|_| "\"\"".into()),
                                serde_json::to_string(&payload).unwrap_or_else(|_| "null".into())
                            );
                            if let Some(wv) = webviews.get(&win_id) { let _ = wv.evaluate_script(&script); }
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        "web:executeJavaScript" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let code = params.get("code").and_then(Value::as_str).unwrap_or("");
                            // WebKitGTK 上 evaluate_script 无返回值，executeJavaScript 降级为执行并返回 ok
                            if let Some(wv) = webviews.get(&win_id) { let _ = wv.evaluate_script(code); }
                            if !notify { respond(&out, id, json!({ "ok": true, "value": null })); }
                        }

                        "shell:openExternal" | "shell:openPath" | "shell:showItem" => {
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "menu:setApplicationMenu" => {
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        "app:quit" => {
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                            quitting = true;
                            *control_flow = ControlFlow::Exit;
                        }

                        _ => {
                            eprintln!("[HOST] unknown method: {}", method);
                            if !notify { respond_err(&out, id, format!("unknown method '{}'", method)); }
                        }
                    }
                }

                // ---- renderer IPC → Node ----
                HostMsg::RendererIpc { win_id, body } => {
                    match serde_json::from_str::<Value>(&body) {
                        Ok(msg) => {
                            let kind = msg.get("kind").and_then(Value::as_str).unwrap_or("");
                            let channel = msg.get("channel").and_then(Value::as_str).unwrap_or("").to_string();
                            let payload = msg.get("payload").cloned().unwrap_or(json!(null));
                            match kind {
                                "invoke" => {
                                    let msg_id = msg.get("msgId").and_then(Value::as_str).unwrap_or("").to_string();
                                    emit(&out, &json!({
                                        "event": "ipc:invoke", "winId": win_id,
                                        "msgId": msg_id, "channel": channel, "payload": payload
                                    }));
                                }
                                "send" => {
                                    emit(&out, &json!({
                                        "event": "ipc:send", "winId": win_id,
                                        "channel": channel, "payload": payload
                                    }));
                                }
                                _ => eprintln!("[HOST] unknown ipc kind: {}", kind),
                            }
                        }
                        Err(e) => eprintln!("[HOST] bad renderer ipc: {} | {}", e, body),
                    }
                }
            },

            // ---- tao 窗口事件 → Node ----
            Event::WindowEvent { event, window_id, .. } => {
                // 用 window_id 反查 winId（tao WindowId 无部分序，遍历比较）
                let win_id = windows.iter()
                    .find(|(_, w)| w.id() == window_id)
                    .map(|(id, _)| *id);
                if let Some(win_id) = win_id {
                    match event {
                        WindowEvent::CloseRequested => {
                            emit(&out, &json!({
                                "event": "window:event", "winId": win_id,
                                "type": "close", "payload": {}
                            }));
                            windows.remove(&win_id);
                            webviews.remove(&win_id);
                            if windows.is_empty() {
                                *control_flow = ControlFlow::Exit;
                            }
                        }
                        WindowEvent::Resized(size) => {
                            if let Some(w) = windows.get(&win_id) {
                                let mut b = bounds_of(w);
                                b["width"] = json!(size.width);
                                b["height"] = json!(size.height);
                                emit(&out, &json!({
                                    "event": "window:event", "winId": win_id,
                                    "type": "resize", "payload": { "bounds": b }
                                }));
                            }
                        }
                        WindowEvent::Focused(f) => {
                            emit(&out, &json!({
                                "event": "window:event", "winId": win_id,
                                "type": if f { "focus" } else { "blur" }, "payload": {}
                            }));
                        }
                        _ => {}
                    }
                }
            }

            Event::MainEventsCleared => {
                if quitting { *control_flow = ControlFlow::Exit; }
            }

            _ => {}
        }
    });
}
