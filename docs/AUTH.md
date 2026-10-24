# 邀请制授权（AUTH）

测试实例只对受邀用户开放。这里记录**它怎么实现、怎么运维、哪里是它的边界** ——
下次改这块代码之前先读完，尤其是「为什么不用 session 中间件」和「存储为什么是文件」。

---

## 1. 一句话模型

```
邀请码（管理员发） → 注册 / 登录 → 服务端签发 cookie → 每个 API 入口 requireUser
```

三类凭据，三种处理方式：

| 凭据 | 存什么 | 为什么 |
| --- | --- | --- |
| 用户密码 | `scrypt$N=16384,r=8,p=1$<salt>$<hash>` | 低熵、人输入的，必须慢哈希 + 每用户独立 salt |
| 会话 token | `sha256(token)` | 本来就是 256 位随机，慢哈希无收益；但库里不能留能直接用的值 |
| 邀请码 | `sha256(code)` | 同上。明文只在生成时返回一次 |
| 审计里的 IP | `sha256("probe-ip:" + ip)[:16]` | 够判断「是不是同一个人」，又不必长期明文存访客地址 |

**库里没有任何可逆加密**：拿到 `store.json` 的人不能直接登录，也不能复制出一枚能用的会话 cookie。

---

## 2. 代码结构

```
src/lib/auth/
  crypto.ts   密码/令牌/地址的哈希、密码策略、用户名规范化   —— 全站唯一实现
  store.ts    store.json 的读写（串行化 + 原子落盘）、用户/邀请/会话/审计的增删改查
  session.ts  cookie 的签发与解析（名字、Path、Ttl、Secure 判定）
  guard.ts    闸门：requireUser / requireAdmin / requirePageUser / requirePageAdmin
src/app/api/auth/
  login  logout  signup  me  password
src/app/api/admin/
  users  invites  audit
src/app/
  login/  signup/  account/  admin/
src/components/
  AuthPanels.tsx   LoginPanel / SignupPanel / ChangePasswordPanel
  AdminConsole.tsx 用户 / 邀请码 / 审计 三个页签
  SessionBar.tsx   右下角身份条（谁登录着、退出、进后台）
scripts/auth-cli.mjs  命令行运维（服务起不来时的最后一条路）
```

---

## 3. 两个刻意的设计决定

### 3.1 不用 middleware / proxy.ts 做鉴权

Next 16 的 `proxy.ts` 跑在受限 runtime 里，而授权数据要 `node:fs`。更重要的是：
**API 路由才是安全边界**。页面上的 `redirect` 只是体验 —— 真正拦住未授权访问的，
是每个 route 开头那一次 `requireUser(request)`。

这样做的代价：新加一个 API 路由时，你必须自己记得加 `requireUser`。
所以 `docs/SECURITY.md` 把它列成了一条检查项，`tests/auth.test.ts` 也不覆盖这类遗漏 ——
只能靠 review。反过来说，漏了页面不会漏数据：数据全走 API。

### 3.2 存储是 JSON 文件，不是数据库

测试服务器，用户几十到几百，写热点只有「登录」和「管理员点按钮」。为它引 SQLite 还要处理
Turbopack 对 `node:sqlite` 的打包行为，复杂度大于收益。但「用文件」不等于「随便写」：

- 所有读改写过同一个 Promise 队列（`serialize`），两个管理员同时点保存不会互相覆盖；
- 落盘是 `tmp + rename`（同分区原子），写一半断电不会留下半个 JSON；
- 文件 `0600`、目录 `0700`；
- **解析失败直接抛 `store_corrupt`，绝不回退成空库** —— 空库会让 bootstrap 重新种管理员，
  用户会以为自己的账号被删光了，而实际只是少了一个逗号。

多进程部署（`next start` 开多个 worker）会让这套串行化失效。当前部署是单进程，
要横向扩的时候先把存储换成数据库。

---

## 4. 首次启动

**方式 A：环境变量种一个管理员（推荐）**

```bash
PROBE_ADMIN_USER=admin
PROBE_ADMIN_PASSWORD='换成至少 10 位、且不含 admin 的密码'
npm start
```

