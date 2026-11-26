//! 系统托盘后端（tray-icon + muda），P6-H。
//!
//! 与 tao 0.34 / wry 0.52 同代的 tray-icon 0.24.x，Linux 走 GTK appindicator，
//! 无头 Xvfb 下 build() 返回 Err，由调用方（main.rs）降级为 ok:false，不静默失败。
//!
//! 事件模型：tray-icon 用全局 channel 投递 Click / Menu 事件。宿主在事件循环的
//! MainEventsCleared 阶段调用 drain_events() 把事件转成 JSON 行写回 stdout，
//! 由 Node sidecar 分发到 shim 的 Tray EventEmitter。

use std::collections::HashMap;

use muda::{Menu, MenuItem};
use serde_json::json;
use tray_icon::{menu::ContextMenu, Icon, Rect, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::util::Out;

/// 托盘管理器：id → TrayIcon。菜单项 id → (trayId, commandId) 映射用于菜单事件回推。
pub struct TrayManager {
    icons: HashMap<String, TrayIcon>,
    menus: HashMap<String, Box<dyn ContextMenu>>,
    menu_owner: HashMap<String, (String, String)>, // menuItemId -> (trayId, commandId)
}

impl TrayManager {
    pub fn new() -> Self {
        Self {
            icons: HashMap::new(),
            menus: HashMap::new(),
            menu_owner: HashMap::new(),
        }
    }

    pub fn is_supported() -> bool {
        // Linux 无头/Xvfb 下 appindicator 不可用；这里只做粗判，真正建托盘时 build() 会 Err。
        #[cfg(target_os = "linux")]
        {
            std::env::var("DISPLAY").is_ok() || std::env::var("WAYLAND_DISPLAY").is_ok()
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }

    pub fn create(&mut self, id: &str, title: Option<&str>) -> Result<(), String> {
        if self.icons.contains_key(id) {
            return Ok(());
        }
        let mut builder = TrayIconBuilder::new()
            .with_id(id.to_string())
            .with_tooltip(title.unwrap_or("ElecMini"));
        if let Some(t) = title {
            builder = builder.with_title(t);
        }
        let icon = default_icon().map_err(|e| format!("tray icon: {}", e))?;
        builder = builder.with_icon(icon);
        let tray = builder.build().map_err(|e| format!("tray build: {}", e))?;
        self.icons.insert(id.to_string(), tray);
        Ok(())
    }

    pub fn set_title(&mut self, id: &str, title: &str) {
        if let Some(t) = self.icons.get(id) {
            t.set_title(Some(title));
        }
    }

    pub fn set_tooltip(&mut self, id: &str, tip: &str) {
        if let Some(t) = self.icons.get(id) {
            let _ = t.set_tooltip(Some(tip));
        }
    }

    pub fn set_image(&mut self, id: &str, data_url: Option<&str>) -> Result<(), String> {
        let Some(tray) = self.icons.get(id) else {
            return Ok(());
        };
        if let Some(icon) = decode_icon(data_url)? {
            let _ = tray.set_icon(Some(icon));
        }
        Ok(())
    }

    pub fn set_context_menu(
        &mut self,
        id: &str,
        items: &[serde_json::Value],
    ) -> Result<(), String> {
        let menu = Menu::new();
        for item in items {
            let label = item.get("label").and_then(|v| v.as_str()).unwrap_or("");
            let command_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(label)
                .to_string();
            let enabled = item
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let item_id = format!("{}::{}", id, command_id);
            let mi = MenuItem::with_id(item_id.clone(), label, enabled, None);
            menu.append(&mi)
                .map_err(|e| format!("menu append: {}", e))?;
            self.menu_owner
                .insert(item_id, (id.to_string(), command_id));
        }
        if let Some(tray) = self.icons.get(id) {
            tray.set_menu(Some(Box::new(menu.clone())));
        }
        self.menus.insert(id.to_string(), Box::new(menu));
        Ok(())
    }

    pub fn popup(&mut self, id: &str) {
        // muda 的 context menu popup 需平台 handle；无头下静默跳过
        let _ = id;
    }

    pub fn destroy(&mut self, id: &str) {
        self.icons.remove(id);
        self.menus.remove(id);
        self.menu_owner.retain(|_, (owner, _)| owner != id);
    }

    /// 从 tray-icon 全局 channel 拉取事件，转成 JSON 行写 stdout。
    /// 在事件循环 MainEventsCleared 调用；无事件时立即返回。
    pub fn drain_events(&mut self, out: &Out) {
        // 菜单事件
        while let Ok(event) = muda::MenuEvent::receiver().try_recv() {
            let key = event.id.0.clone();
            if let Some((tray_id, command_id)) = self.menu_owner.get(&key) {
                let bounds = rect_json(&Rect::default());
                emit_tray(out, "menu", tray_id, command_id, &bounds);
            }
        }
        // 托盘点击
        while let Ok(event) = TrayIconEvent::receiver().try_recv() {
            if let TrayIconEvent::Click {
                id,
                button,
                button_state,
                rect,
                ..
            } = event
            {
                if matches!(button_state, tray_icon::MouseButtonState::Up) {
                    let cmd = match button {
                        tray_icon::MouseButton::Left => "click",
                        _ => "right-click",
                    };
                    emit_tray(out, cmd, &id.0, cmd, &rect_json(&rect));
                }
            }
        }
    }
}

fn emit_tray(out: &Out, kind: &str, tray_id: &str, command_id: &str, bounds: &serde_json::Value) {
    let event = if kind == "click" {
        "tray:click"
    } else {
        "tray:menu"
    };
    let line = json!({
        "event": event,
        "id": tray_id,
        "commandId": command_id,
        "bounds": bounds
    });
    crate::util::emit(out, &line);
}

fn rect_json(r: &Rect) -> serde_json::Value {
    json!({ "x": r.position.x, "y": r.position.y, "width": r.size.width, "height": r.size.height })
}

/// 解码托盘图标 dataURL。PNG/ICO 是压缩格式，必须经 image crate 解码成 RGBA；
/// 旧实现把 PNG 压缩字节直接当 RGBA 交给 Icon::from_rgba，会生成损坏图标。
fn decode_icon(data_url: Option<&str>) -> Result<Option<Icon>, String> {
    let Some(url) = data_url else {
        return Ok(None);
    };
    let b64 = match url.split_once(',') {
        Some((prefix, payload)) if prefix.starts_with("data:image/") => payload,
        _ => return Err("invalid tray icon dataURL".to_string()),
    };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("tray icon base64: {e}"))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("tray icon decode: {e}"))?
        .to_rgba8();
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("empty tray icon".to_string());
    }
    let icon = Icon::from_rgba(img.into_raw(), w, h).map_err(|e| format!("tray icon rgba: {e}"))?;
    Ok(Some(icon))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn tray_icon_png_data_url_decodes_to_rgba() {
        let img = image::RgbaImage::from_fn(16, 16, |x, y| {
            image::Rgba([x as u8 * 16, y as u8 * 16, 128, 255])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode png");
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        assert!(decode_icon(Some(&url)).expect("decode png").is_some());
    }

    #[test]
    fn tray_icon_rejects_malformed_data_url() {
        assert!(decode_icon(None).expect("none").is_none());
        assert!(decode_icon(Some("not-a-data-url")).is_err());
        assert!(decode_icon(Some("data:image/png;base64,%%%")).is_err());
    }
}

/// 16x16 中性灰方块作为默认图标（RGBA），避免依赖外部资源文件。
fn default_icon() -> Result<Icon, String> {
    let size = 16u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        rgba.extend_from_slice(&[0x60, 0x60, 0x60, 0xFF]);
    }
    Icon::from_rgba(rgba, size, size).map_err(|e| format!("{:?}", e))
}
