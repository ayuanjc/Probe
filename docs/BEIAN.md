# 备案合规手册（腾讯云 · 广东）

> 目标：让 `ayuanjc.online` 在腾讯云成功提交 ICP 备案，并在通过后不掉进「已备案但被抽查驳回」的坑。
> 本文只写**能照着敲的命令**和**要交的材料**，不重复腾讯云控制台的点选流程。

服务器现状（2026-10-25 实测）：

| 项 | 值 |
| --- | --- |
| 公网 IP | `106.52.116.164`（腾讯云广州，2C4G / 5Mbps） |
| 系统 | Debian 12，nginx 1.22，未装 certbot |
| 80 端口 | 站点 `/etc/nginx/sites-enabled/yunying`（**带 default_server**），根目录 `/opt/yunying/web` |
| 探针 | `/probe` → `127.0.0.1:3215`（Next.js，`basePath=/probe`） |
| 443 端口 | **未监听** |
| 域名 | `ayuanjc.online` 已 A 记录指向该 IP |
| 模型 | DeepSeek `deepseek-flash`（`api.deepseek.com/v1`，境内处理） |

---

## 一、先修三个必被驳回的问题

备案审核会做两件事：查主体材料，以及**探测 80 端口**。以下三点是实测出来的硬伤：

### 1. 未匹配 Host 也返回 200

```bash
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Host: not-my-domain.example' http://106.52.116.164/
# 现在：200 8442   ← 任意 Host 都能拿到首页
```

原因是 `yunying` 站点带了 `default_server`。在审核口径里，这等于「域名没备案，服务却已经对外提供」，
与「首次备案不得开通网站」直接冲突。**必须改成：不认识的 Host 一律 444。**

### 2. 裸 IP 直接可访问

同上，`http://106.52.116.164/` 返回 200。裸 IP 访问同样要求整改 —— 备案只针对域名，
裸 IP 上跑着可访问的站点，审核员看到的是「未备案的互联网信息服务」。

### 3. 443 未监听

这不是驳回项，但备案通过后必须补。HTTPS 缺失会让「网站无法访问」类抽查直接失败，
而且登录 Cookie 的 `Secure` 属性只有在 HTTPS 下才生效（`src/lib/auth/session.ts` 里按
`x-forwarded-proto` 判断）。

---

## 二、阶段 A：备案提交期间（现在就该切）

> 原则：**提交前把 80 关掉，只留 444。** 443 不要开。
> 腾讯云会阻断未备案域名的 80 访问并跳转到提示页，那是他们的动作，不是你整改好了。
> 自己先 444，核查时「该域名未提供任何服务」是干净状态。

```bash
sudo mkdir -p /etc/nginx/backup
sudo cp /etc/nginx/sites-enabled/yunying /etc/nginx/backup/yunying.$(date +%F)

sudo tee /etc/nginx/sites-available/yunying >/dev/null <<'NGINX'
# 备案期间：任何请求都不提供服务，直接断连（444 不发响应头，比 403 更彻底）
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

# 域名命中也不放行：首次备案期间该域名不得开通网站
server {
    listen 80;
    server_name ayuanjc.online www.ayuanjc.online;
    return 444;
}
NGINX

sudo ln -sf /etc/nginx/sites-available/yunying /etc/nginx/sites-enabled/yunying
# 备份目录千万别留在 sites-enabled 里，否则 nginx 会把备份也读进去
sudo nginx -t && sudo systemctl reload nginx
```

### 自测（三条都必须是这个结果）

```bash
# 1) 任意 Host → 空响应（curl 报 52 empty reply）
curl -sv -H 'Host: not-my-domain.example' http://106.52.116.164/ 2>&1 | tail -3

# 2) 域名 → 同样空响应
curl -sv http://ayuanjc.online/ 2>&1 | tail -3

# 3) 裸 IP → 同样空响应
curl -sv http://106.52.116.164/ 2>&1 | tail -3

# 4) nginx 仍然健康（本地回环能连上就说明进程没崩）
sudo systemctl is-active nginx
sudo ss -lntp | grep ':80'
```

