//! S4 — 增强调试与请求能力（WebResourceRequested / CDP / DevTools）
//!
//! 能力按平台分层，绝不静默假装成功：
//!
//! | 能力 | Windows (WebView2) | macOS (WKWebView) | Linux (WebKitGTK) |
//! |---|---|---|---|
//! | WebResourceRequested 改请求头 | 原生 COM | 降级 | 降级 |
//! | CDP 命令/事件 | 原生 COM | 无 CDP 协议 | 无 CDP 协议 |
//! | DevTools 调试窗口 | OpenDevToolsWindow | wry 私有 API | WebKitWebInspector.show() |
//!
//! CDP 是 Chromium 私有协议，WebKit 生态（WKWebView/WebKitGTK）没有等价的 CDP 实现，
//! 它们使用 Web Inspector Protocol。调试窗口能力则由 wry 跨平台提供，三平台均可用。

use serde_json::{json, Value};
use std::io;
use std::sync::{Arc, Mutex};

/// 请求头注入规则：pattern 为 URL 子串（"*" 表示全部）
#[derive(Clone, Default)]
pub struct S4State {
    #[allow(dead_code)] // 跨平台条件编译：仅 Windows 分支读取
    pub rules: Vec<RequestRule>,
    #[allow(dead_code)]
    pub tokens: Vec<i64>,
}

#[derive(Clone)]
pub struct RequestRule {
    #[allow(dead_code)]
    pub pattern: String,
    #[allow(dead_code)]
    pub headers: Vec<(String, String)>,
}

#[allow(dead_code)] // 非 Windows 构建下未使用（Windows 分支 emit 事件）
fn emit(out: &Arc<Mutex<io::Stdout>>, msg: &Value) {
    let mut o = out.lock().unwrap();
    use std::io::Write;
    let _ = writeln!(o, "{}", msg);
    let _ = o.flush();
}

/// 读取真实 WebView2 版本（与 win_gate 使用相同的注册表键）
#[cfg(target_os = "windows")]
fn detect_webview2_version() -> Option<String> {
    use windows::{
        core::HSTRING,
        Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
            REG_VALUE_TYPE,
        },
    };
    const SUBKEY: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let subkey = HSTRING::from(SUBKEY);
    let value = HSTRING::from("pv");
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, &subkey, None, KEY_READ, &mut key) }.is_err() {
        return None;
    }
    let mut ty = REG_VALUE_TYPE(0);
    let mut len = 0u32;
    let rc = unsafe { RegQueryValueExW(key, &value, None, Some(&mut ty), None, Some(&mut len)) };
    if rc.is_err() || len == 0 || ty.0 != 1 {
        // REG_SZ
        let _ = unsafe { RegCloseKey(key) };
        return None;
    }
    let mut buf = vec![0u16; len as usize / 2 + 1];
    let rc = unsafe {
        RegQueryValueExW(
            key,
            &value,
            None,
            None,
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut len),
        )
    };
    let _ = unsafe { RegCloseKey(key) };
    if rc.is_err() {
        return None;
    }
    while buf.last() == Some(&0) {
        buf.pop();
    }
    Some(String::from_utf16_lossy(&buf))
}

/// 能力探测：JS 侧据此决定是否启用 CDP/DevTools UI
pub fn capabilities() -> Value {
    #[cfg(target_os = "windows")]
    {
        let version = detect_webview2_version().unwrap_or_else(|| "unknown".into());
        json!({
            "platform": "win32",
            "webResourceRequested": true,
            "cdp": true,
            "devtools": true,
            "webview2Version": version,
        })
    }
    #[cfg(all(target_os = "linux", not(target_os = "windows")))]
    {
        json!({
            "platform": "linux",
            "webResourceRequested": false,
            "cdp": false,
            "devtools": true,
            "devtoolsBackend": "webkit-web-inspector",
            "cdpAlternative": "WebKit Inspector Protocol（WEBKIT_INSPECTOR_SERVER 或右键 Inspect Element）",
        })
    }
    #[cfg(target_os = "macos")]
    {
        json!({
            "platform": "macos",
            "webResourceRequested": false,
            "cdp": false,
            "devtools": true,
            "devtoolsBackend": "wkwebview-private-api",
            "cdpAlternative": "Safari Web Inspector（Develop 菜单，需 isInspectable）",
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        json!({
            "platform": std::env::consts::OS,
            "webResourceRequested": false,
            "cdp": false,
            "devtools": false,
            "reason": "该平台无已知调试后端",
        })
    }
}

/// 订阅 webRequest 规则（在窗口创建前调用，供 WebResourceRequested 回调同步执行）
pub fn subscribe_request(state: &Arc<Mutex<S4State>>, params: &Value) -> Value {
    let pattern = params
        .get("pattern")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .get("urls")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str)
        })
        .unwrap_or("*")
        .to_string();
    let mut headers = Vec::new();
    if let Some(map) = params.get("headers").and_then(Value::as_object) {
        for (k, v) in map {
            headers.push((k.clone(), v.as_str().unwrap_or("").to_string()));
        }
    }
    #[cfg(target_os = "windows")]
    {
        state
            .lock()
            .unwrap()
            .rules
            .push(RequestRule { pattern, headers });
        json!({ "ok": true, "supported": true, "engine": "WebResourceRequested" })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, pattern, headers);
        json!({ "ok": true, "supported": false, "reason": "当前平台无 WebResourceRequested，走自定义协议拦截" })
    }
}

