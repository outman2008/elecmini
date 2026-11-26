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
 * 配置：
 *   setFeedURL(url)            更新 manifest（format: elecmini-update/1）的地址
 *   环境变量 ELECMINI_UPDATE_URL / ELECMINI_UPDATE_PUBKEY
 *   transport 注入：_setTransport(fn) 便于单测 mock（fn(url) -> Promise<json>）
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

let updateModule = null;
function getUpdater() {
  if (!updateModule) updateModule = require('../../pack/update.js');
  return updateModule;
}

class AutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.feedURL = process.env.ELECMINI_UPDATE_URL || '';
    this.currentVersion = process.env.ELECMINI_APP_VERSION || '0.0.0';
    this.autoDownload = false;
    this.autoInstallOnAppQuit = true;
    this.allowPrerelease = false;
    this._cachedRelease = null;
    this._transport = null;
    this._downloading = false;
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
    if (this._transport) return this._transport(url);
    const https = require('https');
    return new Promise((resolve, reject) => {
      https
        .get(url, (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
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
      const newer = this._isNewer(release.version, this.currentVersion);
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

  /** Electron: downloadUpdate() -> Promise<string[]>（下载的文件路径） */
  async downloadUpdate() {
    if (this._downloading) return [];
    this._downloading = true;
    try {
      const release = this._cachedRelease;
      if (!release || !release.files) {
        throw new Error('no update available; call checkForUpdates() first');
      }
      const staging = path.join(os.tmpdir(), `elecmini-update-${process.pid}`);
      fs.mkdirSync(staging, { recursive: true });
      const total = release.files.length;
      const paths = [];
      for (let i = 0; i < total; i++) {
        const f = release.files[i];
        // 真实下载应由 feed 提供每个文件的 URL；此处用 release.files[].url 或 feedURL 同目录推导
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
        });
      }
      // 验签：verifyRelease 要求目录含全部文件
      const pubkey = process.env.ELECMINI_UPDATE_PUBKEY;
      const verify = getUpdater().verifyRelease(release, staging, pubkey);
      if (!verify.ok) {
        throw new Error('update verification failed: ' + verify.problems.join('; '));
      }
      this._stagingDir = staging;
      this.emit('update-downloaded', {
        version: release.version,
        releaseNotes: release.releaseNotes || '',
        releaseName: release.version,
        releaseDate: release.generatedAt || new Date().toISOString(),
        updateInfo: release,
      });
      return paths;
    } catch (e) {
      this.emit('error', e);
      return [];
    } finally {
      this._downloading = false;
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

  /** 半语义化版本比较：只比数值段，忽略 prerelease（够用于更新决策） */
  _isNewer(a, b) {
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
