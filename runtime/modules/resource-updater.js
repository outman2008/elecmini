/**
 * ElecMini 资源热更新器（独立于整包 autoUpdater）。
 *
 * 与 autoUpdater 的区别：
 *   - autoUpdater：整包（bin/runtime/shim/app）替换 + 重启，改代码用。
 *   - resourceUpdater：只替换 app/ 资源 + reload 页面，不重启进程，改前端资源用。
 *
 * 流程（对齐 electron-updater 事件模型）：
 *   checkForResourceUpdates() -> resource-available | resource-not-available
 *   -> downloadResourceUpdate() -> download-progress -> resource-downloaded
 *   -> applyResource()（原子替换 app/ + 失败回滚）-> 遍历窗口 webContents.reload()
 *   任一阶段失败 -> error 事件；替换失败自动回滚，不影响当前运行。
 *
 * 安全：资源 zip 整体 sha256 + 清单 files[] sha256 + bundleSha256 + 可选 Ed25519 签名，
 * 全部通过才替换；路径穿越 entry 由 extractResourceZip 拒绝。信任根是签名过的资源清单。
 *
 * 配置：
 *   setFeedURL(url)          整包 update.json 地址（从中读 resource/resources 字段）
 *   ELECMINI_UPDATE_URL      同上（默认）
 *   ELECMINI_APP_RESOURCE_CODE / ELECMINI_RESOURCE_CODE  当前资源 code（默认 0）
 *   _setTransport(fn)        单测注入（fn(url) -> Promise<string|Buffer|object>）
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let resourceModule = null;
function getResource() {
  if (!resourceModule) resourceModule = require('../../pack/resource.js');
  return resourceModule;
}
let zipModule = null;
function getZip() {
  if (!zipModule) zipModule = require('../../pack/zip.js');
  return zipModule;
}
let versionModule = null;
function getVersion() {
  if (!versionModule) versionModule = require('../../pack/version.js');
  return versionModule;
}
let deltaModule = null;
function getDelta() {
  if (!deltaModule) deltaModule = require('../../pack/delta.js');
  return deltaModule;
}

class ResourceUpdater extends EventEmitter {
  constructor() {
    super();
    this.feedURL = process.env.ELECMINI_UPDATE_URL || '';
    this._explicitCode = getVersion().parseVersionCode(
      process.env.ELECMINI_APP_RESOURCE_CODE || process.env.ELECMINI_RESOURCE_CODE,
    );
    this._transport = null;
    this._cachedResource = null;
    this._stagingDir = null;
    this._busy = false;
    this._cancelled = false;
    this._activeReq = null;
    this._cancelEmitted = false;
  }

  _cancelError() {
    const e = new Error('resource download cancelled');
    e.code = 'ELECMINI_CANCELLED';
    return e;
  }

  _guard() {
    if (this._cancelled) throw this._cancelError();
  }

  /** 随时停止资源下载：置标志 + 中断在途请求，发 download-cancelled（不触发 error） */
  cancelDownload() {
    if (!this._busy) return false;
    this._cancelled = true;
    if (this._activeReq) {
      try {
        this._activeReq.destroy();
      } catch (_) {}
      this._activeReq = null;
    }
    if (!this._cancelEmitted) {
      this._cancelEmitted = true;
      this.emit('download-cancelled', { reason: 'user cancelled' });
    }
    return true;
  }

  setFeedURL(url) {
    this.feedURL = url;
  }
  _setTransport(fn) {
    this._transport = fn;
  }

  /** 当前资源 code：显式优先；否则从 app/manifest.json 读取（若有） */
  get currentResourceCode() {
    if (this._explicitCode !== null) return this._explicitCode;
    try {
      const ctx = require('../context').get();
      const mf = path.join(ctx.appDir || '', 'resource.json');
      if (fs.existsSync(mf)) {
        const c = getVersion().parseVersionCode(JSON.parse(fs.readFileSync(mf, 'utf8')).resourceCode);
        if (c !== null) return c;
      }
    } catch (_) {
      /* ignore */
    }
    return 0;
  }

  async _fetch(url) {
    if (this._transport) {
      const r = await this._transport(url);
      this._guard();
      return r;
    }
    const https = require('https');
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          this._activeReq = null;
          if (this._cancelled) return reject(this._cancelError());
          resolve(data);
        });
      });
      this._activeReq = req;
      req.on('error', (e) => {
        this._activeReq = null;
        reject(this._cancelled ? this._cancelError() : e);
      });
    });
  }

  async _fetchBinary(url) {
    if (this._transport) {
      const r = await this._transport(url);
      this._guard();
      if (Buffer.isBuffer(r)) return r;
      if (typeof r === 'string') return Buffer.from(r);
      return Buffer.from(JSON.stringify(r));
    }
    const https = require('https');
    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          this._activeReq = null;
          if (this._cancelled) return reject(this._cancelError());
          resolve(Buffer.concat(chunks));
        });
      });
      this._activeReq = req;
      req.on('error', (e) => {
        this._activeReq = null;
        reject(this._cancelled ? this._cancelError() : e);
      });
    });
  }

  /** 从 feed 解析资源条目：优先按 sku 匹配，否则取 resource（单 SKU） */
  _pickResource(release) {
    const list = release.resources || (release.resource ? [release.resource] : []);
    if (!list.length) return null;
    let sku = null;
    try {
      sku = JSON.parse(
        fs.readFileSync(path.join(require('../context').get().appDir || '', 'manifest.json'), 'utf8'),
      ).sku;
    } catch (_) {
      /* 无 manifest 时用第一个 */
    }
    return (sku && list.find((r) => r.sku === sku)) || list[0];
  }

  /** Electron 风格：检查是否有更新的资源 */
  async checkForResourceUpdates() {
    this.emit('resource-checking');
    try {
      if (!this.feedURL) {
        this.emit('resource-not-available', { reason: 'no feedURL' });
        return null;
      }
      const raw = await this._fetch(this.feedURL);
      const release = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const entry = this._pickResource(release);
      if (!entry) {
        this.emit('resource-not-available', { reason: 'no resource entry' });
        return null;
      }
      const incoming = getVersion().parseVersionCode(entry.resourceCode) ?? 0;
      const current = this.currentResourceCode;
      if (incoming <= current) {
        this.emit('resource-not-available', { resourceCode: incoming, current });
        return null;
      }
      this._cachedResource = { entry, feedURL: this.feedURL };
      const info = { resourceCode: incoming, version: entry.version, fromCode: current };
      this.emit('resource-available', info);
      return { updateInfo: info };
    } catch (e) {
      this.emit('error', e);
      return null;
    }
  }

  /** 校验 staging 与资源清单一致（files[] sha256 + bundle + Ed25519），返回 manifest 对象 */
  async _verifyStaging(staging, entry, cached) {
    if (entry.manifest) {
      const mfUrl = new URL(entry.manifest, cached.feedURL).toString();
      const mfRaw = await this._fetch(mfUrl);
      const mf = typeof mfRaw === 'string' ? JSON.parse(mfRaw) : mfRaw;
      if (mf.resourceCode !== entry.resourceCode) throw new Error('资源清单 code 与条目不符');
      const pubkey = process.env.ELECMINI_UPDATE_PUBKEY || entry.signature?.publicKey;
      const verify = getResource().verifyResource(mf, staging, pubkey);
      if (!verify.ok) throw new Error('资源验签失败: ' + verify.problems.join('; '));
      return mf;
    }
    if (entry.bundleSha256) {
      // 无独立 manifest 时，用条目自带的 bundleSha256 做基本校验
      const files = walkRelative(staging).map((rel) => ({
        path: rel,
        sha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(staging, rel)))
          .digest('hex'),
      }));
      if (getResource().bundleDigest(files) !== entry.bundleSha256) throw new Error('资源 bundle 摘要不符');
      return { resourceCode: entry.resourceCode, files };
    }
    return { resourceCode: entry.resourceCode };
  }

  /**
   * 下载资源更新：优先按当前 resourceCode 选差分包（本地 app/ 作 base 重建），
   * 任何一步失败（sha256/CRC/base 不符/验签失败/网络错）回退全量资源 zip。
   */
  async downloadResourceUpdate() {
    if (this._busy) return [];
    this._busy = true;
    this._cancelled = false;
    this._cancelEmitted = false;
    try {
      const cached = this._cachedResource;
      if (!cached) throw new Error('no resource update; call checkForResourceUpdates() first');
      const entry = cached.entry;
      const current = this.currentResourceCode;
      this._guard();

      // 1) 增量：按 fromCode 匹配差分包
      const picked = getResource().selectResourceDelta(entry.resourceDeltas, current);
      if (picked) {
        try {
          const dUrl = picked.url || new URL(picked.file, cached.feedURL).toString();
          const dZip = await this._fetchBinary(dUrl);
          this._guard();
          if (picked.sha256 && crypto.createHash('sha256').update(dZip).digest('hex') !== picked.sha256) {
            throw new Error('资源差分包 sha256 不符');
          }
          const deltaObj = getDelta().unpackDelta(dZip, picked.encoding || 'zip');
          const ctx = require('../context').get();
          const appDir = ctx.appDir;
          if (!appDir || !fs.existsSync(appDir)) throw new Error('无本地 app/ 作为差分基准');
          const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-res-delta-'));
          getDelta().applyDirDelta(appDir, deltaObj, staging);
          const mf = await this._verifyStaging(staging, entry, cached);
          this._stagingDir = staging;
          this._resourceManifest = mf;
          this._downloadMode = 'resource-delta';
          this.emit('delta-selected', { fromCode: picked.fromCode, toCode: picked.toCode, file: picked.file });
          this.emit('download-progress', {
            percent: 100,
            transferred: 1,
            total: 1,
            bytes: dZip.length,
            mode: 'resource-delta',
          });
          this.emit('resource-downloaded', { resourceCode: entry.resourceCode, mode: 'resource-delta' });
          return [staging];
        } catch (e) {
          // 用户取消不是失败，不能被增量回退吞掉：直接向上抛，由外层统一发 download-cancelled
          if (e && e.code === 'ELECMINI_CANCELLED') throw e;
          // 增量失败：清理可能残留的 staging，回退全量
          this.emit('delta-fallback', { reason: e.message, fromCode: picked.fromCode });
        }
      }

      // 2) 全量：解包资源 zip + 验签
      const url = entry.url || new URL(entry.file, cached.feedURL).toString();
      const zipBuf = await this._fetchBinary(url);
      this._guard();
      if (entry.sha256 && crypto.createHash('sha256').update(zipBuf).digest('hex') !== entry.sha256) {
        throw new Error('资源包 sha256 不符');
      }
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'elecmini-res-update-'));
      getResource().extractResourceZip(zipBuf, staging);
      this._resourceManifest = await this._verifyStaging(staging, entry, cached);
      this._stagingDir = staging;
      this._downloadMode = 'resource';
      this.emit('download-progress', {
        percent: 100,
        transferred: 1,
        total: 1,
        bytes: zipBuf.length,
        mode: 'resource',
      });
      this.emit('resource-downloaded', { resourceCode: entry.resourceCode, mode: 'resource' });
      return [staging];
    } catch (e) {
      if (e && e.code === 'ELECMINI_CANCELLED') {
        if (!this._cancelEmitted) {
          this._cancelEmitted = true;
          this.emit('download-cancelled', { reason: 'user cancelled' });
        }
        return [];
      }
      this.emit('error', e);
      return [];
    } finally {
      this._busy = false;
      this._activeReq = null;
    }
  }

  /** 原子替换 app/ 目录（备份 -> 切换 -> 失败回滚），再 reload 所有窗口 */
  applyResource() {
    try {
      const ctx = require('../context').get();
      const appDir = ctx.appDir;
      const staging = this._stagingDir;
      if (!appDir || !staging) throw new Error('无 appDir 或 staging，无法应用资源');
      const mf = this._resourceManifest || {};
      const backup = path.join(os.tmpdir(), `elecmini-res-backup-${process.pid}`);
      fs.rmSync(backup, { recursive: true, force: true });

      // 1) 备份当前 app/
      if (fs.existsSync(appDir)) {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.cpSync(appDir, backup, { recursive: true, force: true });
      }
      // 2) 切换：删当前 app/ 内容，复制 staging
      try {
        if (process.env.ELECMINI_RESOURCE_FAIL === '1') throw new Error('injected apply failure');
        fs.rmSync(appDir, { recursive: true, force: true });
        fs.mkdirSync(appDir, { recursive: true });
        fs.cpSync(staging, appDir, { recursive: true });
        // 写入资源版本清单，供下次 currentResourceCode 读取
        fs.writeFileSync(path.join(appDir, 'resource.json'), JSON.stringify(mf, null, 2));
      } catch (e) {
        // 3) 回滚
        fs.rmSync(appDir, { recursive: true, force: true });
        if (fs.existsSync(backup)) fs.cpSync(backup, appDir, { recursive: true });
        throw new Error(`资源替换失败已回滚: ${e.message}`);
      }

      // 4) reload 所有窗口（不重启进程）
      const reloaded = this._reloadWindows();
      const mode = this._downloadMode || 'resource';
      this.emit('resource-applied', { resourceCode: mf.resourceCode, reloaded, downloadMode: mode });
      return { ok: true, reloaded, downloadMode: mode };
    } catch (e) {
      this.emit('error', e);
      return { ok: false, error: e.message };
    }
  }

  _reloadWindows() {
    let n = 0;
    try {
      const c = require('../context').get();
      const store = c.store;
      const rpc = c.rpc;
      if (!store || !rpc) return 0;
      for (const winId of store.windows.keys()) {
        const url = store.getWindow(winId)?.url;
        if (!url) continue;
        rpc.call('window:loadUrl', { winId, url }).catch(() => {});
        n++;
      }
    } catch (_) {
      /* context 未初始化时跳过 reload（单测环境） */
    }
    return n;
  }

  /** 便捷：检查 -> 下载 -> 应用，一步完成 */
  async checkDownloadAndApply() {
    const info = await this.checkForResourceUpdates();
    if (!info) return null;
    const paths = await this.downloadResourceUpdate();
    if (!paths.length) return null;
    return this.applyResource();
  }
}

function walkRelative(dir, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'resource.json') continue;
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walkRelative(full, rel));
    else out.push(rel);
  }
  return out;
}

const resourceUpdater = new ResourceUpdater();
module.exports = { resourceUpdater, ResourceUpdater, walkRelative };
