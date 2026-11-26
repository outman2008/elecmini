/**
 * ElecMini P6-J — <webview> 桥接（Node sidecar 侧）
 *
 * 连接渲染层的 <webview> 自定义元素与 host 的子 WebView：
 *   1. 注册 ipcMain handler '__elecmini_webview__'：元素方法 → host RPC webview:*
 *   2. 监听 host 'webview:event'：guest 导航/加载事件 → web:send 回 renderer 元素
 *
 * 元素侧通过 ipcRenderer.invoke() 调用；winId 从 event.sender.id 取，无需元素传。
 */
const { ipcMain, ipcRenderer } = require('./modules/ipc');

const CHANNEL = '__elecmini_webview__';
const EVENT_CHANNEL = '__elecmini_webview_event__';

let installed = false;

function setupWebviewBridge(rpc) {
  if (installed) return;
  installed = true;

  // 元素方法 → host RPC
  ipcMain.handle(CHANNEL, async (event, payload = {}) => {
    const { op, guestId, url, code, x, y, width, height } = payload;
    const winId = (event && event.sender && event.sender.id) || 1;
    const base = { guestId, winId };
    try {
      switch (op) {
        case 'create':
          return rpc.call('webview:create', { ...base, url, x, y, width, height });
        case 'loadURL':
          return rpc.call('webview:loadURL', { ...base, url });
        case 'getURL':
          return rpc.call('webview:getURL', base);
        case 'setBounds':
          return rpc.call('webview:setBounds', { ...base, x, y, width, height });
        case 'executeJavaScript':
          return rpc.call('webview:executeJavaScript', { ...base, code });
        case 'destroy':
          return rpc.call('webview:destroy', base);
        default:
          return { ok: false, reason: 'unknown webview op: ' + op };
      }
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  });

  // host guest 事件 → renderer 元素（EventEmitter）
  if (rpc && typeof rpc.on === 'function') {
    rpc.on('webview:event', (msg = {}) => {
      const { winId, guestId, type, payload } = msg;
      rpc.notify('web:send', {
        winId,
        channel: EVENT_CHANNEL,
        payload: { guestId, type, payload },
      });
    });
  }
}

module.exports = { setupWebviewBridge, CHANNEL, EVENT_CHANNEL };
