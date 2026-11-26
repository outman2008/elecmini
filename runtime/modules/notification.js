/**
 * ElecMini P6-G — Notification shim（对齐 Electron Notification）
 *
 * Electron 契约（electron.d.ts）：
 *   new Notification(options) / Notification.isSupported() / Notification.requestPermission()
 *   instance.show() / close() / .on('click'|'close'|'show')
 *   static permission / static isSupported()
 *
 * 实现：JS 侧维护实例与事件分发，实际系统通知由 host RPC 触发
 *   - Linux: notify-send（无 GUI 时静默降级，返回 supported=false）
 *   - macOS: osascript -e 'display notification'
 *   - Windows: PowerShell ShowToast（Win10+）
 * 无头/CI 环境下 host 返回 { ok:false }，API 形状与事件仍保持。
 */
const { EventEmitter } = require('events');
const ctx = require('../context');

let _permission = 'default';
let _supported = false;

class Notification extends EventEmitter {
  constructor(options = {}) {
    super();
    this.title = options.title || '';
    this.body = options.body || '';
    this.subtitle = options.subtitle || '';
    this.silent = !!options.silent;
    this.icon = options.icon || '';
    this._id = `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._shown = false;
    this._closed = false;
    ctx.get()._notifications = ctx.get()._notifications || {};
    ctx.get()._notifications[this._id] = this;
  }

  show() {
    if (this._closed || this._shown) return;
    this._shown = true;
    return ctx
      .get()
      .rpc.call('notification:show', {
        id: this._id,
        title: this.title,
        body: this.body,
        subtitle: this.subtitle,
        icon: this.icon,
        silent: this.silent,
      })
      .then((r) => {
        this.emit('show');
        return r && r.ok !== false;
      })
      .catch(() => false);
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    ctx.get().rpc.notify('notification:close', { id: this._id });
    this.emit('close');
  }

  /** host 点击回传：notification:click { id } */
  _onClick() {
    this.emit('click');
  }
  _onClose() {
    this.emit('close');
  }

  static isSupported() {
    return _supported;
  }

  static requestPermission(callback) {
    const result = 'granted';
    _permission = result;
    if (typeof callback === 'function') callback(result);
    return Promise.resolve(result);
  }

  static get permission() {
    return _permission;
  }
}

function bindNotificationEvents(rpc) {
  if (!rpc || typeof rpc.on !== 'function') return;
  rpc.on('notification:supported', ({ supported } = {}) => {
    _supported = !!supported;
  });
  rpc.on('notification:click', ({ id } = {}) => {
    const n = ctx.get()._notifications?.[id];
    if (n) n._onClick();
  });
  rpc.on('notification:close', ({ id } = {}) => {
    const n = ctx.get()._notifications?.[id];
    if (n) n._onClose();
  });
}

module.exports = { Notification, bindNotificationEvents };
