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
 * 治理原则（另见 docs/unsupported-apis.md，分级由 migrate/api-surface/audit.js 生成）：
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

/**
 * 同步 API 的安全默认值（按官方 electron.d.ts 返回类型）。
 *
 * 关键语义：forced-sync 调用方写的是 `const x = fooSync()`，期望拿到同步值。
 * 若降级桩返回 Promise，则 `x === 1` / `x.length` / `x[0]` 等同步运算全部静默失真
 * （如 caprine 用 `showMessageBoxSync(...) === 1` 判断是否退出）。因此同步 API
 * 的降级桩必须「同步返回类型正确的值」，即使无法真的弹出对话框。
 *
 * 值的选择原则：返回「默认/取消」语义的安全值，不误触发破坏性分支。
 */
function syncSafeDefault(mod, member, args) {
  // 兼容 (options) 与 (window, options) 两种重载：优先取真正含选项字段的对象，
  // 跳过 window 对象（它也是 object，但没有 defaultId/buttons/message）。
  const opts = (args || []).find((a) => a && typeof a === 'object' && !Array.isArray(a)
    && ('defaultId' in a || 'buttons' in a || 'message' in a || 'defaultPath' in a)) || {};
  switch (member) {
    case 'showMessageBoxSync':
      // 官方返回 number（被点击按钮索引）。返回调用方指定的 defaultId，
      // 等价于用户点了默认按钮；caprine defaultId=0 → Wait/继续，不误退出。
      return typeof opts.defaultId === 'number' ? opts.defaultId : 0;
    case 'showOpenDialogSync':
      // 官方返回 string[] | undefined（取消为 undefined）。空数组表示未选中，
      // 调用方 `paths.forEach` 不会崩，也不会误当有效路径处理。
      return [];
    case 'showSaveDialogSync':
      // 官方返回 string，取消为 undefined。空串表示未选择保存路径。
      return '';
    case 'sendSync':
      // 官方返回 any（同步 IPC 结果）。undefined 表示无 Reply，属安全默认。
      return undefined;
    default:
      if (/^(is|has|should|can|will|does|supports)/.test(member)) return false;
      return undefined;
  }
}

/** 是否为架构不可补的同步 API（其降级桩须同步返回安全值，不能返回 Promise） */
function isSyncUnsupported(mod, member) {
  const r = degradeReason(mod, member);
  return !!r && r.startsWith('unsupported-sync:');
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
          // 同步 API 必须同步返回安全值；其余降级桩返回 Promise<默认值>
          value: isSyncUnsupported(mod, member)
            ? function (...args) { return syncSafeDefault(mod, member, args); }
            : function () { return Promise.resolve(defaultValue(member)); },
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
          // 同步 API 必须同步返回安全值；其余降级桩返回 Promise<默认值>
          value: isSyncUnsupported(mod, member)
            ? (...args) => syncSafeDefault(mod, member, args)
            : () => Promise.resolve(defaultValue(member)),
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
