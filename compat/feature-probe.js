/**
 * 渲染特性探测脚本（浏览器 WebView 内执行，纯 ES5 兼容语法，自身不依赖被测特性）
 *
 * 用法：宿主在窗口创建后注入执行，或在任意浏览器控制台执行，返回结构化结果。
 * 输出：{ ua, engine, css:{}, js:{}, missing:[], pass }
 *
 * 注意：探测代码本身必须比基线更保守——用 typeof / CSS.supports 字符串探测，
 *       绝不能因为调用了某个缺失特性而自己抛错。
 */
function featureProbe() {
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  var engine = 'unknown';
  if (/Edg\//.test(ua)) engine = 'webkit2-chromium(WebView2)';
  else if (/HeadlessChrome\//.test(ua)) engine = 'chromium(headless)';
  else if (/Chrome\//.test(ua) && !/Safari\//.test(ua)) engine = 'chromium';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) engine = 'webkit';
  else if (/Firefox\//.test(ua)) engine = 'gecko';
  else if (typeof process !== 'undefined' && process.versions && process.versions.node) engine = 'node(no-css-engine)';

  var css = {};
  var cssSupports = (typeof CSS !== 'undefined' && typeof CSS.supports === 'function')
    ? function (q) { try { return CSS.supports(q); } catch (e) { return false; } }
    : function () { return false; };

  css[':has()'] = cssSupports('selector(:has(*))');
  css['inset'] = cssSupports('inset: 0px');
  css['aspect-ratio'] = cssSupports('aspect-ratio: 1/1');
  css['gap'] = cssSupports('gap: 1px');

  var js = {};
  function hasGlobal(name) { try { return typeof globalThis[name] !== 'undefined'; } catch (e) { return false; } }
  function hasProto(ns, prop) { try { return typeof globalThis[ns].prototype[prop] === 'function'; } catch (e) { return false; } }

  js.structuredClone = hasGlobal('structuredClone');
  js['Array.prototype.at'] = hasProto('Array', 'at');
  js['Object.hasOwn'] = hasGlobal('Object') && typeof Object.hasOwn === 'function';
  js['Promise.any'] = hasGlobal('Promise') && typeof Promise.any === 'function';
  js.globalThis = hasGlobal('globalThis');
  js.AbortController = hasGlobal('AbortController');
  js.WeakRef = hasGlobal('WeakRef');

  var required = {
    css: [':has()', 'inset', 'aspect-ratio', 'gap'],
    js: ['structuredClone', 'Array.prototype.at', 'Object.hasOwn', 'Promise.any', 'globalThis', 'AbortController', 'WeakRef'],
  };
  var missing = [];
  required.css.forEach(function (k) { if (!css[k]) missing.push('css:' + k); });
  required.js.forEach(function (k) { if (!js[k]) missing.push('js:' + k); });

  return {
    ua: ua,
    engine: engine,
    css: css,
    js: js,
    missing: missing,
    pass: missing.length === 0,
  };
}

// 同时兼容浏览器（probe.html 内联加载）与 Node（check.js --self-test require）
if (typeof module !== 'undefined' && module.exports) module.exports = featureProbe;
if (typeof window !== 'undefined') window.featureProbe = featureProbe;
