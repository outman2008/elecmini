# ElecMini · Git SSH 凭证配置说明

生成日期：2026-11-24

## 凭证状态

| 项 | 值 |
|---|---|
| 密钥类型 | ed25519（无 passphrase，便于自动化） |
| 私钥路径 | `~/.ssh/id_ed25519`（权限 600，**绝不提交/分享**） |
| 公钥路径 | `~/.ssh/id_ed25519.pub` |
| 指纹 | `SHA256:Ryc8TYqH7oeH78xnCLPBSB4BD5Nz+5nUqLWMGQo4rP4` |
| 备注 | `elecmini@outman2008-github` |
| GitHub 公钥 ID | `170930176`（title: `elecmini-workspace-20261124`） |
| 关联账户 | `outman2008` |

## SSH 配置（~/.ssh/config）

```
Host github.com
  HostName ssh.github.com
  Port 443              # 22 端口被网络封锁，走 HTTPS 443 承载 SSH
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  ServerAliveInterval 60
```

## Git Remote（双通道）

| remote | URL | 用途 |
|---|---|---|
| `origin`（当前默认） | `https://github.com/outman2008/elecmini.git` | 当前沙箱网络可用（SSH 被拦截） |
| `origin-ssh`（备用） | `git@github.com:outman2008/elecmini.git` | 支持 SSH 的环境使用 |

### 切换到 SSH（在支持 SSH 的环境）

```bash
git remote set-url origin git@github.com:outman2008/elecmini.git
ssh -T git@github.com    # 应输出 Hi outman2008!
git push
```

### 切回 HTTPS

```bash
git remote set-url origin https://github.com/outman2008/elecmini.git
```

## 当前环境限制

本沙箱网络层只放行 HTTP/HTTPS 流量：
- 22 端口：连接超时
- 443 端口走 SSH 协议：TCP 通但无 SSH banner（中间设备拦截 SSH 协议）

因此 SSH 推送在当前环境不可用，凭证已完整配置并上传 GitHub，待在正常网络环境（本地开发机 / CI）使用。

## 安全提醒

- 私钥 `~/.ssh/id_ed25519` 权限 600，已被 `.gitignore` 天然排除（在 `~/.ssh`，不在仓库内）。
- 若怀疑私钥泄露，到 GitHub Settings → SSH and GPG keys 删除 ID `170930176` 并重新生成。
- 该 key 无 passphrase，适合自动化；如需更高安全可在本地重新生成带 passphrase 的密钥并替换。