#[cfg(target_os = "windows")]
fn core_webview(
    webview: &wry::WebView,
) -> Result<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, String> {
    use wry::WebViewExtWindows;
    let controller = webview.controller();
    unsafe { controller.CoreWebView2().map_err(|e| e.to_string()) }
}

/// 在 WebView 创建后安装请求拦截钩子。必须在页面导航前调用。
#[cfg(target_os = "windows")]
pub fn install_request_hook(
    webview: &wry::WebView,
    out: Arc<Mutex<io::Stdout>>,
    state: Arc<Mutex<S4State>>,
    win_id: u32,
) -> Result<(), String> {
    use webview2_com::{
        take_pwstr, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        WebResourceRequestedEventHandler,
    };
    use windows::core::{HSTRING, PWSTR};

    let wv = core_webview(webview)?;
    let filter = HSTRING::from("*");
    unsafe { wv.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL) }
        .map_err(|e| format!("AddWebResourceRequestedFilter: {e}"))?;

    let state_for_hook = state.clone();
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let req = unsafe { args.Request()? };

        let mut uri_pw = PWSTR::null();
        unsafe { req.Uri(&mut uri_pw)? };
        let uri = take_pwstr(uri_pw);
        let mut method_pw = PWSTR::null();
        let method = if unsafe { req.Method(&mut method_pw) }.is_ok() {
            take_pwstr(method_pw)
        } else {
            String::new()
        };

        let matched: Vec<_> = state_for_hook
            .lock()
            .unwrap()
            .rules
            .iter()
            .filter(|r| r.pattern == "*" || uri.contains(&r.pattern))
            .flat_map(|r| r.headers.clone())
            .collect();
        if !matched.is_empty() {
            let headers = unsafe { req.Headers()? };
            for (name, value) in &matched {
                let name_h = HSTRING::from(name.as_str());
                let value_h = HSTRING::from(value.as_str());
                unsafe {
                    headers.SetHeader(
                        windows::core::PCWSTR::from_raw(name_h.as_ptr()),
                        windows::core::PCWSTR::from_raw(value_h.as_ptr()),
                    )?;
                }
            }
        }
        emit(
            &out,
            &json!({
                "event": "webRequest:beforeRequest",
                "winId": win_id,
                "details": { "id": uri.clone(), "url": uri, "method": method, "injected": !matched.is_empty() },
            }),
        );
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { wv.add_WebResourceRequested(&handler, &mut token) }
        .map_err(|e| format!("add_WebResourceRequested: {e}"))?;
    state.lock().unwrap().tokens.push(token);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn install_request_hook(
    _webview: &wry::WebView,
    _out: Arc<Mutex<io::Stdout>>,
    _state: Arc<Mutex<S4State>>,
    _win_id: u32,
) -> Result<(), String> {
    Err("S4 WebResourceRequested 仅 Windows WebView2 可用".into())
}