只在 **库为空** 时生效，已有用户则完全忽略 —— 不会覆盖你后来改的密码。
种出来的管理员 `mustChangePassword=true`，首次登录会被引导到 `/account` 改密。

**方式 B：命令行**

```bash
npm run auth -- create-admin admin        # 不给 --password 就随机生成并打印一次
```

---

## 5. 发号与开户

登录后台 `/admin`（只有 `role=admin` 能进）：

1. **邀请码页签** → 填备注 / 可用次数 / 有效小时（≤0 = 永久）→ 生成。
   明文码**只显示这一次**，刷新就没了（库里只有 SHA-256）。
2. 把码发给对方，他去 `/signup` 填码 + 用户名 + 密码。
3. 邀请码边输边验（`GET /api/auth/signup?code=`），显示「可用 · 角色 · 还剩 N 次」。

两阶段是有意的：`checkInvite` 只验证不记账，用户**建成功之后**才 `commitInviteUse`。
反过来的话，一次建号失败（重名、密码不合规）就白吃掉一个名额。

也可以直接建号（用户页签「＋添加用户」），初始密码自动生成、只显示一次。

命令行等价：

```bash
npm run auth -- invite --uses 3 --hours 72 --note 测试组
npm run auth -- add-user test-01          # 随机密码，打印一次
npm run auth -- passwd test-01            # 重置密码并踢掉他所有会话
npm run auth -- disable test-01           # 停用 + 撤销会话
npm run auth -- list                      # 用户 / 邀请码 / 会话一览
npm run auth -- rm-user test-01
```

---

## 6. 会话

- cookie 名 `probe_session`，`HttpOnly` + `SameSite=Lax` + `Path=<PROBE_BASE_PATH>`；
- `Secure` 何时加：`PROBE_ENABLE_HSTS=1` **或** 请求带 `x-forwarded-proto: https`。
  反代终止 TLS 时 `request.url` 是 `http`，光看它会把所有 cookie 判成不安全；
- 有效期 `PROBE_SESSION_TTL_HOURS` 默认 168（7 天），上限一年；
- `lastSeenAt` 滑动更新，但**进程内 5 分钟去重**，不然每个请求都要写一次盘；
- 退出 = 服务端撤销那条会话 + 清 cookie。只清 cookie 等于没退（token 还能用）；
- 停用用户 / 改密码时，该用户**全部**会话立即撤销。改密码后当前设备会被重新签发一枚，
  否则用户改完密码就把自己踢出去了（`src/app/api/auth/password/route.ts` 里的顺序很关键）。

---

## 7. 防滥用

| 端点 | 每 IP 每分钟 | 变量 |
| --- | --- | --- |
| `/api/auth/login` | 5 | `PROBE_LOGIN_RATE_PER_MIN` |
| `/api/auth/signup` | 3 | `PROBE_SIGNUP_RATE_PER_MIN` |
| `/api/auth/password` | 5 | `PROBE_PASSWORD_RATE_PER_MIN` |
| `/api/admin/*` | 60 | `PROBE_ADMIN_RATE_PER_MIN` |

另外三条细节：

- **登录时用户不存在也跑一次 scrypt**（用缓存的假哈希）。不这么做，响应时间会泄露
  「这个用户名存在」，撞库的人可以先枚举账号再集中爆破。
- 登录失败文案统一「用户名或密码不正确」，不区分「没这个人」和「密码错」。
- 用户名规范化（小写、`^[a-z0-9][a-z0-9._-]{2,31}$`）在建号 / 登录 / 邀请码三处共用同一份实现，
  避免「Alice」和「alice」变成两个账号。

**最后一个可用管理员不能被降级 / 停用 / 删除**（`last_admin`）。否则一次误点就把自己锁在
后台门外，而且没有任何界面能救回来 —— 只能上命令行。

---

## 8. 运维

### 备份

```bash
cp -a .data/auth/store.json  /backup/store-$(date +%F).json
```

