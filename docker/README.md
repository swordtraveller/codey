# Docker Compose 公网部署

此部署包会在一台 Linux VPS 上运行三个容器：

- `bridge-data-init`：仅首次/每次启动前确保数据卷归属正确；
- `bridge`：仅暴露在 Compose 内部网络的 Node Bridge；
- `caddy`：对公网开放 80/443，托管 Handover PWA，并为两个域名反向代理/自动管理 HTTPS。

Bridge 的 8787 端口**不会**映射到宿主机。Bridge 运行数据、Caddy 的证书数据均存放于命名卷，重新构建镜像或普通 `docker compose down` 不会丢失。

## 前提

1. 一台具备公网 IPv4（或正确配置 IPv6）的 Linux VPS；
2. 安装 Docker Engine 和 Docker Compose plugin；
3. 两个域名的 DNS 记录指向该 VPS：

   ```text
   bridge.example.com
   handover.example.com
   ```

4. 云防火墙与主机防火墙仅向公网开放 TCP 80 和 443；SSH 仅应向自己的管理来源开放。不要开放 TCP 8787。

首次签发证书时，DNS 必须已经生效，且 80/443 不能被其它 Web 服务占用。

## 首次上线

将当前仓库上传或克隆到 VPS 后，在仓库根目录执行：

```bash
cp .env.example .env
nano .env
```

将 `.env` 改为真实值，例如：

```dotenv
BRIDGE_DOMAIN=bridge.example.com
HANDOVER_DOMAIN=handover.example.com
ACME_EMAIL=ops@example.com
```

然后构建并启动：

```bash
docker compose up -d --build
docker compose ps
```

查看日志：

```bash
docker compose logs -f bridge caddy
```

验证 Bridge：

```bash
curl https://bridge.example.com/health
```

预期得到：

```json
{"ok":true,"protocolVersion":1}
```

随后在 Codey 创建频道时填写 `https://bridge.example.com`；手机访问 `https://handover.example.com`，完成配对和 Codey 审批。浏览器可将该 HTTPS 页面“添加到主屏幕”作为 PWA 使用，无需发布到 App Store 或 Google Play。

## 更新

更新代码后，在 VPS 仓库根目录执行：

```bash
git pull
docker compose up -d --build
docker image prune -f
```

Handover 的静态文件会在镜像构建阶段重新生成；Bridge 的 `bridge.json` 不会因上述操作而清空。

### 仅更新 handover 的步骤

1. 服务器更新 handover 目录 和 package.json, pnpm-lock.yaml
2. `sudo docker compose up -d --build caddy`
3. `sudo docker compose ps`
4. 浏览器 / PWA 强制刷新

## 备份与恢复要点

`bridge-data` 保存频道、设备授权和加密载荷，是必须备份的运行数据。建议在低峰期先停止 Bridge，再备份命名卷：

```bash
mkdir -p backups
docker compose stop bridge
docker run --rm \
  -v codey-handover_bridge-data:/data:ro \
  -v "$(pwd)/backups:/backup" \
  busybox sh -c 'tar czf /backup/bridge-data-$(date +%F).tgz -C /data .'
docker compose start bridge
```

不要执行 `docker compose down -v`，其中的 `-v` 会删除 Bridge 数据卷和 Caddy 的证书卷。备份文件也应按敏感数据妥善保存。

## 安全边界

- TLS 由 Caddy 对外终止；容器间的 Bridge 流量只留在 Docker 内部网络。
- Bridge 容器以非 root 用户运行，并移除 Linux capabilities；数据卷初始化容器只负责设置目录权限后退出。
- 当前 Bridge API 的 CORS 响应为 `*`，所以 Handover 与 Bridge 分域部署可以直接工作；实际访问授权仍由频道/设备凭据控制。若以后面向更多不受信任网页，建议将 Bridge 改为可配置的 CORS allowlist。
- 部署级别没有管理后台。VPS SSH、云账号、DNS 账号和备份文件是主要高价值入口，均应启用强密码/密钥与 MFA。

## 常见问题

- **证书申请失败**：检查域名 A/AAAA 记录、80/443 安全组及是否有 Nginx/Apache 占用端口。
- **Caddy 无法启动**：执行 `docker compose logs caddy`，通常是 `.env` 未填写或域名格式不正确。
- **Handover 无法配对**：Bridge 地址必须填写 `https://bridge.example.com`，不要加路径或端口。
- **需要使用 Cloudflare**：可先关闭代理（仅 DNS）完成首轮验证；启用代理后，应将 Cloudflare 到源站的 SSL/TLS 模式设为 `Full (strict)`。