/// 调用 CDP 方法（对应 webContents.debugger.sendCommand）
#[cfg(target_os = "windows")]
pub fn cdp_send(
    webview: &wry::WebView,
    out: Arc<Mutex<io::Stdout>>,
    id: Value,
    method: String,
    params: Value,
) -> Result<(), String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    #[allow(unused_imports)]
    use windows::core::Result as WinResult;
    use windows::core::{HSTRING, PCWSTR};

    let wv = core_webview(webview)?;
    let method_h = HSTRING::from(method);
    let params_h = HSTRING::from(params.to_string());
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |hr: WinResult<()>, result: String| {
            let ok = hr.is_ok();
            let text = result;
            let parsed = serde_json::from_str::<Value>(&text).unwrap_or(json!(null));
            emit(
                &out,
                &json!({
                    "event": "cdp:result",
                    "id": id,
                    "ok": ok,
                    "result": if ok { parsed } else { json!(null) },
                    "error": if ok { Value::Null } else { json!(text) },
                }),
            );
            Ok(())
        },
    ));
    unsafe {
        wv.CallDevToolsProtocolMethod(
            PCWSTR::from_raw(method_h.as_ptr()),
            PCWSTR::from_raw(params_h.as_ptr()),
            &handler,
        )
    }
    .map_err(|e| format!("CallDevToolsProtocolMethod: {e}"))
}

#[cfg(not(target_os = "windows"))]
pub fn cdp_send(
    _webview: &wry::WebView,
    _out: Arc<Mutex<io::Stdout>>,
    _id: Value,
    _method: String,
    _params: Value,
) -> Result<(), String> {
    Err("CDP 仅 Windows WebView2 可用".into())
}

/// 订阅 CDP 事件（如 Network.responseReceived / Runtime.consoleAPICalled）
#[cfg(target_os = "windows")]
pub fn cdp_subscribe(
    webview: &wry::WebView,
    out: Arc<Mutex<io::Stdout>>,
    state: &Arc<Mutex<S4State>>,
    win_id: u32,
    event_name: String,
) -> Result<(), String> {
    use webview2_com::{take_pwstr, DevToolsProtocolEventReceivedEventHandler};
    use windows::core::{HSTRING, PWSTR};

    let wv = core_webview(webview)?;
    let receiver =
        unsafe { wv.GetDevToolsProtocolEventReceiver(&HSTRING::from(event_name.clone())) }
            .map_err(|e| format!("GetDevToolsProtocolEventReceiver({event_name}): {e}"))?;
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let mut pw = PWSTR::null();
        unsafe { args.ParameterObjectAsJson(&mut pw)? };
        let params = serde_json::from_str::<Value>(&take_pwstr(pw)).unwrap_or(json!(null));
        emit(
            &out,
            &json!({
                "event": "cdp:event", "winId": win_id,
                "eventName": event_name, "params": params,
            }),
        );
        Ok(())
    }));
    let mut token = 0i64;
    unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }
        .map_err(|e| format!("add_DevToolsProtocolEventReceived: {e}"))?;
    state.lock().unwrap().tokens.push(token);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn cdp_subscribe(
    _webview: &wry::WebView,
    _out: Arc<Mutex<io::Stdout>>,
    _state: &Arc<Mutex<S4State>>,
    _win_id: u32,
    _event_name: String,
) -> Result<(), String> {
    Err("CDP 事件仅 Windows WebView2 可用".into())
}

/// 打开 DevTools —— 三平台均可用（后端不同）。
///
/// Windows 直接用 WebView2 COM；macOS/Linux 由 wry 封装的 Web Inspector 实现
/// （详见各平台 wry::WebView::open_devtools）。需启用 wry `devtools` feature 以覆盖 release 构建。
#[cfg(target_os = "windows")]
pub fn open_devtools(webview: &wry::WebView) -> Result<(), String> {
    let wv = core_webview(webview)?;
    unsafe { wv.OpenDevToolsWindow() }.map_err(|e| format!("OpenDevToolsWindow: {e}"))
}

#[cfg(not(target_os = "windows"))]
pub fn open_devtools(webview: &wry::WebView) -> Result<(), String> {
    webview.open_devtools();
    Ok(())
}

/// 关闭 DevTools。Windows WebView2 无独立关闭 API（由用户关闭窗口）。
#[cfg(target_os = "windows")]
pub fn close_devtools(_webview: &wry::WebView) -> Result<(), String> {
    Err("WebView2 DevTools 需用户手动关闭".into())
}

#[cfg(not(target_os = "windows"))]
pub fn close_devtools(webview: &wry::WebView) -> Result<(), String> {
    webview.close_devtools();
    Ok(())
}

/// 查询 DevTools 是否打开。Windows WebView2 无可靠状态 API，恒为 unknown。
#[cfg(target_os = "windows")]
pub fn is_devtools_open(_webview: &wry::WebView) -> bool {
    false
}

#[cfg(not(target_os = "windows"))]
pub fn is_devtools_open(webview: &wry::WebView) -> bool {
    webview.is_devtools_open()
}