预期：前三条都返回 `Empty reply from server`（curl exit code 52），`nginx` 是 `active`。

**此时域名解析可以先留着**（备案期间解析不影响，影响的是「能否访问」）。
如果腾讯云客服要求关闭解析，去 DNSPod 把 A 记录暂停即可，通过后再恢复。

---

## 三、阶段 B：备案通过后（放开白名单）

> 原则：**只认自己的域名，其余 444。** 不要为了省事把 `default_server` 留在业务站点上。

```bash
sudo tee /etc/nginx/sites-available/yunying >/dev/null <<'NGINX'
# 未匹配的 Host：一律断连（裸 IP、扫描器、别人的域名都走这里）
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}

server {
    listen 80;
    server_name ayuanjc.online www.ayuanjc.online;

    # 备案号展示位在页脚（src/components/SiteFooter.tsx），这里不用管
    client_max_body_size 1m;
    server_tokens off;

    # 探针本体：Next.js 挂在子路径，SSE 流式输出不能缓冲
    location /probe {
        proxy_pass http://127.0.0.1:3215;      # 注意：proxy_pass 后面不要带 URI
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
NGINX

sudo nginx -t && sudo systemctl reload nginx
```

### 自测

```bash
# 域名：应为 200 / 302，且 HTML 里的 <title> 是「探针 · Probe」
curl -s -o /dev/null -w '%{http_code}\n' http://ayuanjc.online/probe
curl -s http://ayuanjc.online/probe | grep -o '<title>[^<]*</title>'

# 伪造 Host：应为空响应
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' http://106.52.116.164/
# ↑ 期望 curl 直接报错（exit 52），而不是打印 200

# 页脚是否真的挂了备案号（通过后才会由 env 注入）
curl -s http://ayuanjc.online/probe | grep -o '粤ICP备[0-9]*号-[0-9]*'
```

---

## 四、阶段 C：HTTPS（备案通过后同一天做）

```bash
sudo apt update && sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ayuanjc.online -d www.ayuanjc.online --redirect
sudo systemctl list-timers | grep certbot     # 自动续期应已就绪
```

certbot 会自动把 80 的 `server` 改成 301 → https，并新增 443 的 `server`。
**改完要手动确认它没有破坏两件事**：

1. **444 兜底还在**（certbot 有时会给 default_server 补一个 443 server_block）：

```bash
sudo grep -n 'default_server\|return 444' /etc/nginx/sites-enabled/yunying
curl -s -o /dev/null -w '%{http_code}\n' -k -H 'Host: evil.example' https://106.52.116.164/   # 期望 curl 报错
```

2. **反向代理的 X-Forwarded-Proto 还是 $scheme**（否则 Cookie 不会带 Secure）：

```bash
sudo grep -n 'X-Forwarded-Proto' /etc/nginx/sites-enabled/yunying
curl -sI https://ayuanjc.online/probe/api/auth/me | grep -i 'set-cookie'   # 应含 Secure
```

启用 HSTS（确认全站 HTTPS 之后再打开，写进 `.env.local` 后要重启服务）：

```bash
echo 'PROBE_ENABLE_HSTS=1' | sudo tee -a /opt/probe/.env.local
sudo systemctl restart probe-web.service
```

---

## 五、提交备案：材料清单

先自查这四条，缺一条就不要点提交（一个主体同时只能有一单在审，驳回要重排队）：

- [ ] **域名实名认证已完成满 3 天**（新注册/新过户的域名，实名信息入库工信部需约 3 天，早提交拉不到域名）
- [ ] **域名后缀是国家批复的**（`.online`：在腾讯云备案控制台「域名」输入框里能自动拉出该域名 = 可备；拉不出就是不行，得换 `.com`/`.cn`）
- [ ] **域名注册商在境内**（境外注册商必须先转入腾讯云/阿里云等，转入通常 5–7 天）
- [ ] **云资源**：本实例 `106.52.116.164` 剩余有效期 ≥ 3 个月；用它的**备案服务码/授权码**提交

