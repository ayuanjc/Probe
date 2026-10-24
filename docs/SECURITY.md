# 服务端安全加固说明

本站是**邀请制**的测试实例：只有拿到邀请码开户的人能用，服务端持有模型 key。
因此威胁模型分两层：**外圈**是防陌生人拿你的机器和你的账单（限流、SSRF、成本上限、
不泄露错误细节），**内圈**是防拿到账号的人做越权的事（会话、角色、最后一个管理员保护）。
两层的细节分别在本文与 [AUTH.md](./AUTH.md)。

| 攻击面 | 不加防护的后果 |
| --- | --- |
| 入口本身 | 无邀请也能开户/调用，等于这个实例对全网开放 |
| 模型调用 | 一个循环脚本把 OpenAI 余额刷空（每次核验都要调模型） |
| 出站抓取（URL 正文代理） | 被当成 SSRF 跳板打内网、读云元数据、扫端口 |
| 请求体 / JSON | 超大 body 占满内存，深嵌套对象打爆解析 |
| 反馈落盘接口 | 写满磁盘、注入 ANSI 控制符污染运维 `tail` |
| 运维端点 | `/api/cron/heat`、`/api/metrics` 无口令即可触发/读取 |
| 凭据存储 | 密码明文或快哈希落盘，一次备份泄露 = 全员账号泄露 |
| 后台管理 | 任何登录用户都能改角色/删用户/发邀请码 |
| 错误信息 | 异常原文回显，泄露上游 URL、路径、provider 响应 |

下面每一条都对应代码里的具体改动。

---

## 一、部署前提（**不做这几步，代码层的加固会被绕过**）

0. **首次启动必须先种一个管理员**（`PROBE_ADMIN_USER` + `PROBE_ADMIN_PASSWORD`，
   或 `npm run auth -- create-admin`）。没有管理员就发不出邀请码，也就没人能开户。
   详见 [AUTH.md](./AUTH.md) 第 4 节。
1. **只能挂在 nginx 后面，或者把 `PROBE_TRUSTED_PROXY_HOPS` 设为 0。**
   限流按客户端 IP 分桶。直连暴露时客户端能自己造 `X-Forwarded-For`，
   每个请求换一个值就是一份新额度（实测：5 个不同 XFF → 5 次全过）。
   经过 nginx（`$proxy_add_x_forwarded_for` 只在**右侧**追加）时，代码从右往左取第 1 跳，
   伪造无效。**前面没有代理就必须设 0**，此时代码彻底忽略转发头，按共享额度走。
2. **设置 `HEAT_CRON_SECRET`（≥16 位随机串）。** 不设则 `/api/cron/heat` 返回 503 disabled；
   设了但短于 16 位同样按 disabled 处理（防止 `secret=1` 这种口令）。
3. **设置 `PROBE_DAILY_LLM_CALLS`（默认 2000）。** 这是服务端自己的 key 的每日调用上限，
   用尽后检索降级为纯规则、核验返回 unavailable，不会继续烧钱。**用户自带 key 不计入**。

---

## 二、修复清单

### 1. 限流：从"各路由各写一份"收敛到一处，且不可能被笔误关掉

新增 `src/lib/rate-limit.ts`：

- `readPositiveInt(name, fallback, {min?, max?})` —— 环境变量解析。历史写法
  `Number(process.env.X ?? 12)` 在 `X="abc"` 时得到 `NaN`，而
  `recent.length >= NaN` 恒为 `false`，**一个笔误等于完全不限流**。现在非法值一律回落默认值并
  `console.warn`。`abc / 0 / -3 / NaN / Infinity / 1e999` 全部有测试覆盖。
- `createLimiter({name, limit, windowMs, maxKeys})` —— 滑动窗口。键表有上限（默认 2048），
  每键的时间戳数组也被 `limit` 夹住，**内存有确定上界**，伪造海量来源刷不爆进程。
- `createGate(max)` —— 并发闸门（release 幂等，重复调用不会把计数打成负数）。

每个路由现在都是**两级限流**：per-key（正常用户之间互不影响）+ global（换 IP 继续刷也受限）。

| 路由 | per-key/分钟 | 全局/分钟 | 并发 | body 上限 |
| --- | --- | --- | --- | --- |
| `/api/search` | 3（`PROBE_RATE_LIMIT_PER_MIN`） | 60 | 4 | 8 KB |
| `/api/verify` | 2（`PROBE_VERIFY_RATE_PER_MIN`） | 12 | 2 | 400 KB |
| `/api/module` | 12 | 120 | 3 | 128 KB |
| `/api/translate` | 20 | 120 | 4 | 96 KB |
| `/api/dossier` | 20 | 240 | — | 256 KB |
| `/api/feedback` | 5 | — | — | 32 KB（落盘 8 MB） |
| `/api/metrics` | 60 | — | — | — |
| `/api/cron/heat` | 10 | — | — | — |

