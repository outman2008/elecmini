//! S2 — 同步 API 机制验证（第一技术风险，文档 3.3）
//!
//! 问题：Electron 的 getBounds()/getURL() 等是同步返回的。在 B2 架构下，
//! 「Node sidecar」调用 API 时窗口由 Rust 主线程持有，必须跨线程同步取真实值。
//!
//! 本验证：worker 线程（模拟 Node sidecar）发同步请求 → 主线程（持有窗口/tao）
//! 响应真实 bounds → worker 阻塞直到拿到结果。证明「JS 侧同步、底层跨线程」可成立。
//!
//! 同时验证问题一（主线程归属）：主线程跑 tao 事件循环期间，worker 的同步请求
//! 能被及时响应（通过 Proxy 把请求注入事件循环），不死锁、不丢帧。

use std::sync::mpsc::{channel, Sender};
use std::time::{Duration, Instant};

use tao::{
    event::{Event, StartCause, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};

/// 主线程与 sidecar 之间的请求/响应消息
enum Msg {
    GetBounds { reply: Sender<(u32, u32)> },
}

fn main() {
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("ElecMini S2 sync spike")
        .with_inner_size(tao::dpi::LogicalSize::new(777u32, 555u32))
        .build(&event_loop)
        .expect("window");
    let proxy: EventLoopProxy<Msg> = event_loop.create_proxy();

    // worker 线程：模拟 Node sidecar 的同步调用
    let proxy_for_worker = proxy.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300)); // 等窗口就绪
        let (tx, rx) = channel();
        let _ = proxy_for_worker.send_event(Msg::GetBounds { reply: tx });
        // 同步阻塞等待主线程响应（模拟 JS 侧同步 API）
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok((w, h)) => {
                eprintln!("[S2] sidecar sync getBounds() = ({}, {})", w, h);
                assert_eq!(
                    (w, h),
                    (640, 480),
                    "S2 FAIL: 未拿到主线程 resize 后的真实值"
                );
                eprintln!("[S2] PASS: 跨线程同步调用返回真实值");
            }
            Err(e) => eprintln!("[S2] FAIL: 同步调用超时/失败: {:?}", e),
        }
    });

    // 主线程：event loop 中接收请求并以窗口真实尺寸应答
    let mut resized = false;
    let start = Instant::now();
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Poll;

        match event {
            // 主线程收到 worker 经 proxy 投递的同步请求 → 用真实 bounds 应答
            Event::UserEvent(Msg::GetBounds { reply }) => {
                let size = window.inner_size();
                let _ = reply.send((size.width, size.height));
            }
            Event::NewEvents(StartCause::Init) => {}
            // 启动 150ms 后主线程主动 resize，验证 sidecar 拿到的是 resize 后的实时值
            Event::MainEventsCleared => {
                if !resized && start.elapsed() > Duration::from_millis(150) {
                    window.set_inner_size(tao::dpi::LogicalSize::new(640u32, 480u32));
                    resized = true;
                    eprintln!("[S2] main thread resized window to 640x480");
                }
                if start.elapsed() > Duration::from_secs(2) {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