主体信息一致性（最常见的驳回原因）：

| 字段 | 必须等于 |
| --- | --- |
| 主办单位/个人姓名 | 域名所有者的实名姓名 |
| 证件类型 + 证件号 | 域名实名认证时填的那一份 |
| 手机号 | 能接收工信部短信的那个号（提交后 24 小时内必须核验，超时订单作废） |
| 网站名称 | **「探针」**（不要写「探针 · Probe」以外的变体；页面上 `<title>` 与备案表要对得上） |

网站服务内容选「其他」或「科技信息类」，不要选「新闻」「出版」「教育」等需要前置审批的类别 ——
本站是检索与整理工具，选了前置审批类目要么补许可证，要么驳回。

时间线（广东）：

| 环节 | 时长 |
| --- | --- |
| 腾讯云初审 | 1–2 个工作日（会被电话核验，保持手机畅通） |
| 工信部短信核验 | **提交后 24 小时内**，超时订单作废 |
| 广东管局审核 | 8–15 个工作日（法定上限 20） |

---

## 六、备案通过后 30 天内：公安联网备案

1. 打开 <https://www.beian.gov.cn>，注册账号 → 「联网备案」→ 新办网站备案。
2. 填入 ICP 备案号、网站域名、服务器 IP（腾讯云）、接入商（深圳市腾讯计算机系统有限公司）。
3. 审核通过后拿到「粤公网安备 XXXXXXXXXXXXXX 号」，把数字填进 `PROBE_POLICE_LICENSE`。
4. 页脚会自动把它链到 `beian.mps.gov.cn/#/query/webSearch?code=数字`。

> 30 日内未办，会被责令限期改正；这是最常见的「备案通过了但依然不合规」的地方。

---

## 七、页脚与法律页的配置

备案号不是硬编码，走环境变量（`.env.example` 已列出）：

```bash
# /opt/probe/.env.local
PROBE_ICP_LICENSE=粤ICP备12345678号-1
PROBE_POLICE_LICENSE=粤公网安备44030502008569号
PROBE_OPERATOR_NAME=张三
PROBE_CONTACT_EMAIL=you@example.com
```

改完重启：

```bash
sudo systemctl restart probe-web.service
curl -s http://127.0.0.1:3215/probe | grep -o '粤ICP备[0-9]*号-[0-9]*'
```

代码侧对应关系：

| 文件 | 作用 |
| --- | --- |
| `src/components/SiteFooter.tsx` | 页脚：备案号 + 工信部链接 + 公安备案链接 + 隐私/协议入口 + AI 生成声明 |
| `src/app/privacy/page.tsx` | 隐私政策（数据流向、出境、留存期限、权利行使） |
| `src/app/terms/page.tsx` | 用户协议（邀请制账号、AI 内容边界、禁止行为、责任限制） |
| `src/components/AiNotice.tsx` | 摘要区的「AI 生成」显著标识（办法第 12 条） |

---

## 八、切到 DeepSeek（境内模型）

> 为什么必须切：调用境外模型为公众生成内容，等于**以境外模型在境内提供生成式 AI 服务**，
> 同时查询词随请求出境。换到境内已备案模型后，这两条同时消失。
> 这一步只动环境变量，不动代码 —— `src/lib/llm.ts` 早已按「OpenAI 兼容 + chat/completions」写，
> `generateObject` 被上游拒掉 `json_schema` 时会自动退回「纯文本 JSON + zod 校验」。

### 1. 拿 key

到 <https://platform.deepseek.com/api_keys> 创建，形如 `sk-…`。
充值不必多，5 元够测很久（`deepseek-flash` 档极便宜）。

### 2. 写进服务器 .env.local

```bash
sudo -u probe tee -a /opt/probe/.env.local >/dev/null <<'ENV'
OPENAI_API_KEY=sk-你的DeepSeekKey
OPENAI_BASE_URL=https://api.deepseek.com/v1
PROBE_MODEL=deepseek-flash
ENV

sudo chmod 600 /opt/probe/.env.local      # 里面有 key，别留 644
sudo chown probe:probe /opt/probe/.env.local
sudo systemctl restart probe-web.service
```

