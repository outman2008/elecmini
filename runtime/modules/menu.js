/**
 * ElecMini P1 — Menu / MenuItem shim
 * buildFromTemplate → 本地菜单树；setApplicationMenu → 委托 host（P1 记录菜单结构，
 * 真实原生菜单渲染视 host 实现程度）。保持 Electron 模板 API 形状。
 */
const ctx = require('../context');

class MenuItem {
  constructor(opts = {}) {
    this.label = opts.label || '';
    this.type = opts.type || (opts.submenu ? 'submenu' : 'normal');
    this.enabled = opts.enabled !== false;
    this.checked = !!opts.checked;
    this.click = opts.click || null;
    this.accelerator = opts.accelerator || '';
    this.commandId = opts.id || '';
    this.submenu = opts.submenu ? Menu.buildFromTemplate(opts.submenu) : null;
  }
}

class Menu {
  constructor(items = []) { this.items = items; }

  static buildFromTemplate(template = []) {
    return new Menu(template.map((t) => new MenuItem(t)));
  }

  static getApplicationMenu() { return ctx.get()._appMenu || null; }

  static setApplicationMenu(menu) {
    ctx.get()._appMenu = menu;
    return ctx.get().rpc.notify('menu:setApplicationMenu', {
      items: (menu?.items || []).map((i) => ({ label: i.label, type: i.type, enabled: i.enabled, accelerator: i.accelerator })),
    });
  }

  /** 触发某菜单项 click（供 host 点击回传） */
  static _click(commandId) {
    const find = (items) => {
      for (const it of items) {
        if (it.commandId === commandId && it.click) return it;
        if (it.submenu) { const f = find(it.submenu.items); if (f) return f; }
      }
      return null;
    };
    const it = find((ctx.get()._appMenu?.items) || []);
    if (it) it.click();
  }

  append(item) { this.items.push(item); }
  insert(pos, item) { this.items.splice(pos, 0, item); }
  getItems() { return this.items.slice(); }
}

module.exports = { Menu, MenuItem };
