/**
 * ElecMini P1 — shell shim
 * openExternal / openPath / showItemInFolder / writeClipboard / readClipboard
 */
const ctx = require('../context');

const shell = {
  openExternal(url) { return ctx.get().rpc.call('shell:openExternal', { url }); },
  openPath(path) { return ctx.get().rpc.call('shell:openPath', { path }); },
  showItemInFolder(path) { return ctx.get().rpc.call('shell:showItem', { path }); },
  writeClipboard(text) { return ctx.get().rpc.call('shell:writeClipboard', { text }); },
  readClipboard() { return ctx.get().rpc.call('shell:readClipboard', {}); },
};

module.exports = { shell };