> 用户名与路径按实际部署改（DEPLOY.md 里是 `probe-web.service` + `/opt/probe`）。
> **`PROBE_MODEL` 不能省**：省了就用默认的 `gpt-6-luna`，DeepSeek 会返回
> `model not found`（400），表现为摘要空白、面板正常 —— 很容易被当成「换供应商失败了」。

### 3. 验证真的在用 DeepSeek

```bash
# a) 进程里能看到变量（值会被 systemd 显示出来，确认没写错）
sudo systemctl show probe-web.service -p Environment | tr ' ' '\n' | grep -E 'OPENAI_BASE_URL|PROBE_MODEL'

# b) 直接打一发，确认 key 与模型名都对（不经过本站）
curl -s https://api.deepseek.com/v1/chat/completions \
  -H "Authorization: Bearer $DEEPSEEK_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"只回复两个字：可用"}],"max_tokens":16}' \
  | head -c 400

# c) 走本站，看摘要有没有字（响应是 SSE，取前几帧即可）
curl -sN -X POST http://127.0.0.1:3215/probe/api/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"DeepSeek 是什么"}' | head -c 600

# d) 日志里不该再出现 openai 相关的 401 / unsupported_country
sudo journalctl -u probe-web.service -n 80 --no-pager | grep -iE 'llm|401|403|country'
```

预期：c) 能看到 `text-delta` 逐字吐中文；d) 至多出现**一行**
`上游不支持 response_format=json_schema，改用纯文本 JSON 兜底`
—— 那是正常的一次性自适应，同进程内之后不再出现。如果每次请求都打这一行，
说明上游报文的表述超出了识别范围，去看 `tests/llm-compat.test.ts` 补一条用例再放宽
`rejectsJsonSchema`。

### 4. 面板是否还在

结构化调用（面板规划、断言抽取）走的是另一条路：先试 `json_schema`，
被拒后改「纯文本输出 + 抠 JSON + zod 校验」。所以验证时**要同时看摘要和面板**：

- 摘要空、面板正常 → 流式这条路有问题（多半是 key/模型名）。
- 摘要正常、面板空 → 结构化那条路在降级后仍失败（多半是模型没按要求只输出 JSON，
  可先把 `PROBE_MODEL` 换成同厂的更强档试一次）。

### 5. 切完之后

- 隐私政策第三节已按「按访问区域分流」重写（详见第十一节），不需要再改文案。
- `.env.example` 里的默认值已指向 DeepSeek，新部署不用再手工改。
- 检索层的出境路径已经在代码里闸住了：境内请求拿不到 Tavily 的 key（`resolvedTavilyKey()`
  在 `region=cn` 时返回 `undefined`），境内走博查。剩下的事只有一件——**配 BOCHA_API_KEY**，
  没配就是「境内无可用检索源 → 退回本地样本」，不会偷偷改走境外。
- **模型备案 ≠ 你的服务备案**。`deepseek-flash` 已按《生成式人工智能服务管理暂行办法》
  完成备案，那是深度求索的义务；你作为「使用方」把它接进自己的产品，只要不对公众开放注册、
  没有舆论属性或社会动员能力，一般无需再做生成式 AI 服务备案。一旦开放注册或提供内容分发，
  需另行做算法备案与安全评估 —— 邀请制在这里是实打实的减负项，别随手关掉。

---

## 九、上线前检查清单

- [ ] 任意 Host、裸 IP、未备案域名 → 全部 444（`curl -H 'Host: x' ` 报 empty reply）
- [ ] `https://ayuanjc.online` 可访问，HTTP 301 到 HTTPS
- [ ] 页脚能看到 ICP 号，点击跳 `beian.miit.gov.cn`
- [ ] `/privacy` 与 `/terms` 可访问，页脚能互相跳转
- [ ] 摘要区右上角有蓝色「AI 生成」角标
- [ ] 登录 Cookie 在 HTTPS 下带 `Secure`
- [ ] 访问日志留存 ≥ 6 个月（`/etc/logrotate.d/nginx` 里 `rotate` 与 `monthly/weekly` 组合要够 180 天）
- [ ] `OPENAI_BASE_URL=https://api.deepseek.com/v1`、`PROBE_MODEL=deepseek-flash` 已生效，
      `journalctl -u probe-web.service | grep -i llm` 里没有 401 / 403
