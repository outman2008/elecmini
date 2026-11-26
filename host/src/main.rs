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

use std::collections::HashMap;
use std::io::{self, BufRead};
use std::sync::{Arc, Mutex};

mod notification;
mod s4;
mod tray_host;
mod util;
mod webview_host;

use base64::Engine;
use serde_json::{json, Value};
use tao::{
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy},
    window::{Fullscreen, WindowBuilder},
};
use util::*;
use wry::http::Request as HttpRequest;
use wry::{PageLoadEvent, WebView};

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
                Ok(l) if !l.trim().is_empty() => match serde_json::from_str::<Value>(l.trim()) {
                    Ok(v) => {
                        let _ = proxy_stdin.send_event(HostMsg::Command(v));
                    }
                    Err(e) => eprintln!("[HOST] bad JSON from node: {} | {}", e, l.trim()),
                },
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[HOST] stdin read error: {}", e);
                    break;
                }
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
    let mut tray_mgr = tray_host::TrayManager::new(); // P6-H 系统托盘
    let mut guest_views = webview_host::WebViewHost::new(); // P6-J 多 WebView <webview>

    event_loop.run(move |event, elwt, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                eprintln!("[HOST] event loop init, boot={:?}", boot_start.elapsed());
                emit(&out, &json!({ "event": "host:ready", "engine": "wry/tao", "bootMs": boot_start.elapsed().as_millis() }));
                // Notification.isSupported()：能力探测结果广播给 shim（autotest 下视为不支持，避免弹系统窗）
                let notif_ok = std::env::var("ELECMINI_AUTOTEST").is_err() && notification::is_supported();
                emit(&out, &json!({ "event": "notification:supported", "supported": notif_ok }));
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
                            let mime = params.get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream").to_string();
                            let def = if kind == "file" || kind == "stream" {
                                // stream 走文件流式映射：baseDir 为根目录
                                ProtocolDef::File {
                                    base_dir: params.get("baseDir").and_then(Value::as_str).unwrap_or("").to_string(),
                                }
                            } else if kind == "buffer" {
                                // buffer：routes 值为 base64 字符串，解码为二进制
                                let mut routes = HashMap::new();
                                if let Some(map) = params.get("routes").and_then(Value::as_object) {
                                    for (k, v) in map {
                                        if let Some(s) = v.as_str() {
                                            let bytes = base64::engine::general_purpose::STANDARD
                                                .decode(s).unwrap_or_else(|_| s.as_bytes().to_vec());
                                            routes.insert(k.clone(), bytes);
                                        }
                                    }
                                }
                                ProtocolDef::Buffer { routes, mime }
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
                        // P2-E 扩展：富文本（text/html）剪贴板
                        "shell:writeClipboardHTML" => {
                            let html = params.get("html").and_then(Value::as_str).unwrap_or("");
                            use std::io::Write as _;
                            if let Ok(mut child) = std::process::Command::new("xclip")
                                .args(["-selection", "clipboard", "-t", "text/html"])
                                .stdin(std::process::Stdio::piped())
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null())
                                .spawn()
                            {
                                if let Some(stdin) = child.stdin.as_mut() { let _ = stdin.write_all(html.as_bytes()); }
                                drop(child.stdin.take());
                            }
                            clipboard_html_store().lock().unwrap().clone_from(&html.to_string());
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "shell:readClipboardHTML" => {
                            let sys = run_tool("timeout", &["1", "xclip", "-selection", "clipboard", "-o", "-t", "text/html"], None).unwrap_or_default();
                            let html = if sys.trim().is_empty() {
                                clipboard_html_store().lock().unwrap().clone()
                            } else { sys };
                            if !notify { respond(&out, id, json!({ "html": html })); }
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

                        // ===== P6-G：Notification（跨平台系统通知）=====
                        "notification:show" => {
                            let id_notif = params.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let title = params.get("title").and_then(Value::as_str).unwrap_or("");
                            let body = params.get("body").and_then(Value::as_str).unwrap_or("");
                            let subtitle = params.get("subtitle").and_then(Value::as_str).unwrap_or("");
                            let silent = params.get("silent").and_then(Value::as_bool).unwrap_or(false);
                            let autotest = std::env::var("ELECMINI_AUTOTEST").is_ok();
                            let ok = if autotest {
                                // CI 不弹系统窗，仅回推事件供断言
                                true
                            } else {
                                notification::show(title, body, subtitle, silent).is_ok()
                            };
                            // 回推 show 事件（Electron：通知显示时触发）
                            emit(&out, &json!({ "event": "notification:show", "id": id_notif }));
                            if !notify { respond(&out, id, json!({ "ok": ok })); }
                        }
                        "notification:close" => {
                            let id_notif = params.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            emit(&out, &json!({ "event": "notification:close", "id": id_notif }));
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "notification:isSupported" => {
                            let supported = std::env::var("ELECMINI_AUTOTEST").is_err() && notification::is_supported();
                            if !notify { respond(&out, id, json!({ "supported": supported })); }
                        }

                        // ===== P6-H：Tray（tray-icon + muda 真实实现，无头环境明确降级）=====
                        "tray:create" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let autotest = std::env::var("ELECMINI_AUTOTEST").is_ok();
                            let supported = !autotest && tray_host::TrayManager::is_supported();
                            let result = if supported {
                                // Electron Tray 构造只收 nativeImage；tooltip 由 setToolTip 设置。
                                // 构造阶段如带了 image(dataURL)，直接落地为图标，避免默认灰块。
                                let image = params.get("image").and_then(Value::as_str);
                                tray_mgr.create(&tray_id, None)
                                    .and_then(|_| tray_mgr.set_image(&tray_id, image))
                                    .map(|_| json!({ "ok": true }))
                                    .unwrap_or_else(|e| json!({ "ok": false, "reason": e, "method": method }))
                            } else {
                                json!({ "ok": false, "reason": "Tray 在无头/autotest 环境不可用（P2 降级）", "method": method })
                            };
                            if !notify { respond(&out, id, result); }
                        }
                        "tray:setImage" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("");
                            let image = params.get("image").and_then(Value::as_str);
                            let _ = tray_mgr.set_image(tray_id, image);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "tray:setTitle" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("");
                            let title = params.get("title").and_then(Value::as_str).unwrap_or("");
                            tray_mgr.set_title(tray_id, title);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "tray:setTooltip" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("");
                            let tip = params.get("tooltip").and_then(Value::as_str).unwrap_or("");
                            tray_mgr.set_tooltip(tray_id, tip);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "tray:setContextMenu" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("");
                            let items = params.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
                            let result = tray_mgr.set_context_menu(tray_id, &items)
                                .map(|_| json!({ "ok": true }))
                                .unwrap_or_else(|e| json!({ "ok": false, "reason": e }));
                            if !notify { respond(&out, id, result); }
                        }
                        "tray:popup" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("");
                            tray_mgr.popup(tray_id);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "tray:destroy" => {
                            let tray_id = params.get("id").and_then(Value::as_str).unwrap_or("");
                            tray_mgr.destroy(tray_id);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
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
                            let result = webviews.get(&win_id).ok_or_else(|| "目标窗口不存在".to_string())
                                .and_then(s4::open_devtools);
                            if !notify {
                                respond(&out, id, match result {
                                    Ok(()) => json!({ "ok": true }),
                                    Err(e) => json!({ "ok": false, "reason": e }),
                                });
                            }
                        }
                        "web:closeDevTools" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let result = webviews.get(&win_id).ok_or_else(|| "目标窗口不存在".to_string())
                                .and_then(s4::close_devtools);
                            if !notify {
                                respond(&out, id, match result {
                                    Ok(()) => json!({ "ok": true }),
                                    Err(e) => json!({ "ok": false, "reason": e }),
                                });
                            }
                        }
                        "web:isDevToolsOpen" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let open = webviews.get(&win_id).map(s4::is_devtools_open).unwrap_or(false);
                            if !notify { respond(&out, id, json!({ "open": open })); }
                        }

                        // ===== P6-J：多 WebView（Electron <webview> 契约）=====
                        "webview:create" => {
                            let guest_id = params.get("guestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let url = params.get("url").and_then(Value::as_str).unwrap_or("about:blank").to_string();
                            let x = params.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
                            let y = params.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
                            let w = params.get("width").and_then(Value::as_u64).unwrap_or(800) as u32;
                            let h = params.get("height").and_then(Value::as_u64).unwrap_or(600) as u32;
                            let result = windows.get(&win_id).ok_or_else(|| "父窗口不存在".to_string())
                                .and_then(|win| guest_views.create(guest_id, win_id, win, &url, x, y, w, h, out.clone()));
                            if !notify {
                                respond(&out, id, match result {
                                    Ok(()) => json!({ "ok": true }),
                                    Err(e) => json!({ "ok": false, "reason": e }),
                                });
                            }
                        }
                        "webview:loadURL" => {
                            let guest_id = params.get("guestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let url = params.get("url").and_then(Value::as_str).unwrap_or("");
                            let result = guest_views.load_url(guest_id, url);
                            if !notify {
                                respond(&out, id, match result {
                                    Ok(()) => json!({ "ok": true }),
                                    Err(e) => json!({ "ok": false, "reason": e }),
                                });
                            }
                        }
                        "webview:getURL" => {
                            let guest_id = params.get("guestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            if !notify { respond(&out, id, json!({ "url": guest_views.get_url(guest_id) })); }
                        }
                        "webview:setBounds" => {
                            let guest_id = params.get("guestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let x = params.get("x").and_then(Value::as_i64).unwrap_or(0) as i32;
                            let y = params.get("y").and_then(Value::as_i64).unwrap_or(0) as i32;
                            let w = params.get("width").and_then(Value::as_u64).unwrap_or(800) as u32;
                            let h = params.get("height").and_then(Value::as_u64).unwrap_or(600) as u32;
                            let _ = guest_views.set_bounds(guest_id, x, y, w, h);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "webview:executeJavaScript" => {
                            let guest_id = params.get("guestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let code = params.get("code").and_then(Value::as_str).unwrap_or("");
                            let result = guest_views.execute_javascript(guest_id, code);
                            if !notify {
                                respond(&out, id, match result {
                                    Ok(()) => json!({ "ok": true }),
                                    Err(e) => json!({ "ok": false, "reason": e }),
                                });
                            }
                        }
                        "webview:destroy" => {
                            let guest_id = params.get("guestId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            guest_views.destroy(guest_id);
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "session:clearCache" => {
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        // P6-B：setProxy 真实记录配置；resolveProxy 按 proxyRules 回显代理串。
                        // 注：wry 需 build 期 with_proxy_config，运行中改代理对已建 WebView 不即时生效，
                        // 后续 window:create 读取此配置注入（记录为语义降级点）。
                        "session:setProxy" => {
                            let config = params.get("config").cloned().unwrap_or(json!({}));
                            *proxy_store().lock().unwrap() = Some(config.clone());
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }
                        "session:resolveProxy" => {
                            let url = params.get("url").and_then(Value::as_str).unwrap_or("");
                            let proxy = proxy_store().lock().unwrap().clone();
                            let resolved = proxy.as_ref()
                                .and_then(|c| c.get("proxyRules").or_else(|| c.get("proxy")))
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                                .map(|s| s.to_string())
                                .unwrap_or_else(|| "DIRECT".to_string());
                            let _ = url;
                            if !notify { respond(&out, id, json!({ "proxy": resolved })); }
                        }

                        // P6-B：拼写检查词表（真实进程内持久化）
                        "session:spellcheck:add" | "session:spellcheck:remove" | "session:spellcheck:list" => {
                            let mut words = spellcheck_store().lock().unwrap();
                            let result = if method.ends_with(":add") {
                                let w = params.get("word").and_then(Value::as_str).unwrap_or("");
                                if !w.is_empty() && !words.iter().any(|x| x == w) { words.push(w.to_string()); }
                                json!({ "ok": true })
                            } else if method.ends_with(":remove") {
                                let w = params.get("word").and_then(Value::as_str).unwrap_or("");
                                words.retain(|x| x != w);
                                json!({ "ok": true })
                            } else {
                                json!({ "words": words.clone() })
                            };
                            if !notify { respond(&out, id, result); }
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
                            // SECURITY：每窗口记录「信任锚 origin」与「当前页面 origin」。
                            //   - 锚：首个外部导航的 origin（之后同 origin 视为受信）
                            //   - 当前：每次导航更新，IPC 校验时判断当前页面是否受信
                            let nav_anchor: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
                            let nav_current: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
                            let anchor_nav = nav_anchor.clone();
                            let anchor_ipc = nav_anchor.clone();
                            let current_nav = nav_current.clone();
                            let current_ipc = nav_current.clone();
                            let strict_nav = strict_nav_enabled();
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
                            // SECURITY：导航 origin 锚定。更新当前 origin；严格模式下阻断外跳。
                            builder = builder.with_navigation_handler(move |url: String| {
                                let origin = url_origin(&url);
                                if let Some(o) = origin.as_ref() {
                                    *current_nav.lock().unwrap() = o.clone();
                                }
                                let mut anchor = anchor_nav.lock().unwrap();
                                let allowed = match origin.as_ref() {
                                    None => false,
                                    Some(o) if is_trusted_origin(o) => true, // 本地/内部/特殊：放行且不锚定
                                    Some(o) => match anchor.as_ref() {
                                        Some(a) if a == o => true,          // 与锚定同 origin
                                        None => { *anchor = Some(o.clone()); true } // 首次外部导航：锚定
                                        _ => false,                          // 其他外部 origin：不可信
                                    },
                                };
                                if !allowed {
                                    eprintln!("[SECURITY] navigation blocked (untrusted origin): {} (anchor={:?})", url, *anchor);
                                }
                                // 非严格模式不阻断导航（避免破坏 SPA），但 current 已更新，
                                // 后续该页面的 IPC 会被 ipc handler 丢弃。
                                if strict_nav { allowed } else { true }
                            });
                            let webview = builder
                                .with_ipc_handler(move |req: wry::http::Request<String>| {
                                    // SECURITY：仅受信页面（本地/内部/特殊或与锚定同 origin）可调 IPC。
                                    let cur = current_ipc.lock().unwrap().clone();
                                    let trusted = cur.is_empty()
                                        || is_trusted_origin(&cur)
                                        || anchor_ipc.lock().unwrap().as_deref() == Some(cur.as_str());
                                    if !trusted {
                                        eprintln!("[SECURITY] dropped IPC from untrusted origin: {}", cur);
                                        return;
                                    }
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
                            // P6-A：窗口句柄在 move 进 map 前取出
                            let native_handle = native_handle_of(&window).unwrap_or(0);
                            webviews.insert(win_id, webview);
                            windows.insert(win_id, window);

                            // 回推真实 bounds（同步 API 状态镜像来源）
                            emit(&out, &json!({
                                "event": "window:event", "winId": win_id,
                                "type": "bounds", "payload": { "bounds": real_bounds }
                            }));
                            // P6-A：回推原生窗口句柄 → getNativeWindowHandle 镜像
                            emit(&out, &json!({
                                "event": "window:event", "winId": win_id,
                                "type": "nativeHandle", "payload": { "handle": native_handle }
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

                        // P6-A：全屏系列——tao 原生 set_fullscreen/fullscreen，真实能力
                        "window:setFullScreen" | "window:setKiosk" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let flag = params.get("flag").and_then(Value::as_bool).unwrap_or(false);
                            if let Some(w) = windows.get(&win_id) {
                                let mode = if flag { Some(Fullscreen::Borderless(None)) } else { None };
                                w.set_fullscreen(mode);
                            }
                            if !notify { respond(&out, id, json!({ "ok": true, "fullScreen": flag })); }
                        }

                        "window:setFullScreenable" => {
                            // tao 无 fullScreenable 开关：镜像记忆，fullscreen 请求时据此允许/拒绝由 JS 决定
                            if !notify { respond(&out, id, json!({ "ok": true })); }
                        }

                        // P6-A：capturePage — 用系统截图工具按原生窗口句柄截取，回传 dataURL
                        "window:capturePage" => {
                            let win_id = params.get("winId").and_then(Value::as_u64).unwrap_or(0) as u32;
                            let data_url = capture_window(&windows, &webviews, win_id);
                            if !notify { respond(&out, id, json!({ "ok": true, "dataUrl": data_url })); }
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
                            // Electron 语义：executeJavaScript 返回表达式求值结果（Promise）。
                            // 用 evaluate_script_with_callback 拿到序列化后的 JSON 结果；
                            // 回调是异步的，故 out/id 需 clone 进闭包后异步 respond。
                            let replied = match webviews.get(&win_id) {
                                Some(wv) if !notify => {
                                    let cb_out = out.clone();
                                    let cb_id = id.clone();
                                    match wv.evaluate_script_with_callback(code, move |raw: String| {
                                        let value = serde_json::from_str::<Value>(&raw)
                                            .unwrap_or(Value::String(raw));
                                        // 闭包为 Fn（非 FnOnce），id 需 clone 后交给 respond
                                        respond(&cb_out, cb_id.clone(), json!({ "ok": true, "value": value }));
                                    }) {
                                        Ok(()) => true, // 回调将异步回包
                                        Err(e) => {
                                            respond(&out, id.clone(), json!({ "ok": false, "error": e.to_string() }));
                                            true
                                        }
                                    }
                                }
                                Some(wv) => { let _ = wv.evaluate_script(code); true }
                                None => false,
                            };
                            if !replied { respond(&out, id, json!({ "ok": false, "error": "window not found" })); }
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
                // P6-H：把托盘点击/菜单事件从全局 channel 抽出并回推 renderer
                tray_mgr.drain_events(&out);
                if quitting { *control_flow = ControlFlow::Exit; }
            }

            _ => {}
        }
    });
}
