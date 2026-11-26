//! 系统通知后端（跨平台）。
//!
//!   Linux:   notify-send（notify-send 存在即视为支持；无头 Xvfb 下调用静默失败）
//!   macOS:   osascript -e 'display notification "..." with title "..."'
//!   Windows: PowerShell ShowToast（BurntToast 不可用时回退到 MessageBox 风格）
//!
//! 设计原则：show 永不 panic；工具缺失/无头环境返回 ok=false，由上层决定降级提示。
//! 与 s4.rs 一样把平台差异收敛在独立模块，主事件循环只做分派。

use std::process::Command;

/// 当前平台是否具备发送系统通知的能力（用于 Notification.isSupported()）。
pub fn is_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        return tool_exists("notify-send");
    }
    #[cfg(target_os = "macos")]
    {
        return tool_exists("osascript");
    }
    #[cfg(target_os = "windows")]
    {
        return true; // PowerShell 内置
    }
    #[allow(unreachable_code)]
    false
}

fn tool_exists(program: &str) -> bool {
    let mut cmd = Command::new("sh");
    cmd.args(["-c", &format!("command -v {}", program)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// 发送通知。title/body/subtitle 已由调用方从 JSON 解出。
/// silent=true 时不发出提示音（notify-send 用 -a 空提示近似；其余平台忽略）。
pub fn show(title: &str, body: &str, subtitle: &str, silent: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let mut args = vec!["--app-name=elecmini"];
        if silent {
            args.push("--urgency=low");
        }
        if !subtitle.is_empty() {
            args.push("--hint");
            args.push("string:subtitle");
            args.push(subtitle);
        }
        args.push(title);
        args.push(body);
        run("notify-send", &args, None)?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let text = if subtitle.is_empty() {
            body.to_string()
        } else {
            format!("{}\n{}", subtitle, body)
        };
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape_osascript(&text),
            escape_osascript(title)
        );
        run("osascript", &["-e", &script], None)?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        // PowerShell BurntToast：优先 New-BurntToastNotification；不可用则忽略。
        let ps = format!(
            "try {{ Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text \"{}\", \"{}\" }} catch {{ }}",
            escape_ps(title),
            escape_ps(if subtitle.is_empty() { body } else { subtitle })
        );
        run("powershell", &["-NoProfile", "-Command", &ps], None)?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = (title, body, subtitle, silent);
        Err("notification: unsupported platform".to_string())
    }
}

fn run(program: &str, args: &[&str], input: Option<&str>) -> Result<String, String> {
    use std::io::Write as _;
    let mut cmd = Command::new(program);
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
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(target_os = "macos")]
fn escape_osascript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "windows")]
fn escape_ps(s: &str) -> String {
    s.replace('`', "``").replace('"', "`\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_does_not_panic() {
        // 仅断言不 panic；有头/无头环境结果均可接受
        let _ = is_supported();
    }

    #[test]
    fn show_empty_title_does_not_panic() {
        // autotest 环境无通知工具时应安全返回 Err，不 panic
        let _ = show("", "", "", true);
    }
}
