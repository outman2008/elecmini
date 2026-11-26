/**
 * ElecMini P2-D — Tray shim
 * 委托 host 创建系统托盘（tray-icon + muda）。无头 Xvfb 下 tray 常不可用，
 * host 返回 { ok:false, reason }；shim 仍保持 Electron Tray API 形状与事件分发。
 */
const { EventEmitter } = require('events');
const ctx = require('../context');

class Tray extends EventEmitter {
  constructor(image) {
    super();
    this._id = `tray_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._image = image;
    this._destroyed = false;
    this._menuItems = [];
    ctx.get()._trays = ctx.get()._trays || {};
    ctx.get()._trays[this._id] = this;
    ctx.get().rpc.call('tray:create', { id: this._id, image: image?.toDataURL?.() || image || null });
  }
  setImage(image) {
    this._image = image;
    if (this._destroyed) return;
    ctx.get().rpc.notify('tray:setImage', { id: this._id, image: image?.toDataURL?.() || image || null });
  }
  setTitle(title) {
    if (this._destroyed) return;
    ctx.get().rpc.notify('tray:setTitle', { id: this._id, title });
  }
  setToolTip(tip) {
    if (this._destroyed) return;
    ctx.get().rpc.notify('tray:setTooltip', { id: this._id, tooltip: tip });
  }
  setContextMenu(menu) {
    if (this._destroyed) return;
    this._menuItems = (menu?.items || []).slice();
    // host 的 tray:menu 事件回传 id；模板未显式给 id 时退化为 label，保证可找回 click 回调。
    const items = this._menuItems.map((i) => ({
      label: i.label,
      type: i.type,
      enabled: i.enabled,
      id: i.commandId || i.id || i.label,
    }));
    ctx.get().rpc.call('tray:setContextMenu', { id: this._id, items });
  }
  popUpContextMenu() {
    if (!this._destroyed) ctx.get().rpc.notify('tray:popup', { id: this._id });
  }
  destroy() {
    this._destroyed = true;
    ctx.get().rpc.notify('tray:destroy', { id: this._id });
  }
  /** host 点击事件回传：tray:click { id, bounds } */
  _onClick(bounds) {
    this.emit('click', { x: bounds?.x || 0, y: bounds?.y || 0 }, bounds || {});
  }
  /** host 菜单事件回传：tray:menu { id, commandId } → 调用模板 click */
  _onMenu(commandId) {
    const it = this._menuItems.find((i) => (i.commandId || i.id || i.label) === commandId);
    if (it && typeof it.click === 'function') it.click();
  }
}

function bindTrayEvents(rpc) {
  if (!rpc || typeof rpc.on !== 'function') return;
  rpc.on('tray:click', ({ id, bounds } = {}) => {
    const t = ctx.get()._trays?.[id];
    if (t) t._onClick(bounds);
  });
  rpc.on('tray:menu', ({ id, commandId } = {}) => {
    const t = ctx.get()._trays?.[id];
    if (t) t._onMenu(commandId);
  });
}

module.exports = { Tray, bindTrayEvents };