被拒时统一返回 `429` + `Retry-After: <秒>` + `{"ok":false,"code":"rate_limited",...}`。

### 2. 来源识别与跨站判定

新增 `src/lib/request-guard.ts`：

- `clientKey(request)` —— 默认从 `X-Forwarded-For` **右起第 1 项**取（真实 IP 在最右），
  回落 `X-Real-IP`，再回落共享键 `"direct"`。取值走白名单字符集并截断 64 字符，
  脏 header 既撑不大键表也塞不进日志。
  **取不到就共享额度，而不是伪造一个独立键** —— 后者等于送攻击者免费额度。
- `isCrossSite(request)` —— `Sec-Fetch-Site: cross-site` 直接拒；有 `Origin` 时与 `Host` 比对；
  `Origin: null`（沙箱 iframe / `file://`）也算跨站。命中返回 403。
  这道闸挡住"借别人的浏览器打你的额度 / 借别人的会话改数据"（CSRF），但它**不是鉴权**：
  鉴权在每个路由的 `requireUser` / `requireAdmin` 里，见下面第 9 条。
- `readJsonBody(request, maxBytes)` —— 流式读，边读边累加，超限立刻 `cancel()` 断开，
  不把超大 body 读进内存。有 `Content-Length` 时先按头拒绝。
- `constantTimeEqual(a, b)` —— SHA-256 后 `timingSafeEqual`，长度不同也不提前返回，
  用于 `cron` secret 与 `metrics` key 的比较。
- `publicMessage(err, fallback)` —— 异常细节只进 `console.warn`，响应里只给固定文案，
  dev 环境才带原文。
- `stripControlChars(s)` —— 剥掉 C0/C1 与 ANSI 转义，防止有人在反馈里塞
  `\x1b[2J` 把运维终端刷白。

### 3. SSRF 与 DNS rebinding

`src/lib/http.ts`：

- 原来的写法是「先 `dns.lookup` 判断是不是私网，再让 `fetch` 自己解析一遍」——
  两次解析之间域名可以变（TOCTOU），攻击者用 0-TTL 的域名就能把 `fetch` 引到 `127.0.0.1`。
  现在 `resolveAllowed(hostname)` 缓存 5 分钟，并把**校验通过的那个 IP 直接钉给 socket**
  （`pinnedLookup` 作为 `lookup` 选项），校验和连接用同一个地址。
- 新增端口白名单 `PROBE_FETCH_ALLOWED_PORTS`（默认 `80,443`）：不再允许把
  `http://内网:6379` 当成"文章地址"去抓。
- 解压炸弹：`decodeBody` 的 `maxOutputLength: 4_000_000`，超限按空正文处理，
  一个 10 KB 的 gzip 展开成 10 GB 不会再打死进程。
- **用户自填的模型接口地址**（设置面板 / `OPENAI_BASE_URL`，见 `cleanBaseUrl`）走另一条
  出站路径，规则从紧：只接受 `http(s)` 绝对 URL、长度 12–300、不允许空白，只保留
  scheme + host + path（query / fragment / userinfo 全部丢弃），并且 `169.254.169.254`、
  `metadata.google.internal`、`metadata` 直接当没填。**注意这是"防止误配成跳板"，不是
  "允许用户把请求打到任意主机"** —— 用户本来就能把自己的 key 和自己想要的地址发给服务端，
  服务端替他发出去；所以这里不做私网拦截（否则本地 Ollama 就用不了），
  真正的风险边界是「服务端没有额外的高权限凭据可借」。

### 4. 模型成本控制

`src/lib/llm.ts`：

- 每日调用预算（`PROBE_DAILY_LLM_CALLS`，默认 2000）。`takeBudget()` 只在
  `keySource() === "env"` 时计数 —— 用户自己填的 key 花自己的钱，不该被服务端预算卡。
- 预算耗尽后 `llmEnabled()` 为 false：检索退回规则引擎，核验在流里插一条
  「今日模型调用额度已用完」的说明。**降级是显式的**，不会静默给出半成品结果。

### 5. 反馈落盘

`src/app/api/feedback/route.ts` 整文件重写：

- 目录 `0o700`、文件 `0o600` 创建；单文件超 `PROBE_FEEDBACK_MAX_BYTES`（默认 8 MB）返回 503。
- 所有字段过 `stripControlChars` + 长度截断。

