/**
 * ElecMini P1 — 本地静态文件 server
 *
 * 背景：wry 0.52 在 WebKitGTK 的 IPC handler 用 http::Uri 解析当前页 URI，
 * file:// 会触发 InvalidUri panic。用本地 HTTP server 承载页面可规避，
 * 也符合文档 1.4「用自定义协议承载本地页面」的建议。
 *
 * 仅监听 127.0.0.1，随机端口，随 sidecar 退出关闭。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function createStaticServer(rootDir) {
  const root = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }
    // S4 验收：回显请求头，用于验证 WebView2 WebResourceRequested 注入是否生效
    if (urlPath === '/__s4_echo') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ url: req.url, headers: req.headers }));
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.resolve(root, '.' + urlPath);
    // 目录穿越防护
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

module.exports = { createStaticServer };