- [ ] 公安联网备案已提交（通过后 30 日内）

---

## 十、几个容易踩的点

1. **腾讯云的未备案阻断页不是你的页面**。看到「该网站未备案」的提示不代表配置生效了，
   那是腾讯云在 80 上做的拦截。以自己 `curl` 的结果为准。
2. **备份文件不要放 `sites-enabled/`**。nginx 会把目录里所有文件都 include 进去，
   一份 `yunying.bak` 就能让 444 规则失效。
3. **`proxy_pass` 后面带 URI 会吃掉 `/probe` 前缀**，Next.js 的 `basePath` 就对不上，
   表现为 404 循环。保持 `proxy_pass http://127.0.0.1:3215;` 不带路径。
4. **SSE 必须 `proxy_buffering off`**，否则流式输出会攒到最后一次性吐出（表现像卡死）。
5. **换域名要重新备案**。`www` 与裸域是同一个网站的两种写法，可以一起提交；
   换成完全不同的域名 = 新增网站备案，不能复用这一单。

---

## 十一、区域分流：一次部署，两套服务商

代码层已经按「访问者所在区域」分流（`src/lib/region.ts` + `src/lib/region-policy.ts`）：

| 区域 | 模型 | 检索源 |
| --- | --- | --- |
| `cn`（境内） | 只允许白名单内的境内端点（DeepSeek / Kimi / GLM / 百炼 / 硅基流动 / 火山 / 千帆 / MiniMax / 百川 / 阶跃 / 零一 / 混元 / 讯飞） | 只有博查 `api.bochaai.com` |
| `intl`（境外） | 不限（默认 OpenAI 官方） | Tavily / GDELT / Wikipedia / HN / 博查 |

判定顺序（先命中先返回）：`PROBE_REGION_MODE` → 请求头国家码 → 来访 IP 反查 → `PROBE_DEFAULT_REGION`。
**兜底是 `cn`**，因为判错的代价不对称：把境内用户判成境外 = 数据已经发出去了，收不回来；
把境外用户判成境内 = 少几个检索源，可恢复。

### 1. 生产环境让"国家码"真的能拿到

现在 nginx 没有注入国家头，判定会落到「IP 反查」这一步。两条路选一条：

**A. 用腾讯云 CDN / EdgeOne（推荐）**：在控制台开「IP 归属地」后再透传，nginx 里保留头：

```nginx
# 腾讯云 EO 给的国家码头（大小写不敏感，代码读 eo-client-ipcountry）
proxy_set_header eo-client-ipcountry $http_eo_client_ipcountry;
```

**B. nginx 自带 GeoIP2 模块 —— 线上就是这么做的（2026-10-25 落地）**
Debian 12 的 `nginx` 包**不带** geoip2，装模块就行；数据库用 DB-IP Lite，
**不需要注册账号**（MaxMind GeoLite2 要账号，能用但不必要）：

```bash
apt-get install -y libnginx-mod-http-geoip2                 # 装完 modules-enabled/ 自动多一个 50-mod-http-geoip2.conf
mkdir -p /etc/nginx/geoip
# 每月一份，换月份就能续：dbip-country-lite-YYYY-MM.mmdb.gz
curl -fsSL https://download.db-ip.com/free/dbip-country-lite-2026-10.mmdb.gz \
  -o /tmp/dbip.mmdb.gz
gunzip -c /tmp/dbip.mmdb.gz > /etc/nginx/geoip/dbip-country-lite.mmdb   # 8.0 MB
```