### 6. 运维端点

- `/api/cron/heat`：`HEAT_CRON_SECRET` 未配置或短于 16 位 → 503 disabled；
  `Authorization: Bearer` 与 `?secret=` 都走常量时间比较；尝试次数限流 10/分钟。
- `/api/metrics`：匿名只能看聚合数字；`?key=` 命中才展开 `runs` 里的 query 明细。

### 7. 响应头（`next.config.ts`）

`poweredByHeader: false` + 全站 `/:path*`：

```
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(),
  serial=(), midi=(), display-capture=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Permitted-Cross-Domain-Policies: none
```

`PROBE_ENABLE_HSTS=1` 时才追加 `Strict-Transport-Security`（默认不加：本机 http 调试会被
浏览器永久钉成 https）。

**取舍**：`script-src` 保留了 `'unsafe-inline'`。Next 的 RSC 载荷是内联 `<script>`，
改 nonce 要动整条渲染链（layout、streaming、dev overlay 全要跟着改），收益不抵风险。
去掉 `'unsafe-eval'` 已经挡住了 `eval`/`new Function` 与外部脚本加载，剩下的内联脚本
全部由 Next 自己生成、内容不来自用户输入。`connect-src`/`img-src` 能收到 `'self'`
是因为已核对：前端所有 `fetch`/`EventSource` 都走 `appPath()`（同源），没有远程图片。

### 8. 原型污染

`/api/module` 解析用户提交的方案数据时跳过 `__proto__ / prototype / constructor`
三类键（`cleanRow` 与 `cleanDatasets` 的 id 都过），避免 `{ "__proto__": { "x": 1 } }`
改动 `Object.prototype`。

### 9. 邀请制授权（会话 / 密码 / 邀请码）

细节在 [AUTH.md](./AUTH.md)，这里只记「为什么这么做」和边界。新增 `src/lib/auth/`：

- **三类凭据三种哈希**：用户密码 `scrypt(N=16384,r=8,p=1)` + 每用户独立 salt；
  会话 token 与邀请码是 256 位随机量，用 SHA-256（慢哈希对它们没有收益）；
  审计里的 IP 存 `sha256("probe-ip:"+ip)[:16]`。**库里没有任何可逆加密** ——
  拿到 `store.json` 的人不能直接登录，也复制不出一枚能用的 cookie。
- **闸门在 API，不在页面**。Next 16 的 `proxy.ts` 跑在受限 runtime（要 `node:fs` 过不去），
  页面上的 `redirect` 只是体验。真正的边界是每个 route 开头那一次 `requireUser(request)`。
  代价：**新加路由必须自己记得加**，这是本文唯一「靠 review 兜住」的项。
- **登录不泄露账号是否存在**：用户不存在时也跑一次 scrypt（缓存的假哈希），
  ＋统一文案「用户名或密码不正确」＋端点限流 5/分钟。
- **会话可服务端撤销**：退出、停用用户、改密码都会 `revokeUserSessions`。
  只清 cookie 等于没退（token 在有效期内仍能用）。改密码后会给当前设备重新签发一枚，
  否则用户改完密码把自己踢出去。
- **最后一个可用管理员不能被降级 / 停用 / 删除**（`last_admin`）。一次误点就把自己锁在
  后台门外，界面上没有任何补救入口（只能上 `npm run auth`）。
- **存储解析失败即 `store_corrupt`，绝不回退空库**：回退空库会让 bootstrap 重新种管理员，
  用户会以为账号被删光了，实际只是少了一个逗号。处置顺序见 AUTH.md 第 8 节。
- cookie：`probe_session`，`HttpOnly` + `SameSite=Lax` + `Path=<PROBE_BASE_PATH>`；
  `Secure` 看 `PROBE_ENABLE_HSTS=1` 或 `x-forwarded-proto: https`（反代终止 TLS 时
  `request.url` 是 http，只看它会把所有 cookie 判成不安全）。

---

## 三、nginx 加固（配合上面的代码层）

在 `docs/DEPLOY.md` 的 `location /probe` 里追加：

```nginx
# 单 IP 每秒 5 个请求、burst 20；这里是廉价的第一道闸，
# 应用层还会按"分钟"再限一次（两级不冲突）
limit_req zone=probe_rl burst=20 nodelay;
limit_req_status 429;

# 和路由里的 body 上限对齐，别让 400MB 的包先进到 Node 进程
client_max_body_size 1m;
client_body_buffer_size 128k;
```

`http {}` 层需要先定义 zone：

```nginx
limit_req_zone $binary_remote_addr zone=probe_rl:10m rate=5r/s;
```

