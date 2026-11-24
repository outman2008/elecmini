/**
 * ElecMini P2-A — screen shim（真实系统显示器）
 * P1 硬编码单屏；P2 从 host（tao monitor API）拉取真实显示器信息，缓存到 ctx。
 * 同步 API 语义：读 ctx.sysDisplays 镜像（launcher 在 host:ready 后异步拉取填充）。
 */
const ctx = require('../context');

function defaultDisplay() {
  return {
    id: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1,
    isPrimary: true,
  };
}

function displays() {
  const d = ctx.get().sysDisplays;
  return Array.isArray(d) && d.length ? d : [defaultDisplay()];
}

function primary() {
  return displays().find((d) => d.isPrimary) || displays()[0];
}

const screen = {
  getPrimaryDisplay() { return primary(); },
  getAllDisplays() { return displays(); },
  getDisplayMatching(rect) {
    const list = displays();
    return list.find((d) => {
      const b = d.bounds;
      return rect.x >= b.x && rect.x < b.x + b.width && rect.y >= b.y && rect.y < b.y + b.height;
    }) || primary();
  },
  getDisplayNearestPoint(point) {
    const list = displays();
    let best = list[0], bestDist = Infinity;
    for (const d of list) {
      const b = d.bounds;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const dist = (point.x - cx) ** 2 + (point.y - cy) ** 2;
      if (dist < bestDist) { bestDist = dist; best = d; }
    }
    return best;
  },
  getCursorScreenPoint() { return { x: 0, y: 0 }; },
  on() {}, once() {}, removeListener() {},
};

module.exports = { screen };
