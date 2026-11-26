/**
 * ElecMini P6-I — autoUpdater 兼容层（对齐 electron-updater 事件模型）
 *
 * Electron 的 autoUpdater 是 EventEmitter，事件序列：
 *   checking-for-update → update-available | update-not-available
 *   → download-progress → update-downloaded → quitAndInstall()
 *   → error（任一阶段失败）
 *
 * ElecMini 底层用 pack/update.js 的 verifyRelease（Ed25519 验签 + 摘要）与
 * applyWithRollback（staging → 切换 → 失败回滚）。这不是 electron-updater 的
 * 同一套实现，但事件模型/方法签名对齐，迁移应用可不改调用方。
 *
 * 增量更新（v1.1.1+）：若 manifest 带 deltas（内嵌数组或 deltas.json 的 URL），
 * 按当前版本自动选对应差分包（如 v1->3.0.0 选 3.0.0-1.0.0.diff），用本地文件
 * 重建到 staging。增量失败（差分包损坏/基准不符/无本地目录）自动回退全量下载。
 * 增量不绕过验签：重建后仍走 verifyRelease（Ed25519 + files[] sha256）。
 *
 * 配置：
 *   setFeedURL(url)            更新 manifest（format: elecmini-update/1）的地址
 *   环境变量 ELECMINI_UPDATE_URL / ELECMINI_UPDATE_PUBKEY
 *   transport 注入：_setTransport(fn) 便于单测 mock（fn(url) -> Promise<json>）
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let updateModule = null;
function getUpdater() {
  if (!updateModule) updateModule = require('../../pack/update.js');
  return updateModule;
}

let deltaModule = null;
function getDelta() {
  if (!deltaModule) deltaModule = require('../../pack/delta.js');
  return deltaModule;
}

let versionModule = null;
function getVersion() {
  if (!versionModule) versionModule = require('../../pack/version.js');
  return versionModule;
}

class AutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.feedURL = process.env.ELECMINI_UPDATE_URL || '';
    this.currentVersion = process.env.ELECMINI_APP_VERSION || '0.0.0';
    // versionCode 是机器键：显式值优先；未设置时由 _currentCode() 从 currentVersion 动态推导，
    // 这样构造后再改 currentVersion（测试常见用法）也能拿到一致的 code。
    this._explicitVersionCode = getVersion().parseVersionCode(process.env.ELECMINI_APP_VERSION_CODE);
    this.autoDownload = false;
    this.autoInstallOnAppQuit = true;
    this.allowPrerelease = false;
    this._cachedRelease = null;
    this._transport = null;
    this._downloading = false;
    this._cancelled = false;
    this._activeReq = null;
    this._cancelEmitted = false;
  }

  /** 构造取消错误（带机器可判 code，避免靠 message 匹配） */
  _cancelError() {
    const e = new Error('download cancelled');
    e.code = 'ELECMINI_CANCELLED';
    return e;
  }

  /** 在下载检查点抛错，让流程尽快退出 */
  _guard() {
    if (this._cancelled) throw this._cancelError();
  }

  /**
   * 随时停止当前下载：置取消标志 + 中断在途 HTTPS 请求。
   * 下载循环在每个文件前后及重建节点检查标志，故能立即停下。
   * 发 download-cancelled 事件（不触发 error）。
   */
  cancelDownload() {
    if (!this._downloading) return false;
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
  getFeedURL() {
    return this.feedURL;
  }

  /** 测试注入：fn(url, opts) => Promise<string|object>（响应体） */
  _setTransport(fn) {
    this._transport = fn;
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

  /** 以 Buffer 下载（差分包是真 zip，不能用字符串拼接，否则二进制损坏） */
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

  /** Electron: checkForUpdates() -> Promise<{ updateInfo } | null> */
  async checkForUpdates() {
    this.emit('checking-for-update');
    try {
      if (!this.feedURL) {
        const info = { version: this.currentVersion };
        this.emit('update-not-available', info);
        return null;
      }
      const raw = await this._fetch(this.feedURL);
      const release = typeof raw === 'string' ? JSON.parse(raw) : raw;
      this._cachedRelease = release;
      this._selectedDelta = await this._selectDelta(release); // 选好差分包，downloadUpdate 复用
      const newer = this._isNewer(release.version, this.currentVersion, release.versionCode, this.currentVersionCode);
      if (!newer) {
        this.emit('update-not-available', { version: release.version });
        return null;
      }
      const info = { version: release.version, releaseDate: release.generatedAt };
      this.emit('update-available', info);
      if (this.autoDownload) {
        // Electron 语义：autoDownload 时自动进下载流程，但不阻塞 checkForUpdates 返回
        this.downloadUpdate().catch(() => {});
      }
      return { updateInfo: info };
    } catch (e) {
      this.emit('error', e);
      return null;
    }
  }

  /** 解析 deltas 索引：manifest 内嵌数组，或 deltas.json 的 URL/对象 */
  async _resolveDeltas(release) {
    const d = release.deltas;
    if (!d) return null;
    if (Array.isArray(d)) return d;
    if (typeof d === 'object' && Array.isArray(d.deltas)) return d.deltas;
    if (typeof d === 'string') {
      const url = new URL(d, this.feedURL).toString();
      const raw = await this._fetch(url);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed) ? parsed : (parsed && parsed.deltas) || [];
    }
    return null;
  }

  /** 当前版本对应的差分包条目（无匹配返回 null → 走全量） */
  async _selectDelta(release) {
    try {
      const list = await this._resolveDeltas(release);
      if (!list || !list.length) return null;
      const picked = getDelta().selectDelta(list, this.currentVersion, this.currentVersionCode);
      if (picked) this.emit('delta-selected', { from: this.currentVersion, to: release.version, file: picked.file });
      return picked || null;
    } catch (e) {
      this.emit('delta-fallback', { reason: 'deltas 索引解析失败: ' + e.message });
      return null;
    }
  }

  /**
   * 增量下载：下载差分包 → 校验 sha256 → 用本地文件重建到 staging。
   * 本地目录取 ctx.appDir；不可用时抛错让调用方回退全量。
   */
  async _downloadViaDelta(release, entry, staging) {
    const ctx = require('../context').get();
    const appDir = ctx && ctx.appDir;
    if (!appDir || !fs.existsSync(appDir)) throw new Error('本地版本目录不可用，无法增量升级');

    const deltaUrl = entry.url || new URL(entry.file, this.feedURL).toString();
    const bytes = await this._fetchBinary(deltaUrl);
    // sha256 校验的是下载字节（zip 容器本身），zip 内还有 CRC32 二次校验；
    // 篡改任一层都无法通过，重建结果还要过 verifyRelease。
    if (entry.sha256 && crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error('差分包 sha256 不符');
    }
    // encoding='zip'（或 .zip 后缀）时解包；缺省按纯 JSON 处理，兼容旧 manifest。
    const encoding = entry.encoding === 'zip' || /\.zip$/i.test(entry.file || '') ? 'zip' : 'json';
    const delta = getDelta().unpackDelta(bytes, encoding);
    getDelta().applyDirDelta(appDir, delta, staging);
    this.emit('download-progress', {
      percent: 100,
      transferred: 1,
      total: 1,
      bytesPerSecond: 0,
      delta: entry.bytes || bytes.length,
      mode: 'delta',
    });
    return { mode: 'delta', paths: [path.join(staging, '__delta__.json')] };
  }

  /** 全量下载：逐文件下载到 staging（原有路径） */
  async _downloadFull(release, staging) {
    const total = release.files.length;
    const paths = [];
    for (let i = 0; i < total; i++) {
      this._guard();
      const f = release.files[i];
      const fileUrl = f.url || new URL(f.path, this.feedURL).toString();
      const buf = await this._fetch(fileUrl);
      const dest = path.join(staging, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, typeof buf === 'string' ? buf : Buffer.from(buf));
      paths.push(dest);
      this.emit('download-progress', {
        percent: Math.round(((i + 1) / total) * 100),
        transferred: i + 1,
        total,
        bytesPerSecond: 0,
        delta: 1,
        mode: 'full',
      });
    }
    return { mode: 'full', paths };
  }

  /** Electron: downloadUpdate() -> Promise<string[]>（下载/重建的文件路径） */
  async downloadUpdate() {
    if (this._downloading) return [];
    this._downloading = true;
    this._cancelled = false;
    this._cancelEmitted = false;
    try {
      const release = this._cachedRelease;
      if (!release || !release.files) {
        throw new Error('no update available; call checkForUpdates() first');
      }
      const staging = path.join(os.tmpdir(), `elecmini-update-${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });

      let result = null;
      this._guard();
      const entry = this._selectedDelta || (await this._selectDelta(release));
      if (entry) {
        try {
          result = await this._downloadViaDelta(release, entry, staging);
        } catch (e) {
          this.emit('delta-fallback', { reason: e.message, file: entry.file });
          fs.rmSync(staging, { recursive: true, force: true });
          fs.mkdirSync(staging, { recursive: true });
        }
      }
      if (!result) result = await this._downloadFull(release, staging);

      // 验签：增量与全量都必须通过（信任根是被签名的全量 manifest）
      const pubkey = process.env.ELECMINI_UPDATE_PUBKEY;
      const verify = getUpdater().verifyRelease(release, staging, pubkey);
      if (!verify.ok) {
        if (result.mode === 'delta') {
          // 增量重建结果没过验签 → 最后兜底：清场重下全量再验一次
          this.emit('delta-fallback', { reason: '增量重建未通过验签: ' + verify.problems.join('; ') });
          fs.rmSync(staging, { recursive: true, force: true });
          fs.mkdirSync(staging, { recursive: true });
          result = await this._downloadFull(release, staging);
          const retry = getUpdater().verifyRelease(release, staging, pubkey);
          if (!retry.ok) throw new Error('update verification failed: ' + retry.problems.join('; '));
        } else {
          throw new Error('update verification failed: ' + verify.problems.join('; '));
        }
      }
      this._stagingDir = staging;
      this._downloadMode = result.mode;
      this.emit('update-downloaded', {
        version: release.version,
        releaseNotes: release.releaseNotes || '',
        releaseName: release.version,
        releaseDate: release.generatedAt || new Date().toISOString(),
        updateInfo: release,
        downloadMode: result.mode,
      });
      return result.paths;
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
      this._downloading = false;
      this._activeReq = null;
    }
  }

  /** Electron: quitAndInstall(isSilent, isForceRunAfter) */
  quitAndInstall(isSilent = false, isForceRunAfter = false) {
    try {
      const ctx = require('../context').get();
      const currentDir = ctx.appDir || process.cwd();
      const staging = this._stagingDir || path.join(os.tmpdir(), `elecmini-update-${process.pid}`);
      const backup = path.join(os.tmpdir(), `elecmini-update-backup-${process.pid}`);
      const result = getUpdater().applyWithRollback(currentDir, staging, backup);
      if (!result.ok) {
        this.emit('error', new Error('update apply failed, rolled back: ' + result.log.join(' | ')));
        return;
      }
      this.emit('update-applied', { log: result.log });
      // 退出应用（Electron quitAndInstall 语义）；host 收到 app:quit 会关闭窗口
      if (ctx.app && typeof ctx.app.quit === 'function') ctx.app.quit();
      else process.exit(0);
    } catch (e) {
      this.emit('error', e);
    }
  }

  /** 当前展示版本推导出的 versionCode（仅在没有显式 code 时用） */
  _deriveCode() {
    return getVersion().deriveVersionCode(this.currentVersion);
  }

  /** 机器键：显式 versionCode 优先，否则从当前展示版本推导 */
  get currentVersionCode() {
    return this._explicitVersionCode !== null && this._explicitVersionCode !== undefined
      ? this._explicitVersionCode
      : this._deriveCode();
  }

  set currentVersionCode(value) {
    this._explicitVersionCode = getVersion().parseVersionCode(value);
  }

  /**
   * 判断 a 是否比 b 新。优先用 versionCode（纯整数）比较：
   *   versionCode 不受展示串里的 -beta / +build / # ? / 空格影响。
   * 两边 code 任一缺失时回退到旧的半语义化字符串比较（兼容无 code 的旧 manifest）。
   */
  _isNewer(a, b, aCode, bCode) {
    const ca = getVersion().parseVersionCode(aCode);
    const cb = getVersion().parseVersionCode(bCode);
    if (ca !== null && cb !== null) return ca > cb;
    const pa = String(a)
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0);
    const pb = String(b)
      .split(/[.-]/)
      .map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0,
        y = pb[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  // electron-updater 常见别名
  checkForUpdatesAndNotify() {
    this.autoDownload = true;
    return this.checkForUpdates();
  }
}

const autoUpdater = new AutoUpdater();

module.exports = { autoUpdater, AutoUpdater };
