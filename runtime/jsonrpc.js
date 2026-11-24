/**
 * ElecMini P1 — Node ↔ Rust host 双向 JSON-RPC（JSONL over stdio）
 *
 * 进程模型（B2 落地）：
 *   Node sidecar（本进程，持有 app main.js + shim）—spawn→ Rust host 子进程
 *   - 命令方向 Node→Host：write(command)，带自增 id，等待响应 Promise
 *   - 事件方向 Host→Node：host 主动写 event 行，本模块 emit 给订阅者
 *   - 同步 API（getBounds 等）：不走 RPC 往返，走本地状态镜像（host 在事件里
 *     推送真实值，shim 同步读缓存）——对应文档 3.3「JS 侧同步、底层异步」
 *
 * 帧格式（每行一个 JSON）：
 *   command: {"id":1,"method":"createWindow","params":{...}}
 *   response:{"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":"..."}
 *   event:   {"event":"resize","winId":1,"payload":{...}}
 */

const { EventEmitter } = require('events');

class RpcTransport extends EventEmitter {
  constructor(child, { timeoutMs = 8000, debug = false } = {}) {
    super();
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.debug = debug;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._buf = '';
    this._ready = false;

    // host 的 stdout 是 response/event 的 JSONL 通道；stderr 透传供诊断
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => {
      if (this.debug) process.stderr.write(`[host] ${chunk}`);
      else process.stderr.write(chunk);
    });
    child.on('exit', (code, signal) => {
      this._ready = false;
      this.emit('exit', { code, signal });
      // 未完成请求全部 reject
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`host exited (code=${code}, signal=${signal})`));
      }
      this._pending.clear();
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        this.emit('protocolError', { line, error: String(e) });
        continue;
      }
      if (this.debug) process.stderr.write(`[rpc<-] ${line}\n`);
      if (msg.event) {
        this.emit(msg.event, msg);
      } else if (msg.id != null && (msg.ok === true || msg.ok === false || 'result' in msg || 'error' in msg)) {
        const p = this._pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this._pending.delete(msg.id);
          if (msg.ok === false || msg.error != null) p.reject(new Error(String(msg.error || 'rpc error')));
          else p.resolve(msg.result);
        }
      }
    }
  }

  /** 发送命令并返回 Promise<result> */
  call(method, params = {}) {
    const id = this._nextId++;
    const line = JSON.stringify({ id, method, params }) + '\n';
    if (this.debug) process.stderr.write(`[rpc->] ${line.trim()}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (id=${id}, ${this.timeoutMs}ms)`));
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** 单向通知（不等待响应） */
  notify(method, params = {}) {
    const line = JSON.stringify({ id: this._nextId++, method, params, notify: true }) + '\n';
    if (this.debug) process.stderr.write(`[rpc->] ${line.trim()}\n`);
    this.child.stdin.write(line);
  }

  close() {
    try { this.child.stdin.end(); } catch (_) {}
  }
}

module.exports = { RpcTransport };