```nginx
# /etc/nginx/nginx.conf 的 http{} 里（顶层，"http {" 之后）
# 加了下面那 8 条清头之后默认 512 的哈希放不下，nginx -t 会 warn，一起调大
proxy_headers_hash_max_size 2048;
proxy_headers_hash_bucket_size 128;

geoip2 /etc/nginx/geoip/dbip-country-lite.mmdb {
    auto_reload 30d;
    $geoip2_data_country_code country iso_code;
}
```

然后在 `location /probe` 里**先清掉客户端自带的头，再注入自己算出来的**（顺序有意义）：

```nginx
proxy_set_header x-probe-region "";
proxy_set_header x-probe-country "";
proxy_set_header eo-client-ipcountry "";
proxy_set_header cf-ipcountry "";
proxy_set_header x-vercel-ip-country "";
proxy_set_header x-country-code "";
proxy_set_header x-geo-country "";
proxy_set_header x-real-ip-country "";
# 真实来源国：本机按来访 IP 查库得出，替掉上面那行「清空」
proxy_set_header x-probe-country $geoip2_data_country_code;
```

> **这 8 条清头不是洁癖，是补一个实测出来的洞。** 2026-10-25 上线区域分流后，
> `curl -H 'x-probe-country: SG' https://…/probe/api/region` 直接返回
> `region:intl / modelHost:api.openai.com` —— 境内访客发一句话就能给自己开出境通道。
> 加上清头之后，同样的请求返回 `region:cn / source:header / country:CN`（跟着真实 IP 走），
> `x-probe-region`、`cf-ipcountry`、`x-country-code` 一起试过，全部无效。

> **库本身的验证**（不经过站点，直接看变量）：临时开一个只监听 127.0.0.1 的 server
> 配 `set_real_ip_from 127.0.0.1; real_ip_header X-Forwarded-For;` 再 `return 200 "$geoip2_data_country_code"`，
> 实测 `8.8.8.8→US`、`1.1.1.1→AU`、`202.96.128.86→CN`、`133.242.0.1→JP`，
> 而 TEST-NET 段（`203.0.113.9`）返回空 —— 空值正好落回兜底 `cn`。验证完记得删掉那个临时 server。

> 代码优先读 `x-probe-region`，其次才是一串国家码头（`eo-client-ipcountry`、`cf-ipcountry`、
> `x-vercel-ip-country`、`x-country-code`、`x-geo-country`、`x-real-ip-country`、`x-probe-country`）。
> 所以上面两种做法都不用改代码。

**别把客户端的头直接透传**：`x-probe-country` 必须是 nginx 自己算出来的（`$geoip2_data_country_code`），
不能 `proxy_set_header x-probe-country $http_x_probe_country;` —— 那是把闸门的钥匙交给访客。
同理，IP 反查依赖 `X-Forwarded-For`，`PROBE_TRUSTED_PROXY_HOPS` 必须等于真实代理层数（本机 nginx = 1），
设成 0 会让所有请求退化成 `direct`，一律按兜底区域处理。

**反过来的坑（很容易踩）**：如果哪天为了图快，把 `next start` 直接暴露在 80 端口、前面没有 nginx，
而 `PROBE_TRUSTED_PROXY_HOPS` 还是默认的 1 —— 那么访客自己发的 `X-Forwarded-For: 8.8.8.8`
会被当成真实地址，他的属地会被判成境外，于是**境内访客给自己开了出境通道**。实测过：
这种配置下 `curl -H 'X-Forwarded-For: 8.8.8.8' -H 'x-probe-country: US' /api/region`
返回 `region: intl / country: US`。要么始终保留 nginx（推荐），要么把 hops 设成 0。

### 2. 境内这一路要配的变量

```bash
# /opt/probe/.env.local
PROBE_CN_MODEL_KEY=sk-...                      # DeepSeek 的 key（与 OPENAI_API_KEY 分开）
PROBE_CN_MODEL_BASE_URL=https://api.deepseek.com/v1
PROBE_CN_MODEL_ID=deepseek-flash

BOCHA_API_KEY=sk-...                           # 博查 web-search
# 可选：境内还想加别的检索源（逗号分隔，目前只有 bocha 有实现）
PROBE_REGION_CN_RETRIEVAL=bocha
```