**务必确认 `location /probe` 里保留了**：

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

少了这两行，所有请求都会落进共享的 `"direct"` 桶，一次刷爆就全员 429。

---

## 四、冒烟验证（已在本地实测通过）

```bash
B=http://127.0.0.1:3215/probe

# 1) 安全头齐了、没有 X-Powered-By
curl -sD- -o /dev/null $B/ | tr -d '\r' | grep -iE 'content-security-policy|permissions-policy|x-powered-by'

# 2) 超大 body -> 413
python3 -c 'print("{\"query\":\"" + "a"*20000 + "\"}")' > /tmp/big.json
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/search \
  -H 'content-type: application/json' --data-binary @/tmp/big.json     # 413

# 3) 非法 JSON -> 400，且不回显原文
curl -s -X POST $B/api/search -H 'content-type: application/json' --data-binary '{oops'
# {"ok":false,"code":"bad_json","message":"请求体不是合法 JSON。"}

# 4) 跨站 -> 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST $B/api/translate \
  -H 'content-type: application/json' -H 'sec-fetch-site: cross-site' \
  -H 'origin: https://evil.example' --data-binary '{"text":"hi","target":"zh"}'

# 5) 限流：/api/verify 限 2/分钟，第 3 次应 429
for i in 1 2 3 4; do curl -s -o /dev/null -w '%{http_code} ' -X POST $B/api/verify \
  -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.99' --data-binary '{"url":"https://example.com/a"}'; done

# 6) cron 没配 secret -> 503 disabled
curl -s -o /dev/null -w '%{http_code}\n' $B/api/cron/heat

# 7) metrics 匿名不泄露 query 明细
curl -s $B/api/metrics | head -c 200
```

实测输出（本地 `npm start`，直连 3311）：

```
# 2) 413        # 3) {"ok":false,"code":"bad_json",...}   # 4) 403
# 5) 200 200 429 429      # 6) 503      # 7) redaction.redacted=true
```

---

## 五、自动化测试

`tests/security.test.ts` 与 `tests/auth.test.ts`（`npm test`，共 167 个用例全绿）覆盖上面每一层。
下面是安全层的部分，授权层（scrypt 参数上限、脏哈希、`last_admin`、邀请码两阶段、会话撤销、`store_corrupt`、CLI 哈希互认）见 `tests/auth.test.ts`：

- `readPositiveInt` 的六种非法值全部回落默认值（`NaN` 静默关限流的回归测试）
- 限流窗口刷新、键表 `maxKeys` 上限（灌 5000 个键后 `size() <= 32`）
- 并发闸门 `acquire`/`release` 幂等
- `clientKey`：XFF 右起取值、`hops=2`、`hops=0` 忽略转发头、`X-Real-IP` 回落、
  脏 header 截断到 64 字符
- `isCrossSite`：`cross-site` / 同源 / 异源 `Origin` / `Origin: null` / 无信号
- `readJsonBody`：正常 JSON、50 KB body 撞 1 KB 上限得 413、坏 JSON 不回显原文
- `constantTimeEqual`：空值、长度不同、内容不同全部 false
- `isPrivateAddress`：`127.0.0.1`、`::1`、`::ffff:127.0.0.1`、`169.254.169.254`、
  `fe80::1`、`fd00::1`、`0.0.0.0` 全部拦截；公网 IPv4/IPv6 放行
- `portAllowed`：默认只有 80/443 放行

---

## 六、已知取舍 / 这件事没做

- **限流状态在进程内存里**。单实例（当前部署形态）没问题；将来多实例/多核 cluster，
  每个实例各有一份计数，实际额度是 N 倍。到那一步要换成 Redis 或用 nginx 的
  `limit_req` 承担按 IP 的那一级。
- **鉴权是"邀请制"，不是"企业级 IAM"**：没有找回密码（找管理员重置）、没有 2FA、
  没有细粒度权限（只有 admin / member 两种角色）。对几十个测试用户够用，
  对外正式开放前该补。详见 [AUTH.md](./AUTH.md) 第 10 节。
- **止损的最后一道仍然在 OpenAI 控制台**：`PROBE_DAILY_LLM_CALLS` 只限制服务端 key 的
  调用次数，**建议同时给这个 key 设一个硬性月限额** —— 代码层的预算算错了，账单不会骗人。
- **`script-src` 仍有 `'unsafe-inline'`**（见上文取舍）。
- **`PROBE_DAILY_TOKEN_BUDGET` 是历史遗留变量**，代码里没人读，改它没有任何效果；
  生效的是 `PROBE_DAILY_LLM_CALLS`。
