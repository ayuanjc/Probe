# 部署：预览站 runbook

一台机器上同时跑两个项目，80 端口归原来的项目。预览站不抢端口、不抢域名，
只用 nginx 的一个 `location /probe`。

## 拓扑

```
公网 :80  nginx（站点 /etc/nginx/sites-enabled/yunying，default_server）
  ├─ location /       → /opt/yunying/web（原有项目）
  ├─ location /api/   → 127.0.0.1:8100（原有项目 uvicorn）
  └─ location /probe  → 127.0.0.1:3215（本项目，basePath=/probe，proxy_buffering off）

systemd probe-web.service    next start -H 127.0.0.1 -p 3215（Restart=always, MemoryMax=1200M）
systemd probe-update.timer   每 5 分钟 → probe-update.service → /opt/probe/update.sh
systemd probe-heat.timer     每 30 分钟 → probe-heat.service → /opt/probe/heat-cron.sh
```

## 落盘路径

| 路径 | 内容 |
| --- | --- |
| `/opt/node` | Node v22（官方 tarball 解压，没走 apt） |
| `/opt/probe/app` | 源码 + `node_modules` + `.next`（构建产物） |
| `/opt/probe/probe.env` | 运行时环境变量（systemd `EnvironmentFile`） |
| `/opt/probe/deployed-sha` | 线上是哪个 commit（`update.sh` 写，`git` 不在场） |
| `/opt/probe/update.sh` | 自动更新脚本 |
| `/opt/probe/stage` | 解压临时目录（更新完即删） |
| `/opt/probe/heat-cron.sh` | 带着口令打一次 `/api/cron/heat`（失败重试 3 次） |
| `/var/log/probe-update.log` | 更新日志（含构建输出） |
| `/var/log/probe-heat.log` | 热榜 Cron 日志（每行 `日期 try=N http=CODE BODY`） |
| `/opt/probe/app/.cache/feedback.jsonl` | 页脚反馈，一行一条（`.cache` 不在自动更新的覆盖范围内） |

## 环境变量（`/opt/probe/probe.env`）

```
PROBE_BASE_PATH=/probe              # 构建与运行时都要，否则路由注册成 / 而不是 /probe
NEXT_PUBLIC_PROBE_BASE_PATH=/probe  # 打进前端的 basePath，客户端 fetch 靠它
PROBE_RATE_LIMIT_PER_MIN=20         # 每 IP 检索限流，默认 3 对预览来说太低
PROBE_TRANSLATE_RATE_LIMIT_PER_MIN=40
PROBE_MODULE_RATE_LIMIT_PER_MIN=20
PROBE_CRON_SECRET=<32 位 hex>       # 热榜定时任务的钥匙；不配 /api/cron/heat 直接 503
# OPENAI_API_KEY=               # 接上就换成模型摘要，字段名见 .env.example
```

`NEXT_PUBLIC_*` 会被编译进前端 bundle：**改了必须重新构建**，只 restart 不生效。
其余变量在 `next start` 时读取，改完 `systemctl restart probe-web` 就够。

## 更新一次会发生什么

`/opt/probe/update.sh`（`flock` 防重入）：

1. `GET https://api.github.com/repos/ayuanjc/Probe/commits/main` → `sha`；与 `deployed-sha` 相同就直接退出（安静）。
2. `GET https://codeload.github.com/ayuanjc/Probe/tar.gz/<sha>` → 解压到 `/opt/probe/stage/new`。
3. `tar` 管道覆盖源码（排除 `node_modules` / `.next`），`package-lock.json` 变了才 `npm ci`。
4. `PROBE_DIST_DIR=.next-staging npx next build`；**构建失败就删掉 staging，线上继续跑旧版本**。
5. `mv .next .next-old && mv .next-staging .next` → `systemctl restart probe-web`。
6. `curl /probe/api/version` 自检：通了写 `deployed-sha`、删 `.next-old`；不通就换回 `.next-old` 再重启。

为什么不用 `git pull`：这台机器到 `github.com` 的 TLS 会被打断（`GnuTLS recv error (-110)`），
`git clone` / `git fetch` 从没成功过；`api.github.com` 与 `codeload.github.com` 正常。

