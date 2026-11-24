/**
 * ElecMini P5 — 官方契约补齐层
 *
 * 目标：让官方 electron.d.ts 声明的每个成员都在 shim 上"存在"，避免迁移应用
 * 因 API 缺失直接 TypeError；同时严格分级，不把降级实现伪装成原生能力。
 *
 * 三级语义：
 *   native   — 原有实现（真实 host 能力），不在本层补齐
 *   mirror   — 状态镜像：set 写入、get/is 读回，有真实状态效果（非原生）
 *   degraded — 降级桩：平台专属/同步 API/需 Chromium 网络栈，返回安全默认值
 *
 * 所有补齐成员登记到 registry，供审计工具诚实分级统计。
 */
'use strict';

const contract = require('./contract-data');

const registry = {}; // { Module: { member: { level, reason } } }

function record(mod, member, level, reason) {
  (registry[mod] ||= {})[member] = { level, reason };
}

/**
 * 按名称判定降级原因；返回 null 表示可走状态镜像。
 *
 * P6 治理原则（见 migrate/REPORT-official-api-baseline.md）：
 *   - 误分类修正：FullScreen/Kiosk 等 tao 原生通用窗口能力已由 runtime 模块真实实现，
 *     不再落入降级（真实实现的成员在 fillObject 中会被 `member in target` 跳过）。
 *   - 平台细分：platform-specific 标注具体平台，便于按发版目标评估。
 *   - unsupported：架构上不可补的同步 API / Chromium 扩展体系，迁移时须改写调用方。
 */
function degradeReason(mod, member) {
  // 同步 API：阻塞渲染线程，与异步 RPC 架构冲突，不可补。
  if (/Sync$/.test(member) || member === 'sendSync') {
    return 'unsupported-sync: 同步 API 与异步 RPC 架构冲突，须改为 Promise 调用方';
  }
  // Chromium 扩展体系：WebKit/WebView2 无对应实现，不可补。
  if (mod === 'session' && /Extension|extension/.test(member)) {
    return 'unsupported-ext: Chromium 扩展体系，无 WebView 对应能力';
  }
  // 平台专属 UI/系统能力（细分平台；NativeWindowHandle/capturePage 已真实实现，不在此列）。
  if (/TouchBar|Vibrancy|BackgroundMaterial|AccentColor|TouchID|UserActivity|SecurityScoped|Notarization|inAppPurchase|ShareMenu|shareMenu|DesktopName|dock|Dock|BadgeCount|AppShim|ActivationPolicy|EmojiPanel|WebAuthn/.test(member)) {
    return 'platform-macos: macOS 专属原生 UI/系统能力';
  }
  if (/MSIX|JumpList|Thumbnail|Thumbar|progressBar|TabbedWindow|tabbed|Tabbing|Taskbar|AppUserModelId|overlayIcon/.test(member)) {
    return 'platform-windows: Windows 专属原生 UI/系统能力';
  }
  if (/MissionControl|Mission|SheetOffset|LoginItem|FullScreen|Kiosk/.test(member)) {
    // FullScreen/Kiosk 保留兜底标注：若 runtime 未实现则按平台专属降级；
    // 已实现的成员在 fillObject 中会被跳过，不会走到这里。
    return 'platform-specific: 平台原生窗口/系统能力（跨平台或待实现）';
  }
  if (mod === 'session' && /WebRequest|webRequest|Proxy|Certificate|certificate|NTLM|SSL|Blob|Download|download|SharedDictionary|Bluetooth|USB|DevicePermission|DisplayMedia|SpellCheck|spellCheck/.test(member)) {
    return 'chromium-net: 依赖 Chromium 网络栈/扩展体系';
  }
  if (mod === 'protocol' && /Buffer|Stream|Http|intercept|Intercept|schemesAsPrivileged|Source|Handle|Unhandle/.test(member)) {
    return 'chromium-net: 依赖 Chromium 协议栈（register* 已接入 host，intercept* 仍降级）';
  }
  if (/MediaSourceId|Gesture|InputEvent|hookWindowMessage|WindowMessage/.test(member)) {
    return 'native-render: 依赖 Chromium 原生渲染/消息句柄';
  }
  return null;
}

