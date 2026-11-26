//! 多 WebView（Electron <webview> / webviewTag 契约），P6-J。
//!
//! wry 0.52 支持在同一 tao 窗口上 build_as_child 挂多个子 WebView，每个带独立
//! bounds（相对父窗口）。这对齐 Electron <webview> 的"独立渲染区域"，但语义有边界：
//!   - ✅ loadURL / did-navigate / dom-ready / did-fail-load / executeJavaScript 可对齐
//!   - ⚠️ 子视图是 OS 级句柄，不参与 DOM 布局：不跟随 DOM 滚动/CSS transform/z-index 交错
//!   - ❌ render-process-gone/crashed 无 wry 事件（标 degraded）
//!
//! 子 WebView 浮在主 WebView 之上的固定矩形，正对应 OpenChamber Preview 面板场景。

use std::collections::HashMap;

use serde_json::json;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder};

use crate::util::{emit, Out};

/// 子 WebView 管理器：guestId → WebView。
pub struct WebViewHost {
    views: HashMap<u32, WebView>,
    urls: HashMap<u32, String>,
}

impl WebViewHost {
    pub fn new() -> Self {
        Self {
            views: HashMap::new(),
            urls: HashMap::new(),
        }
    }

    /// 在父窗口上创建一个子 WebView（Electron document.createElement('webview') 的宿主侧）。
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &mut self,
        guest_id: u32,
        win_id: u32,
        window: &tao::window::Window,
        url: &str,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        out: Out,
    ) -> Result<(), String> {
        if self.views.contains_key(&guest_id) {
            return Ok(());
        }
        let o_nav = out.clone();
        let o_load = out.clone();
        let bounds = Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        };
        let mut builder = WebViewBuilder::new().with_bounds(bounds).with_url(url);
        // 事件回推：对齐 Electron webviewTag 的事件名
        builder = builder.with_navigation_handler(move |target: String| {
            emit(
                &o_nav,
                &json!({
                    "event": "webview:event", "winId": win_id, "guestId": guest_id,
                    "type": "did-navigate", "payload": { "url": target }
                }),
            );
            true // 不阻断 guest 导航（主 WebView 的 origin 锚定不适用于 guest）
        });
        builder = builder.with_on_page_load_handler(move |evt: PageLoadEvent, target: String| {
            // wry 仅暴露 Started/Finished；did-fail-load 无原生事件（契约标 degraded）
            let kind = match evt {
                PageLoadEvent::Started => "did-start-loading",
                PageLoadEvent::Finished => "dom-ready",
            };
            emit(
                &o_load,
                &json!({
                    "event": "webview:event", "winId": win_id, "guestId": guest_id,
                    "type": kind, "payload": { "url": target }
                }),
            );
        });
        let view = builder
            .build_as_child(window)
            .map_err(|e| format!("webview build_as_child: {}", e))?;
        self.urls.insert(guest_id, url.to_string());
        self.views.insert(guest_id, view);
        Ok(())
    }

    pub fn load_url(&mut self, guest_id: u32, url: &str) -> Result<(), String> {
        let v = self.views.get(&guest_id).ok_or("webview not found")?;
        v.load_url(url).map_err(|e| e.to_string())?;
        self.urls.insert(guest_id, url.to_string());
        Ok(())
    }

    pub fn get_url(&self, guest_id: u32) -> String {
        self.urls.get(&guest_id).cloned().unwrap_or_default()
    }

    pub fn set_bounds(
        &self,
        guest_id: u32,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let v = self.views.get(&guest_id).ok_or("webview not found")?;
        v.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .map_err(|e| e.to_string())
    }

    pub fn execute_javascript(&self, guest_id: u32, code: &str) -> Result<(), String> {
        let v = self.views.get(&guest_id).ok_or("webview not found")?;
        v.evaluate_script(code).map_err(|e| e.to_string())
    }

    pub fn destroy(&mut self, guest_id: u32) {
        self.views.remove(&guest_id);
        self.urls.remove(&guest_id);
    }
}