`/api/version` 同时给两个编号：`version`（来自 `package.json`，人改）与 `buildId`（每次构建变）。
更新横幅只比 `buildId` —— 用它判断「你这一页是不是最新构建」；`version` 只是给人看的。

更新那几十秒里进程不可用。还开着页面的浏览器靠 `/api/version` 的构建号比对得知「有新版本」，
问不到就 10 秒后重试一次（否则轮询撞上重启窗口就要多等一分钟）。这条横幅只提示、不自动刷新 ——
用户可能正读到摘要一半。

## 常用操作

```bash
cat /opt/probe/deployed-sha                     # 线上 commit
systemctl start probe-update.service            # 立刻更新一次
tail -f /var/log/probe-update.log               # 看进度（含 next build 输出）
systemctl status probe-web --no-pager -l
journalctl -u probe-web -n 100 --no-pager
curl -s http://127.0.0.1:3215/probe/api/version # 本机直连，绕过 nginx
systemctl list-timers probe-update.timer --no-pager
tail -n 5 /opt/probe/app/.cache/feedback.jsonl   # 最近的反馈
systemctl start probe-heat.service              # 立刻算一次热榜（约 3~19 秒）
tail -n 5 /var/log/probe-heat.log
systemctl list-timers probe-heat.timer --no-pager
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3215/probe/api/cron/heat  # 期望 401
```

### 回滚到上一个构建

`update.sh` 成功后会把 `.next-old` 删掉，所以**没有保留上一版**。需要回滚时用 sha 重跑：

```bash
echo <旧的完整 sha> > /opt/probe/deployed-sha   # 让脚本认为"线上是旧的"
# 但脚本只会往新的走，所以要手工装一版：
curl -fsSL https://codeload.github.com/ayuanjc/Probe/tar.gz/<old-sha> -o /tmp/p.tgz
mkdir -p /tmp/old && tar xzf /tmp/p.tgz -C /tmp/old --strip-components=1
cd /tmp/old && PROBE_BASE_PATH=/probe NEXT_PUBLIC_PROBE_BASE_PATH=/probe PROBE_DIST_DIR=.next npx next build
# 用 tar 覆盖 /opt/probe/app（保留 node_modules），再 systemctl restart probe-web
```

真要"一键回滚"的话，把 `.next-old` 保留一轮（下一段更新时才删）即可 —— 现在没做，因为预览站出问题时
直接 `git revert` + 5 分钟自动更新更快，也更不容易把磁盘塞满。

## nginx 片段（在 `server {}` 里）

```nginx
location /probe {
    proxy_pass http://127.0.0.1:3215;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;      # SSE：不关缓冲，事件会被攒成一坨再吐
    proxy_cache off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

`proxy_pass` 后面**不要**带 URI（不要写 `proxy_pass http://127.0.0.1:3215/;`）：
带了会把 `/probe` 前缀剥掉，而 Next 的 basePath 正等着这个前缀。

## 踩过的坑

- **备份文件不能留在 `sites-enabled/`**：`yunying.bak` 也会被 include，两个 `default_server` 让 `nginx -t` 直接失败。备份放 `/root/nginx-backup/`。
- **`/probe/` 会 308 到 `/probe`**：Next 的 basePath 规范化行为，浏览器跟一跳就对了，不要试图在 nginx 里改写。
- **MSYS / Git Bash 会把 `PROBE_BASE_PATH=/probe` 当路径改写成 `C:/Users/...`**：本机构建带 basePath 时用 pwsh 设环境变量，别用 bash。
- **npm registry**：这台机器到 `registry.npmjs.org` 要 14 秒，`registry.npmmirror.com` 1.7 秒。`npm config set registry https://registry.npmmirror.com` 之后 `npm ci` 15 秒装完。
- **热榜 Cron 偶发 `topics:0`**：同一条 HN 请求一次通、一次 `aborted due to timeout`。端点里已给抓取一次重试（800ms 后），失败快照只缓存 60 秒。看到日志里 `hn:failed` 先确认是不是单次抖动，不用急着查服务。
- **别把 `curl` 直接管道给 `grep -m1`**：`update.sh` 里那样写会让 curl 收 SIGPIPE 报 `curl: (23) Failure writing output to destination` 并退出非零。先 `-o` 落文件再 grep。