function defaultValue(member) {
  if (/^(is|has|should|can|will|does|supports)/.test(member)) return false;
  if (/^(get|fetch|list|query)/.test(member)) return null;
  return null;
}

function ensureState(target, isClass) {
  // 单例对象用自身隐藏字段；class 实例用实例字段
  if (isClass) return null; // 实例方法内按 this 处理
  if (!target.__contractState) {
    Object.defineProperty(target, '__contractState', {
      value: {}, enumerable: false, writable: true, configurable: true,
    });
  }
  return target.__contractState;
}

function fillObject(mod, target, spec, isClass) {
  const stateKey = '__contractState';
  const all = [...spec.methods, ...spec.props];
  // class 的实例方法在 prototype 上；必须查 prototype，否则会把
  // close/loadURL/setTitle 等原生方法误判为缺失并用降级桩覆盖（致命回归）。
  const existenceTarget = isClass ? target.prototype : target;

  for (const member of all) {
    if (member in existenceTarget) continue; // 原生实现存在，跳过

    const reason = degradeReason(mod, member);
    const level = reason ? 'degraded' : 'mirror';
    record(mod, member, level, reason || 'state-mirror: 读写本地状态镜像（非原生）');

    const isProp = spec.props.includes(member);
    const isSetter = /^set[A-Z]/.test(member);
    const isGetterFn = /^(get|is|has|should|can|will|does|fetch|list|query)[A-Z]/.test(member);

    if (isClass) {
      // 补齐到 prototype，实例从 this 读状态
      if (isProp) {
        Object.defineProperty(target.prototype, member, {
          configurable: true, enumerable: true,
          get() { return (this[stateKey] ||= {})[member]; },
          set(v) { ((this[stateKey] ||= {})[member]) = v; },
        });
      } else if (reason) {
        Object.defineProperty(target.prototype, member, {
          configurable: true, enumerable: true, writable: true,
          value: function () { return Promise.resolve(defaultValue(member)); },
        });
      } else if (isSetter) {
        Object.defineProperty(target.prototype, member, {
          configurable: true, enumerable: true, writable: true,
          value: function (v) { ((this[stateKey] ||= {})[member.slice(3).toLowerCase()]) = v; return this; },
        });
      } else if (isGetterFn) {
        Object.defineProperty(target.prototype, member, {
          configurable: true, enumerable: true, writable: true,
          value: function () { return (this[stateKey] ||= {})[member.slice(3).toLowerCase()] ?? defaultValue(member); },
        });
      } else {
        Object.defineProperty(target.prototype, member, {
          configurable: true, enumerable: true, writable: true,
          value: function () { return Promise.resolve(null); },
        });
      }
    } else {
      const state = ensureState(target, false);
      if (isProp) {
        Object.defineProperty(target, member, {
          configurable: true, enumerable: true,
          get() { return state[member]; },
          set(v) { state[member] = v; },
        });
      } else if (reason) {
        Object.defineProperty(target, member, {
          configurable: true, enumerable: true, writable: true,
          value: () => Promise.resolve(defaultValue(member)),
        });
      } else if (isSetter) {
        Object.defineProperty(target, member, {
          configurable: true, enumerable: true, writable: true,
          value: (v) => { state[member.slice(3).toLowerCase()] = v; return target; },
        });
      } else if (isGetterFn) {
        Object.defineProperty(target, member, {
          configurable: true, enumerable: true, writable: true,
          value: () => state[member.slice(3).toLowerCase()] ?? defaultValue(member),
        });
      } else {
        Object.defineProperty(target, member, {
          configurable: true, enumerable: true, writable: true,
          value: () => Promise.resolve(null),
        });
      }
    }
  }
}

/**
 * 对 shim 导出施加契约补齐。
 * @param {object} exportsObj runtime/electron.js 的 module.exports
 * @returns {object} registry（分级登记）
 */
function apply(exportsObj) {
  for (const [mod, spec] of Object.entries(contract.modules)) {
    const target = exportsObj[mod];
    if (!target) continue; // 完全未导出的模块（autoUpdater 等）不在核心集，跳过
    const isClass = typeof target === 'function';
    fillObject(mod, target, spec, isClass);
  }
  return registry;
}

module.exports = { apply, registry, contract, degradeReason };