只有这一个文件要备份。里面有密码哈希、会话哈希、邀请码哈希、审计日志 ——
按敏感数据处理（别丢进公开的网盘）。

### 坏了怎么办

`store_corrupt` 的报错长这样：

```
授权数据文件解析失败：/srv/probe/.data/auth/store.json。请先备份并人工修复（格式见 docs/AUTH.md）。
```

此时的正确顺序：

1. **先备份**那份坏文件（`cp store.json store.broken.json`）；
2. 用 `node -e 'JSON.parse(require("fs").readFileSync(".data/auth/store.json","utf8"))'` 定位语法错；
3. 修好或换回上一份备份；
4. 确认能读：`npm run auth -- list`；
5. 再重启服务。

**不要**用「删掉文件让它重建」这个办法：重建出来的是一个空库，所有人的账号都没了。

### 文件结构

```jsonc
{
  "version": 1,
  "users": [{
    "id": "uuid", "username": "alice", "role": "member", "status": "active",
    "passwordHash": "scrypt$N=16384,r=8,p=1$...$...",
    "createdAt": 0, "createdBy": "cli", "updatedAt": 0, "lastLoginAt": null,
    "mustChangePassword": false, "note": "", "inviteId": null,
    "usage": { "day": "2026-10-24", "calls": 0 }
  }],
  "invites": [{ "id", "codeHash", "note", "role", "maxUses", "uses",
                "expiresAt": null, "createdAt", "createdBy", "revoked", "usedBy": [] }],
  "sessions": [{ "id", "tokenHash", "userId", "createdAt", "expiresAt",
                 "lastSeenAt", "ipHash", "userAgent", "revoked" }],
  "audit": [{ "at", "actor", "action", "target", "detail" }]
}
```

审计最多保留 2000 条，写盘时顺手裁掉最老的。会话在写盘时清掉已过期的。

### 手工救人（后台进不去时）

```bash
npm run auth -- create-admin rescue        # 新开一个管理员，密码打印一次
npm run auth -- enable someone             # 或把被停用的管理员启用回来
```

这两条命令不检查「是谁在跑」—— 能登服务器的人本来就有这个权限，
给脚本加一层管理员登录只是假安全。

---

## 9. 关掉鉴权

```bash
PROBE_AUTH_MODE=off
```

退回开放状态：页面不重定向、API 不校验、`/api/auth/me` 返回 `auth:false`、
右下角的身份条自动隐藏。**只在本地调试时用**，测试实例对外时必须开着。

---

## 10. 已知边界（读到这里别惊讶）

- **没有密码找回**。忘了密码找管理员重置（后台「重置密码」或 `npm run auth -- passwd`）。
  没做邮件是因为测试实例没有可靠发信通道 —— 假装做了反而更危险。
- **没有二次验证**。邀请制 + 强密码 + 限流的组合对「几十个测试用户」够用，
  对外正式开放前该补。
- **限流在进程内存里**：重启清零，多进程不共享。写进 nginx 的 `limit_req` 才是硬的那一道。
- **审计只记管理动作与登录**，不是全量访问日志（全量在 nginx 里）。
- **`usage.calls` 是近似的**：每 5 秒合并落盘一次，别拿它当计费依据。
- **store.json 无加密**：它是 0600 的明文 JSON，谁有 shell 谁就能改。
  这跟「有 root 就能改数据库」是一个层级的信任假设。

---

## 11. 加新端点时的检查清单

1. `export const runtime = "nodejs"` —— 授权存储要 `node:fs`；
2. 第一行 `isCrossSite(request)` → 403；
3. 需要登录 → `const auth = await requireUser(request); if (!auth.ok) return auth.response;`
   （**放在限流之前**：没登录的请求不该占用机器额度）；
4. 需要管理员 → 用 `requireAdmin`；
5. 读 body 用 `readJsonBody(request, MAX)`，别自己 `await request.json()`；
6. 错误文案走 `publicMessage(err, "...")`，细节只进日志；
7. 加进 `tests/auth.test.ts` 或新的测试文件 —— 至少覆盖「没 cookie 时 401」。