**没有 `PROBE_CN_MODEL_KEY` 会怎样**：境内的模型调用直接 `blocked`（不会拿 OpenAI 的 key 去撞 DeepSeek
换一个神秘 401），降级文案是 `region:model_blocked:api.openai.com`，面板退回本地样本。
这是有意的：**宁可少功能，不可越境**。

### 3. 境外机房部署

如果以后把站迁到新加坡/香港，把 `PROBE_REGION_MODE=intl` 写死即可跳过 IP 反查；
境内访客仍会因为判定顺序（mode 优先）被当成境外 —— 那种部署下**要么别对境内开放**，
要么把 mode 留空、继续靠国家头。

### 3.1 本地开发想用境外源，但这行不许进 `.env`

开发机上没有网关头、来访地址还是内网，判定会落到兜底值 `cn` —— 检索只剩博查一条，
调面板时会看到一片 `region_blocked`。为了不被自己的闸门挡住干活，把偏好写进
`.env.development.local`：

```bash
# .env.development.local —— 只有 next dev 读，next start 不读
PROBE_REGION_MODE=intl
```

Next 的加载顺序是：dev 读 `.env.development.local` → `.env.local` → `.env.development` → `.env`；
生产（`next start`）读 `.env.production.local` → `.env.local` → `.env.production` → `.env`，
**看不到 development 系列**。所以这个文件和 `.env` 里的注释不同：`.env` 会被生产继承，
它不会。`.gitignore` 已含 `.env.*.local`，不会进仓库。

自测（不启服务，直接问 Next 自己怎么解析）：

```bash
node -e 'const{loadEnvConfig}=require("@next/env");const d=process.cwd();const q={info(){},error(){}};
delete process.env.PROBE_REGION_MODE;loadEnvConfig(d,true,q);console.log("dev  ",process.env.PROBE_REGION_MODE);
delete process.env.PROBE_REGION_MODE;loadEnvConfig(d,false,q);console.log("prod ",process.env.PROBE_REGION_MODE??null)'
# 期望 dev  intl / prod null
```

**这条容易踩**：把 `PROBE_REGION_MODE=intl` 留在 `.env` 或 `.env.local` 里，生产进程会一并继承，
境内访客被判成境外、查询词直接发去 OpenAI 与 Tavily —— 界面上还看不出异常，因为一切"正常工作"。

### 4. 验证

```bash
# 境内（伪造国家头，等价于 nginx 注入）
curl -sN -X POST http://127.0.0.1:3215/probe/api/search \
  -H 'Content-Type: application/json' -H 'x-probe-country: CN' \
  -d '{"query":"今天有什么新闻"}' | head -c 400
# 期望：degraded 里出现 region:model_switched（若配了境内端点）或 region:model_blocked；
#       检索侧出现 bocha:not_configured 或 bocha:region_blocked 之外的结果；不该出现 tavily 字样

# 境外
curl -sN -X POST http://127.0.0.1:3215/probe/api/search \
  -H 'Content-Type: application/json' -H 'x-probe-country: SG' \
  -d '{"query":"what happened today"}' | head -c 400

# 看服务端诊断（regionSummary 里有 region/source/modelHost/retrieval）
sudo journalctl -u probe-web.service -n 50 --no-pager | grep -iE 'region|llm'
```

自查清单：

- [ ] 境内请求的 `degraded` 里**永不**出现 `tavily` / `gdelt` / `hn` / `wiki`
- [ ] 境内请求拿不到 `OPENAI_API_KEY`（即使环境里配了）
- [ ] 境内配了 `PROBE_CN_MODEL_*` → 面板与摘要都有内容；没配 → 明确 blocked，不静默走境外
- [ ] 国家头是 nginx 注入的，不是客户端透传的
- [ ] `PROBE_TRUSTED_PROXY_HOPS` 与真实代理层数一致
