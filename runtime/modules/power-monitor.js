/**
 * ElecMini P2-F — powerMonitor shim（EventEmitter）
 * host 推送 suspend/resume/lock-unlock/idle-state 事件。无头环境不产生真实系统事件，
 * 但保留 API 形状，契约测试验证事件订阅接口存在。
 */
const { EventEmitter } = require('events');
const ctx = require('../context');

class PowerMonitor extends EventEmitter {
  getSystemIdleTime() {
    return ctx.get().rpc.call('powerMonitor:getIdleTime', {}).then((r) => r?.seconds ?? 0);
  }
  onBatteryPower() {
    return ctx.get().rpc.call('powerMonitor:onBattery', {}).then((r) => !!r?.onBattery);
  }
}

const powerMonitor = new PowerMonitor();

function bindPowerEvents(rpc) {
  if (!rpc || typeof rpc.on !== 'function') return;
  for (const evt of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) {
    rpc.on(`power:${evt}`, (payload) => powerMonitor.emit(evt, payload));
  }
  rpc.on('power:idle-state', (p) => powerMonitor.emit(p?.idle ? 'idle' : 'active'));
}

module.exports = { powerMonitor, bindPowerEvents };
